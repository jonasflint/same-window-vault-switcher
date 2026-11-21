# Same Window Vault Switcher

Switch vaults in the current window instead of opening a new one.

By default, Obsidian's vault switcher opens every vault in a new window and leaves the old one behind. With this plugin, the vault you pick takes the place of the one you're in.

Desktop only. Tested on Obsidian 1.15.

## How to use

Switch vaults the way you normally do:

- Click the vault name in the bottom-left of the sidebar and pick a vault.
- Run **Open another vault** from the command palette.
- Or run this plugin's command, **Switch vault in this window**.

The plugin needs to be installed and enabled in every vault you switch *from*. Its settings are shared by all your vaults, so you only set them once.

## Modes

Choose a mode in **Settings → Same Window Vault Switcher**.

### Seamless handoff (default, recommended)

Obsidian opens the vault as usual. Before the new window appears, the plugin moves it to exactly where your current window is, with the same size and maximized state, and then closes the old window. To you, it looks like the vault was swapped in place. Obsidian's own bookkeeping stays fully consistent.

The only visible difference from a true in-place swap: in macOS full screen, the switch plays the Spaces animation.

### In-place swap (experimental)

The same window reloads straight into the other vault. To do this, the plugin installs a small hook in Obsidian's main process that changes which vault this window is told it belongs to.

Obsidian's internal records still link the original vault to that window, so there are some side effects:

- `obsidian://` links and CLI commands that target the original vault are sent to this window.
- Opening the swapped-in vault from outside the plugin (a link, or the **Manage vaults** window) can open it a second time in a new window.
- The window's size and position are saved under the original vault.

The hook only lasts until Obsidian quits. Closing the window or quitting the app resets everything. If a future Obsidian update changes the internals this mode relies on, the plugin falls back to seamless handoff and shows a notice.

## Disclosures

To follow Obsidian's developer policies, this plugin discloses the following:

- **Files outside your vault.** In-place swap mode updates Obsidian's vault registry (`obsidian.json` in Obsidian's app data folder) so that the right vaults reopen when you next launch Obsidian. It only changes the "open" flag and last-opened time of each vault. If you set a **Debug log file**, the plugin also writes diagnostic messages to that path.
- **Undocumented Obsidian internals.** The plugin uses Electron APIs and parts of Obsidian that aren't part of the public plugin API: the `vault`, `vault-list` and `vault-open` IPC channels, the startup snapshot channels, and `@electron/remote`. A future Obsidian version could break it.
- **No network use and no telemetry.** The plugin doesn't connect to the internet or collect any data.

## Installation

From Obsidian: **Settings → Community plugins → Browse**, search for "Same Window Vault Switcher", then install and enable it.

To install it manually, download `main.js` and `manifest.json` from the [latest release](https://github.com/jonasflint/same-window-vault-switcher/releases/latest), copy them into `<vault>/.obsidian/plugins/same-window-vault-switcher/`, then reload Obsidian and enable the plugin.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build
```

To release a new version, run `npm version patch --no-git-tag-version` (or `minor` or `major`), commit the changed `package.json`, `manifest.json` and `versions.json`, and push to `main`. The GitHub Action notices the new version in `manifest.json`, builds the plugin, attests the build, and creates a release with a matching tag and `main.js` and `manifest.json` attached.

## License

[MIT](LICENSE) © Jonas Flint
