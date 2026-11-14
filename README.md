# Yazi FM

Yazi in your vault: the same default keys and behavior as [Yazi](https://github.com/sxyazi/yazi), plus your own `keymap.toml` and `yazi.toml`. Nothing new to learn.

Yazi FM does not invent its own keymap. It ships Yazi's standard bindings and reads your Yazi config, so the keys you use in the terminal do the same thing in Obsidian: the same chords, the same `prepend_keymap` overrides, the same plugins (`smart-enter`, `jump-to-char`, `toggle-pane`…). Where Obsidian needs something different, you add it in a separate Obsidian-only keymap instead of changing your terminal setup.

## Features

- **Yazi's default keymap built in.** The Yazi 26.9.1 `[mgr]` defaults are bundled verbatim. Your `keymap.toml` is layered on top exactly like Yazi does it: `prepend_keymap`, `keymap` and `append_keymap`. The first binding whose first key matches wins.
- **Reads `~/.config/yazi`.** The plugin reads `keymap.toml` and these `yazi.toml [mgr]` options: `ratio`, `sort_by`, `sort_sensitive`, `sort_reverse`, `sort_dir_first`, `linemode` and `show_hidden`. You can also paste the configuration into the plugin settings instead.
- **Yazi layout.** Parent, current and preview columns; a which-key popup for chords; a status bar; visual mode; selection and yank markers; the `mtime`/`btime`/`size` linemodes.
- **Obsidian-only overrides.** An extra keymap in the plugin settings, in the same format, is applied on top of `keymap.toml` without touching your terminal setup. You can also hide bindings you do not need, and `cd` bindings to paths outside the vault are hidden automatically.
- **Layout-independent keys.** Optionally, keys are matched by their physical QWERTY position, so bindings work in non-Latin keyboard layouts without aliases.
- **Sidebar or tab.** Open the explorer in the left sidebar, the right sidebar or a main tab. The sidebar can use its own column ratio.
- **Vault-aware file operations.** Renames and moves go through Obsidian, so links are updated. Deletion follows Obsidian's trash setting.

## Usage

Open the explorer with the ribbon icon or one of these commands:

- **Yazi FM: Open**
- **Yazi FM: Open in left sidebar**
- **Yazi FM: Open in right sidebar**
- **Yazi FM: Open in new tab**
- **Yazi FM: Reveal active file**

Press `~` or `F1` inside the explorer to list every active binding.

Run **Yazi FM: Reload Yazi config** after you edit your Yazi config files.

## How Yazi commands map to Obsidian

| Yazi command | Behaviour in Obsidian |
| --- | --- |
| `open` | Opens the file in Obsidian. Files that Obsidian cannot display open in the system default app. `open --interactive` offers: new tab, split, new window, default app, reveal in Finder. |
| `remove` | Moves files to trash according to Obsidian's "Deleted files" setting. `--permanently` deletes them. |
| `cd`, `reveal` | Accepts paths relative to the current folder, `~` (the vault root) and absolute paths inside the vault. |
| `search --via=fd` / `--via=rg` | Searches the current folder recursively by name or by content. No external tools are needed. |
| `shell` | Desktop only. Runs in the background with `%s` (selected files) and `%h` (hovered file). A command of the form `ya emit <cmd>` runs `<cmd>` in the explorer. |
| `plugin smart-enter`, `jump-to-char`, `toggle-pane`, `confirm-quit`, `smart-filter`, `fzf`, `zoxide` | Built-in equivalents of these Yazi plugins. `zoxide` jumps to any folder in the vault. |
| `quit` | Collapses the sidebar or closes the explorer tab. |

**Not supported:** Yazi tabs (`tab_create` opens another explorer tab instead), `link`, `hardlink`, `bulk_create`, bulk rename, the task manager and `shell --block`. The settings page lists the bindings from your config that are not available.

**Extra commands you can bind:**

- `open --tab`, `open --split` and `open --window` open files in a new tab, split or window;
- `copy vault_path` copies the path relative to the vault;
- `copy wikilink` copies a link to the file;
- `obsidian <command-id>` runs any Obsidian command.

```toml
[[mgr.prepend_keymap]]
on = ["c", "l"]
run = "copy wikilink"
desc = "Copy a link to the file"
```

## Settings

- **Replace the file explorer.** Off by default. Shows Yazi FM in place of Obsidian's file explorer in the left sidebar and closes the core file explorer. If Obsidian recreates it, Yazi FM replaces it again. Turn the setting off to bring the core file explorer back.
- **Open the explorer in.** Left sidebar, right sidebar or main tab. Used by the ribbon icon and the **Open** command.
- **Sidebar column ratio.** The parent, current and preview column widths used in a sidebar. The default is `0,1,0`. Leave it empty to use `ratio` from `yazi.toml`.
- **Open files in.** The last active editor tab or a new tab. You can also choose whether keyboard focus moves to the opened file.
- **Collapse the sidebar after opening a file.** Off by default. When the explorer is in a sidebar, that sidebar is hidden once a file opens in Obsidian, and the opened file gets focus.
- **Physical key positions.** Keys are matched by their QWERTY position, so bindings work in non-Latin layouts. The character after `jump-to-char` is still read as typed, so you can jump to files with non-Latin names.
- **Configuration source.** Read the configuration from the Yazi config folder (`~/.config/yazi` by default), or paste `keymap.toml` and `yazi.toml` into the settings.
- **Obsidian-only keymap.** Uses the same format as `keymap.toml` and is applied on top of it, only in Obsidian. For example, this opens files in a new tab with `t`, since Yazi tabs do not exist here:

  ```toml
  [[mgr.prepend_keymap]]
  on = "t"
  run = "open --tab"
  desc = "Open in a new tab"
  ```

- **Hide paths outside the vault.** On by default. Drops `cd` and `reveal` bindings whose path is outside the vault, such as Yazi's `g d` → `~/Downloads`.
- **Ignored keys.** Key sequences to drop from your keymap in Obsidian, separated by commas, for example `g v, g r, g t`.

The bottom of the settings page lists how many bindings are loaded, which are hidden and which are not available in Obsidian.

## Installation

From Obsidian: **Settings → Community plugins → Browse**, then search for "Yazi FM", or open the [listing](https://community.obsidian.md/plugins/yazi-fm).

Manually: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/zulerne/obsidian-yazi/releases/latest) into `<vault>/.obsidian/plugins/yazi-fm/`, then enable the plugin.

## Development

```sh
npm install
npm run dev            # watch build
npm run build          # type-check and production build
OBSIDIAN_VAULT=/path/to/vault npm run install-vault
```

To release, run `npm version <patch|minor|major>` and push the tag. GitHub Actions builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to the release.

## Credits

Key notation, default bindings and behaviour follow [Yazi](https://github.com/sxyazi/yazi) by sxyazi. This plugin is not affiliated with the Yazi project.

## License

[MIT](LICENSE)
