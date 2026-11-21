import {
	App,
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	SettingDefinitionItem,
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

type VaultList = Record<string, { path: string; ts?: number; open?: boolean }>;

// ------------------------------------------------------------------ Electron types
// Minimal typings for the parts of Electron that Obsidian exposes on `window.electron`.

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface WebContentsLike {
	id: number;
}

interface BrowserWindowLike {
	id: number;
	webContents: WebContentsLike;
	isDestroyed(): boolean;
	isVisible(): boolean;
	isMaximized(): boolean;
	isFullScreen(): boolean;
	getBounds(): Rect;
	getNormalBounds(): Rect;
	setBounds(bounds: Rect): void;
	maximize(): void;
	unmaximize(): void;
	setFullScreen(flag: boolean): void;
	focus(): void;
}

interface IpcRendererLike {
	sendSync: (channel: string, ...args: unknown[]) => unknown;
}

interface VmLike {
	runInThisContext(code: string): unknown;
}

interface RemoteLike {
	getCurrentWindow(): BrowserWindowLike;
	getCurrentWebContents(): WebContentsLike;
	getGlobal(name: string): unknown;
	require(module: "vm"): VmLike;
	BrowserWindow: {
		getAllWindows(): BrowserWindowLike[];
		fromId(id: number): BrowserWindowLike | null;
	};
}

interface ElectronLike {
	ipcRenderer?: IpcRendererLike;
	remote?: RemoteLike;
}

/** The object returned by MAIN_PROCESS_CODE (lives in Obsidian's main process). */
interface MainApi {
	version: number;
	setLog(file: string): string;
	log(msg: string): string;
	install(): string;
	vaultsJson(): string;
	currentJson(wcId: number): string;
	findShowing(vaultId: string, excludeWcId: number): number;
	anyOverrides(): boolean;
	swap(wcId: number, targetId: string): string;
}

interface SwapResult {
	ok: boolean;
	error?: string;
}

type SendSync = IpcRendererLike["sendSync"];

const electron = (): ElectronLike | undefined => (window as unknown as { electron?: ElectronLike }).electron;
const remote = (): RemoteLike | undefined => electron()?.remote;
const ipc = (): IpcRendererLike | undefined => electron()?.ipcRenderer;

function requireRemote(): RemoteLike {
	const r = remote();
	if (!r) throw new Error("@electron/remote is not available");
	return r;
}

function norm(p: string): string {
	return p.replace(/[\\/]+$/, "").toLowerCase();
}

function errorText(e: unknown): string {
	return e instanceof Error ? (e.stack ?? e.message) : String(e);
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
	settings: Settings = { ...DEFAULT_SETTINGS };
	private origSendSync: SendSync | null = null;
	private origClose: (() => void) | null = null;
	private switching = false;
	private mainApi: MainApi | null = null;

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
				this.dlog(`plugin loaded in vault ${this.currentVaultPath() ?? "?"} (mode=${this.settings.mode})`);
			} catch (e) {
				console.error("[same-window-vault-switcher]", e);
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
		const originalRaw = r.sendSync;
		this.origSendSync = originalRaw;
		const original = (channel: string, ...args: unknown[]): unknown => originalRaw.call(r, channel, ...args);

		r.sendSync = (channel: string, ...args: unknown[]): unknown => {
			if (channel === "vault-open" && this.settings.enabled && !this.switching) {
				const [target, create] = args;
				if (typeof target === "string") {
					return this.switchTo(target, create === true);
				}
			}
			return original(channel, ...args);
		};

		// Obsidian's "Open another vault" modal calls window.close() right after a
		// successful vault-open. Hold that off while we're mid-switch so we control
		// exactly when this window goes away (or, in swap mode, that it doesn't).
		const origClose = window.close.bind(window);
		this.origClose = origClose;
		window.close = () => {
			if (this.switching) return;
			origClose();
		};
	}

	private send(channel: string, ...args: unknown[]): unknown {
		const r = ipc();
		if (!r) return undefined;
		return (this.origSendSync ?? r.sendSync).call(r, channel, ...args);
	}

	private closeSelf() {
		if (this.origClose) this.origClose();
		else window.close();
	}

	// ---------------------------------------------------------------- main api

	private getMainApi(): MainApi {
		if (this.mainApi) return this.mainApi;
		const vm = requireRemote().require("vm");
		const api = vm.runInThisContext(MAIN_PROCESS_CODE) as MainApi | undefined;
		if (!api) throw new Error("Main-process hook failed to load");
		if (this.settings.debugLog) api.setLog(this.settings.debugLog);
		if (api.install() !== "ok") throw new Error("Main-process hook failed to install");
		this.mainApi = api;
		return api;
	}

	/** Main api only if the hook is already installed (never installs it). */
	private existingMainApi(): MainApi | null {
		if (this.mainApi) return this.mainApi;
		try {
			const g = remote()?.getGlobal("__sameWindowVaultSwitcher") as { api?: unknown } | undefined;
			if (g && g.api) return this.getMainApi();
		} catch {
			// Not installed or not reachable: treat as absent.
		}
		return null;
	}

	private dlog(msg: string) {
		if (!this.settings.debugLog) return;
		try {
			this.mainApi?.log("[renderer] " + msg);
		} catch {
			// Logging is best-effort.
		}
	}

	// ---------------------------------------------------------------- helpers

	currentVaultPath(): string | null {
		const a = this.app.vault.adapter;
		return a instanceof FileSystemAdapter ? a.getBasePath() : null;
	}

	listVaults(): VaultEntry[] {
		const raw = this.send("vault-list") as VaultList | undefined;
		if (!raw) return [];
		return Object.entries(raw)
			.map(([id, v]) => ({ id, ...v }))
			.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
	}

	private isCurrent(path: string): boolean {
		const cur = this.currentVaultPath();
		return !!cur && norm(cur) === norm(path);
	}

	private geometry(): Geometry {
		const w = requireRemote().getCurrentWindow();
		const max = w.isMaximized();
		const full = w.isFullScreen();
		return { max, full, bounds: max || full ? w.getNormalBounds() : w.getBounds() };
	}

	/** Put another window exactly where this one is, then close this one. */
	private takeOver(target: BrowserWindowLike, geom: Geometry, waitForShow: boolean) {
		try {
			target.setBounds(geom.bounds);
		} catch {
			// The window may not accept bounds yet; finish() sets them again.
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
			} catch {
				// Placement is best-effort; the vault is open either way.
			}
			window.setTimeout(() => this.closeSelf(), this.settings.closeDelayMs);
		};

		if (!waitForShow) {
			finish();
			return;
		}

		const started = Date.now();
		const timer = window.setInterval(() => {
			let visible: boolean;
			try {
				visible = target.isDestroyed() || target.isVisible();
			} catch {
				visible = true;
			}
			if (visible || Date.now() - started > 8000) {
				window.clearInterval(timer);
				finish();
			}
		}, 25);
	}

	private findVaultId(api: MainApi, path: string): string | undefined {
		const list = JSON.parse(api.vaultsJson()) as VaultList;
		return Object.keys(list).find((k) => norm(list[k]?.path ?? "") === norm(path));
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
			} catch {
				// Fall through to handoff.
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
		// No remote: can't verify anything, so behave like stock Obsidian.
		if (!rm) return this.send("vault-open", path, create);

		const geom = this.geometry();
		const self = rm.getCurrentWindow();
		const before = new Set<number>(rm.BrowserWindow.getAllWindows().map((w) => w.id));

		const res = this.send("vault-open", path, create);
		if (res !== true) return res;

		this.switching = true;
		const fresh = rm.BrowserWindow.getAllWindows().find((w) => !before.has(w.id) && !w.isDestroyed());
		if (fresh) {
			this.takeOver(fresh, geom, true);
			return res;
		}

		// The vault was already open somewhere: Obsidian focused that window.
		let existing: BrowserWindowLike | null = null;
		try {
			const api = this.getMainApi();
			const id = this.findVaultId(api, path);
			const winId = id ? api.findShowing(id, self.webContents.id) : -1;
			if (winId >= 0) existing = rm.BrowserWindow.fromId(winId);
		} catch {
			// Placement is best-effort.
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
		const rm = requireRemote();
		const api = this.getMainApi();
		const self = rm.getCurrentWindow();
		const wcId = rm.getCurrentWebContents().id;

		const targetId = this.findVaultId(api, path);
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

	private async doSwap(api: MainApi, wcId: number, targetId: string) {
		try {
			this.dlog(`doSwap start wc=${wcId} target=${targetId}`);
			// Flush unsaved editor content and the workspace layout first.
			const saves: Promise<void>[] = [];
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.view instanceof TextFileView) saves.push(leaf.view.save());
			});
			await Promise.allSettled(saves);
			await this.app.workspace.requestSaveLayout.run();

			const res = JSON.parse(api.swap(wcId, targetId)) as SwapResult;
			this.dlog("swap result " + JSON.stringify(res));
			if (!res.ok) throw new Error(res.error ?? "Unknown error");
			window.location.reload();
		} catch (e) {
			this.switching = false;
			this.dlog("doSwap error " + errorText(e));
			console.error("[same-window-vault-switcher]", e);
			new Notice(`Couldn't swap vault: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<Settings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

interface Geometry {
	max: boolean;
	full: boolean;
	bounds: Rect;
}

// -------------------------------------------------------------------- picker

class VaultPickerModal extends SuggestModal<VaultEntry> {
	constructor(
		app: App,
		private plugin: SameWindowVaultSwitcher,
	) {
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
	constructor(
		app: App,
		private plugin: SameWindowVaultSwitcher,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Use for Obsidian's vault switcher",
				desc: 'Apply to the built-in sidebar vault menu and "Open another vault". The command palette command always works.',
				control: { type: "toggle", key: "enabled", defaultValue: DEFAULT_SETTINGS.enabled },
			},
			{
				name: "Mode",
				desc:
					"Seamless handoff: the new vault opens exactly where this window is, then this window closes. " +
					"In-place swap (experimental): this same window reloads into the other vault; " +
					"Obsidian's own bookkeeping still ties the old vault to this window, so links and the CLI for the old vault may land here.",
				control: {
					type: "dropdown",
					key: "mode",
					defaultValue: DEFAULT_SETTINGS.mode,
					options: {
						handoff: "Seamless handoff (recommended)",
						swap: "In-place swap (experimental)",
					},
				},
			},
			{
				name: "Close delay (ms)",
				desc: "Handoff only: wait this long after the new window appears before closing this one.",
				control: { type: "number", key: "closeDelayMs", defaultValue: DEFAULT_SETTINGS.closeDelayMs, min: 0, step: 10 },
			},
			{
				name: "Debug log file",
				desc: "Absolute path of a file to write swap diagnostics to. Leave empty to turn logging off.",
				control: { type: "text", key: "debugLog", defaultValue: DEFAULT_SETTINGS.debugLog, placeholder: "/path/to/swap.log" },
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof Settings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === "enabled" && typeof value === "boolean") s.enabled = value;
		else if (key === "mode" && (value === "handoff" || value === "swap")) s.mode = value;
		else if (key === "closeDelayMs" && typeof value === "number" && value >= 0) s.closeDelayMs = value;
		else if (key === "debugLog" && typeof value === "string") s.debugLog = value.trim();
		else return;
		await this.plugin.saveSettings();
	}
}
