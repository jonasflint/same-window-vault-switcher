import {
	App,
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TextFileView,
} from "obsidian";

/*
 * Same Window Vault Switcher
 *
 * How Obsidian (desktop, 1.15.x) handles vaults internally:
 *   - The main process keeps a private map  vaultId -> BrowserWindow.
 *   - A window learns which vault it shows by calling  ipcRenderer.sendSync("vault"),
 *     answered from that map.
 *   - The vault switcher calls  ipcRenderer.sendSync("vault-open", path, false),
 *     which opens (or focuses) a separate window for that vault.
 *   - Obsidian enables @electron/remote for vault windows, so a plugin can reach
 *     main-process objects.
 *
 * Two modes:
 *   "handoff" (default): let Obsidian open the vault normally, place the new
 *     window exactly where this one is before it becomes visible, then close this
 *     window. Obsidian's internal state stays 100% consistent.
 *   "swap" (experimental): install a small main-process hook that answers the
 *     "vault" IPC with a different vault for THIS window, then reload it. Same
 *     native window, but Obsidian's private vault->window map still points the
 *     old vault at this window (see the README for side effects).
 */

type Mode = "handoff" | "swap";

interface Settings {
	enabled: boolean;
	mode: Mode;
	closeDelayMs: number;
	debugLog: string;
}

const DEFAULT_SETTINGS: Settings = {
	enabled: true,
	mode: "handoff",
	closeDelayMs: 120,
	debugLog: "",
};

interface VaultEntry {
	id: string;
	path: string;
	ts?: number;
	open?: boolean;
}

type SendSync = (channel: string, ...args: unknown[]) => unknown;

/* eslint-disable @typescript-eslint/no-explicit-any */
const electron = (): any => (window as any).electron;
const remote = (): any => electron()?.remote;
const ipc = (): { sendSync: SendSync } | null => electron()?.ipcRenderer ?? null;

function norm(p: string): string {
	return p.replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * Code that runs inside Obsidian's MAIN process (via @electron/remote + vm).
 * It persists across renderer reloads, which is what makes the in-place swap
 * possible. All functions take/return primitives (JSON strings) so nothing
 * crosses the remote boundary by reference.
 */
const MAIN_PROCESS_CODE = String.raw`(function () {
	const G = globalThis;
	const KEY = "__sameWindowVaultSwitcher";
	if (G[KEY] && G[KEY].api && G[KEY].api.version === 2) return G[KEY].api;

	const req = process.mainModule.require.bind(process.mainModule);
	const { ipcMain, BrowserWindow, app, webContents } = req("electron");
	const fs = req("fs");
	const path = req("path");

	const prev = G[KEY];
	const st = G[KEY] = prev ? Object.assign(prev, { api: null }) : { overrides: {}, watched: {}, quitting: false, hooked: false, origVault: null, origList: null, api: null, logFile: null };
	if (!st.logFile) st.logFile = null;

	function log(msg) {
		if (!st.logFile) return;
		try { fs.appendFileSync(st.logFile, new Date().toISOString() + " [main] " + msg + "\n"); } catch (e) {}
	}
	function installDiagnostics() {
		if (st.diag) return;
		st.diag = true;
		app.on("before-quit", () => log("app before-quit\n" + new Error("quit caller").stack));
		app.on("will-quit", () => log("app will-quit"));
		app.on("child-process-gone", (_e, d) => log("child-process-gone " + JSON.stringify(d)));
		app.on("render-process-gone", (_e, wc, d) => log("render-process-gone wc=" + (wc && wc.id) + " " + JSON.stringify(d)));
		app.on("window-all-closed", () => log("window-all-closed"));
		process.on("exit", (code) => log("process exit code=" + code));
		process.on("uncaughtException", (err) => log("uncaughtException " + (err && err.stack)));
	}

	function hook() {
		if (st.hooked) return;
		const vl = ipcMain.listeners("vault");
		const ll = ipcMain.listeners("vault-list");
		if (vl.length !== 1 || ll.length < 1) {
			throw new Error("Unexpected Obsidian internals (vault listeners: " + vl.length + ", vault-list listeners: " + ll.length + ")");
		}
		st.origVault = vl[0];
		st.origList = ll[0];
		const wrapper = function (e) {
			const o = e && e.sender && st.overrides[e.sender.id];
			if (o) { log("vault (swapped) wc=" + e.sender.id + " -> " + o.id); e.returnValue = { id: o.id, path: o.path }; return; }
			return st.origVault.apply(this, arguments);
		};
		ipcMain.removeListener("vault", st.origVault);
		ipcMain.on("vault", wrapper);

		// Obsidian 1.15+: per-window startup info and startup snapshots are keyed
		// by the window's *real* vault. For swapped windows, hide those so the
		// window doesn't boot with the old vault's snapshot/colors or overwrite
		// the old vault's snapshot with this vault's layout.
		const sl = ipcMain.listeners("startup");
		if (sl.length === 1) {
			const origStartup = sl[0];
			ipcMain.removeListener("startup", origStartup);
			ipcMain.on("startup", function (e) {
				const o = e && e.sender && st.overrides[e.sender.id];
				if (!o) return origStartup.apply(this, arguments);
				const ev = { sender: e.sender };
				try { origStartup(ev); } catch (err) {}
				const info = ev.returnValue || null;
				log("startup (swapped) wc=" + e.sender.id + " -> " + o.id);
				e.returnValue = info ? { id: o.id, zoom: info.zoom } : null;
			});
		}
		const ssl = ipcMain.listeners("startup-snapshot-save");
		if (ssl.length === 1) {
			const origSave = ssl[0];
			ipcMain.removeListener("startup-snapshot-save", origSave);
			ipcMain.on("startup-snapshot-save", function (e) {
				if (e && e.sender && st.overrides[e.sender.id]) return;
				return origSave.apply(this, arguments);
			});
		}
		const handlers = ipcMain._invokeHandlers;
		if (handlers && typeof handlers.get === "function" && handlers.has("startup-snapshot")) {
			const origSnap = handlers.get("startup-snapshot");
			ipcMain.removeHandler("startup-snapshot");
			ipcMain.handle("startup-snapshot", function (e) {
				if (e && e.sender && st.overrides[e.sender.id]) return null;
				return origSnap.apply(this, arguments);
			});
		}
		app.on("before-quit", () => { st.quitting = true; });
		app.on("activate", () => { st.quitting = false; });
		st.hooked = true;
	}

	function vaults() { const ev = {}; st.origList(ev); return ev.returnValue || {}; }
	function realVault(wc) { const ev = { sender: wc }; st.origVault(ev); return ev.returnValue || {}; }
	function effective(wc) { return st.overrides[wc.id] || realVault(wc); }
	function isRoot(w) {
		try { return !w.isDestroyed() && !w.getParentWindow() && !w.webContents.opener; } catch (e) { return false; }
	}
	function showing(id, excludeWcId) {
		for (const w of BrowserWindow.getAllWindows()) {
			if (!isRoot(w) || w.webContents.id === excludeWcId) continue;
			try { if (effective(w.webContents).id === id) return w; } catch (e) {}
		}
		return null;
	}
	function save() {
		try {
			const file = path.join(app.getPath("userData"), "obsidian.json");
			const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
			const R = vaults();
			// Only write if this is clearly the same vault registry Obsidian uses.
			if (!cfg.vaults || Object.keys(cfg.vaults).sort().join() !== Object.keys(R).sort().join()) return false;
			cfg.vaults = R;
			fs.writeFileSync(file, JSON.stringify(cfg));
			return true;
		} catch (e) { return false; }
	}
	// Make "open" flags (used to reopen vaults on launch) match what windows actually show.
	function reconcile(excludeWcId) {
		const R = vaults();
		const shown = new Set();
		for (const w of BrowserWindow.getAllWindows()) {
			if (!isRoot(w) || w.webContents.id === excludeWcId) continue;
			try { const v = effective(w.webContents); if (v && v.id) shown.add(v.id); } catch (e) {}
		}
		for (const id in R) { if (shown.has(id)) R[id].open = true; else delete R[id].open; }
		log("reconcile shown=" + JSON.stringify([...shown]) + " saved=" + save());
	}
	function watch(win, wcId) {
		if (st.watched[wcId]) return;
		st.watched[wcId] = true;
		win.once("closed", () => {
			log("closed wc=" + wcId);
			delete st.overrides[wcId];
			delete st.watched[wcId];
			if (!st.quitting) reconcile(wcId);
		});
	}

	installDiagnostics();

	const api = {
		version: 2,
		setLog(file) { st.logFile = file || null; log("log started, pid=" + process.pid + " electron=" + process.versions.electron); return "ok"; },
		log(msg) { log(String(msg)); return "ok"; },
		install() { hook(); return "ok"; },
		vaultsJson() { hook(); return JSON.stringify(vaults()); },
		currentJson(wcId) { hook(); const wc = webContents.fromId(wcId); return JSON.stringify(wc ? effective(wc) : {}); },
		findShowing(vaultId, excludeWcId) { hook(); const w = showing(vaultId, excludeWcId); return w ? w.id : -1; },
		anyOverrides() { return Object.keys(st.overrides).length > 0; },
		swap(wcId, targetId) {
			hook();
			const wc = webContents.fromId(wcId);
			if (!wc) return JSON.stringify({ ok: false, error: "Window not found" });
			const win = BrowserWindow.fromWebContents(wc);
			const R = vaults();
			const t = R[targetId];
			if (!t) return JSON.stringify({ ok: false, error: "Vault not found" });
			const real = realVault(wc);
			log("swap wc=" + wcId + " real=" + real.id + " target=" + targetId + " " + t.path);
			if (real.id === targetId) delete st.overrides[wcId];
			else st.overrides[wcId] = { id: targetId, path: path.resolve(t.path) };
			t.ts = Date.now();
			reconcile(-1);
			if (win) watch(win, wcId);
			log("swap ok, overrides=" + JSON.stringify(st.overrides));
			return JSON.stringify({ ok: true });
		},
	};
	st.api = api;
	return api;
})()`;

export default class SameWindowVaultSwitcher extends Plugin {
	settings: Settings = DEFAULT_SETTINGS;
	private origSendSync: SendSync | null = null;
	private origClose: (() => void) | null = null;
	private switching = false;
	private mainApi: any = null;

	async onload() {
		if (!Platform.isDesktopApp) return;
		await this.loadSettings();
		this.patch();

		this.addCommand({
			id: "switch-vault-same-window",
			name: "Switch vault in this window",
			callback: () => new VaultPickerModal(this.app, this).open(),
		});

		this.addSettingTab(new SettingsTab(this.app, this));

		if (this.settings.debugLog) {
			try {
				this.getMainApi();
				this.dlog(`plugin loaded in vault ${this.currentVaultPath()} (mode=${this.settings.mode})`);
			} catch (e) {
				console.error(e);
			}
		}
	}

	onunload() {
		const r = ipc();
		if (r && this.origSendSync) r.sendSync = this.origSendSync;
		if (this.origClose) window.close = this.origClose;
		this.origSendSync = null;
		this.origClose = null;
	}

	// ---------------------------------------------------------------- patches

	private patch() {
		const r = ipc();
		if (!r || this.origSendSync) return;
		const original = r.sendSync;
		this.origSendSync = original;
		const plugin = this;

		r.sendSync = function (channel: string, ...args: unknown[]) {
			if (channel === "vault-open" && plugin.settings.enabled && !plugin.switching) {
				const [target, create] = args;
				if (typeof target === "string") {
					return plugin.switchTo(target, !!create);
				}
			}
			return original.call(this, channel, ...args);
		};

		// Obsidian's "Open another vault" modal calls window.close() right after a
		// successful vault-open. Hold that off while we're mid-switch so we control
		// exactly when this window goes away (or, in swap mode, that it doesn't).
		this.origClose = window.close;
		window.close = function () {
			if (plugin.switching) return;
			plugin.origClose?.call(window);
		};
	}

	private send(channel: string, ...args: unknown[]): unknown {
		const r = ipc();
		if (!r) return undefined;
		return (this.origSendSync ?? r.sendSync).call(r, channel, ...args);
	}

	private closeSelf() {
		(this.origClose ?? window.close).call(window);
	}

	// ---------------------------------------------------------------- main api

	private getMainApi(): any {
		if (this.mainApi) return this.mainApi;
		const rm = remote();
		if (!rm) throw new Error("@electron/remote is not available");
		const vm = rm.require("vm");
		const api = vm.runInThisContext(MAIN_PROCESS_CODE);
		if (!api) throw new Error("Main-process hook failed to load");
		if (this.settings.debugLog) api.setLog(this.settings.debugLog);
		if (api.install() !== "ok") throw new Error("Main-process hook failed to install");
		this.mainApi = api;
		return api;
	}

	/** Main api only if the hook is already installed (never installs it). */
	private existingMainApi(): any {
		if (this.mainApi) return this.mainApi;
		try {
			const g = remote()?.getGlobal("__sameWindowVaultSwitcher");
			if (g && g.api) return this.getMainApi();
		} catch (e) {
			/* ignore */
		}
		return null;
	}

	// ---------------------------------------------------------------- helpers

	currentVaultPath(): string | null {
		const a = this.app.vault.adapter;
		return a instanceof FileSystemAdapter ? a.getBasePath() : null;
	}

	listVaults(): VaultEntry[] {
		const raw = this.send("vault-list") as Record<string, Omit<VaultEntry, "id">> | undefined;
		if (!raw) return [];
		return Object.entries(raw)
			.map(([id, v]) => ({ id, ...v }))
			.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
	}

	private isCurrent(path: string): boolean {
		const cur = this.currentVaultPath();
		return !!cur && norm(cur) === norm(path);
	}

	private geometry() {
		const w = remote().getCurrentWindow();
		const max = w.isMaximized();
		const full = w.isFullScreen();
		return { max, full, bounds: max || full ? w.getNormalBounds() : w.getBounds() };
	}

	/** Put another window exactly where this one is, then close this one. */
	private takeOver(target: any, geom: ReturnType<SameWindowVaultSwitcher["geometry"]>, waitForShow: boolean) {
		try {
			target.setBounds(geom.bounds);
		} catch (e) {
			/* ignore */
		}

		const finish = () => {
			try {
				if (geom.full) target.setFullScreen(true);
				else {
					if (!geom.max && target.isMaximized()) target.unmaximize();
					target.setBounds(geom.bounds);
					if (geom.max && !target.isMaximized()) target.maximize();
				}
				target.focus();
			} catch (e) {
				/* ignore */
			}
			window.setTimeout(() => this.closeSelf(), this.settings.closeDelayMs);
		};

		if (!waitForShow) return finish();

		const started = Date.now();
		const timer = window.setInterval(() => {
			let visible = false;
			try {
				visible = target.isDestroyed() || target.isVisible();
			} catch (e) {
				visible = true;
			}
			if (visible || Date.now() - started > 8000) {
				window.clearInterval(timer);
				finish();
			}
		}, 25);
	}

	// ---------------------------------------------------------------- switching

	/** Entry point for both the hooked built-in switcher and our command. Returns what vault-open would. */
	switchTo(path: string, create = false): unknown {
		if (!create && this.isCurrent(path)) return true;

		let useSwap = this.settings.mode === "swap" && !create;
		if (!useSwap && !create) {
			// If any window has been swapped, Obsidian's own vault-open may focus the
			// wrong window. In that case always go through the swap path.
			try {
				const api = this.existingMainApi();
				if (api && api.anyOverrides()) useSwap = true;
			} catch (e) {
				/* fall through to handoff */
			}
		}

		if (useSwap) {
			try {
				return this.swap(path);
			} catch (e) {
				console.error("[same-window-vault-switcher] swap failed, falling back to handoff", e);
				new Notice("In-place swap unavailable, using handoff instead. See console.");
			}
		}
		return this.handoff(path, create);
	}

	private handoff(path: string, create: boolean): unknown {
		const rm = remote();
		if (!rm) {
			// No remote: plain behaviour + close this window.
			// No remote: can't verify anything, so behave like stock Obsidian.
			return this.send("vault-open", path, create);
		}

		const geom = this.geometry();
		const self = rm.getCurrentWindow();
		const before = new Set<number>(rm.BrowserWindow.getAllWindows().map((w: any) => w.id));

		const res = this.send("vault-open", path, create);
		if (res !== true) return res;

		this.switching = true;
		const fresh = rm.BrowserWindow.getAllWindows().find((w: any) => !before.has(w.id) && !w.isDestroyed());
		if (fresh) {
			this.takeOver(fresh, geom, true);
			return res;
		}

		// The vault was already open somewhere: Obsidian focused that window.
		let existing: any = null;
		try {
			const api = this.getMainApi();
			const list: Record<string, { path: string }> = JSON.parse(api.vaultsJson());
			const id = Object.keys(list).find((k) => norm(list[k].path) === norm(path));
			const winId = id ? api.findShowing(id, self.webContents.id) : -1;
			if (winId >= 0) existing = rm.BrowserWindow.fromId(winId);
		} catch (e) {
			/* placement is best-effort */
		}
		if (existing && existing.id !== self.id) {
			this.takeOver(existing, geom, false);
		} else {
			// Couldn't confirm another window is showing the vault: keep this one.
			this.switching = false;
			new Notice("Opened vault, but couldn't find its window, so this window was kept open.");
		}
		return res;
	}

	private swap(path: string): unknown {
		const rm = remote();
		const api = this.getMainApi();
		const self = rm.getCurrentWindow();
		const wcId: number = rm.getCurrentWebContents().id;

		const list: Record<string, { path: string }> = JSON.parse(api.vaultsJson());
		const targetId = Object.keys(list).find((k) => norm(list[k].path) === norm(path));
		// Unknown folder (not yet a registered vault): let Obsidian register it the normal way.
		if (!targetId) return this.handoff(path, false);

		// Already open in another window → bring that window here instead.
		const winId = api.findShowing(targetId, wcId);
		if (winId >= 0) {
			const other = rm.BrowserWindow.fromId(winId);
			if (other && other.id !== self.id) {
				this.switching = true;
				this.takeOver(other, this.geometry(), false);
				return true;
			}
		}

		this.switching = true;
		void this.doSwap(api, wcId, targetId);
		return true;
	}

	private dlog(msg: string) {
		console.log("[same-window-vault-switcher] " + msg);
		try {
			this.mainApi?.log("[renderer] " + msg);
		} catch (e) {
			/* ignore */
		}
	}

	private async doSwap(api: any, wcId: number, targetId: string) {
		try {
			this.dlog(`doSwap start wc=${wcId} target=${targetId}`);
			// Flush unsaved editor content and the workspace layout first.
			const saves: Promise<void>[] = [];
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.view instanceof TextFileView) saves.push(leaf.view.save());
			});
			await Promise.allSettled(saves);
			this.dlog(`saved ${saves.length} views`);
			await this.app.workspace.requestSaveLayout.run();
			this.dlog("layout saved");

			const res = JSON.parse(api.swap(wcId, targetId));
			this.dlog("swap result " + JSON.stringify(res));
			if (!res.ok) throw new Error(res.error);
			this.dlog("reloading");
			window.location.reload();
		} catch (e) {
			this.switching = false;
			this.dlog("doSwap error " + ((e as Error).stack ?? e));
			console.error("[same-window-vault-switcher]", e);
			new Notice(`Couldn't swap vault: ${(e as Error).message}`);
		}
	}

	// Settings are shared by every vault (localStorage is common to all vault
	// windows), so switching never lands in a vault with a different mode.
	private static readonly GLOBAL_KEY = "same-window-vault-switcher:settings";

	async loadSettings() {
		let global: Partial<Settings> = {};
		try {
			global = JSON.parse(localStorage.getItem(SameWindowVaultSwitcher.GLOBAL_KEY) ?? "{}");
		} catch (e) {
			/* ignore */
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData(), global);
	}

	async saveSettings() {
		try {
			localStorage.setItem(SameWindowVaultSwitcher.GLOBAL_KEY, JSON.stringify(this.settings));
		} catch (e) {
			/* ignore */
		}
		await this.saveData(this.settings);
	}
}

// -------------------------------------------------------------------- picker

class VaultPickerModal extends SuggestModal<VaultEntry> {
	constructor(app: App, private plugin: SameWindowVaultSwitcher) {
		super(app);
		this.setPlaceholder("Switch to vault…");
	}

	getSuggestions(query: string): VaultEntry[] {
		const cur = this.plugin.currentVaultPath();
		const q = query.toLowerCase();
		return this.plugin
			.listVaults()
			.filter((v) => !cur || norm(v.path) !== norm(cur))
			.filter((v) => v.path.toLowerCase().includes(q));
	}

	renderSuggestion(v: VaultEntry, el: HTMLElement) {
		el.createDiv({ text: v.path.split(/[\\/]/).pop() ?? v.path });
		el.createEl("small", { text: v.path, cls: "mod-muted" });
	}

	onChooseSuggestion(v: VaultEntry) {
		const res = this.plugin.switchTo(v.path);
		if (res !== true) new Notice(`Couldn't open vault: ${String(res)}`);
	}
}

// -------------------------------------------------------------------- settings

class SettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: SameWindowVaultSwitcher) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Use for Obsidian's vault switcher")
			.setDesc("Apply to the built-in sidebar vault menu and \"Open another vault\". The command palette command always works.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
					this.plugin.settings.enabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Mode")
			.setDesc(
				"Seamless handoff: the new vault opens exactly where this window is, then this window closes. " +
					"In-place swap (experimental): this same window reloads into the other vault; " +
					"Obsidian's own bookkeeping still ties the old vault to this window, so obsidian:// links and the CLI for the old vault may land here."
			)
			.addDropdown((d) =>
				d
					.addOption("handoff", "Seamless handoff (recommended)")
					.addOption("swap", "In-place swap (experimental)")
					.setValue(this.plugin.settings.mode)
					.onChange(async (v) => {
						this.plugin.settings.mode = v as Mode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debug log file")
			.setDesc("Absolute path of a file to write swap diagnostics to (leave empty to disable).")
			.addText((t) =>
				t.setValue(this.plugin.settings.debugLog).onChange(async (v) => {
					this.plugin.settings.debugLog = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Close delay (ms)")
			.setDesc("Handoff only: wait this long after the new window appears before closing this one.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.closeDelayMs)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.closeDelayMs = n;
						await this.plugin.saveSettings();
					}
				})
			);
	}
}
