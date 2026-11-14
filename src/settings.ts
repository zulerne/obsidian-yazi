import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type YaziPlugin from "./main";
import { unsupportedReason } from "./config";

export type Location = "left" | "right" | "tab";
export type ConfigSource = "yazi-dir" | "plugin";

export interface YaziSettings {
	location: Location;
	/** Put the explorer in place of Obsidian's core File explorer in the left sidebar. */
	replaceFileExplorer: boolean;
	/** Where files are opened: the most recent main tab, or always a new tab. */
	openIn: "recent" | "new-tab";
	focusFileAfterOpen: boolean;
	/** Collapse the sidebar holding the explorer after a file is opened in Obsidian. */
	collapseSidebarOnOpen: boolean;
	physicalKeys: boolean;
	/** Column ratio used in a sidebar; empty = use yazi.toml ratio. */
	sidebarRatio: string;
	markdownPreview: "rendered" | "source";
	startAtActiveFile: boolean;
	configSource: ConfigSource;
	yaziDir: string;
	keymapToml: string;
	yaziToml: string;
	/** Yazi-format keymap applied only in Obsidian, on top of keymap.toml. */
	obsidianKeymap: string;
	/** Key sequences to drop from the Yazi keymap, e.g. "g v, g r". */
	ignoredKeys: string;
	/** Hide `cd` bindings whose path is outside the vault. */
	hideOutsideVault: boolean;
}

export const DEFAULT_SETTINGS: YaziSettings = {
	location: "left",
	replaceFileExplorer: false,
	openIn: "recent",
	focusFileAfterOpen: true,
	collapseSidebarOnOpen: false,
	physicalKeys: true,
	sidebarRatio: "0,1,0",
	markdownPreview: "rendered",
	startAtActiveFile: true,
	configSource: "yazi-dir",
	yaziDir: "~/.config/yazi",
	keymapToml: "",
	yaziToml: "",
	ignoredKeys: "",
	obsidianKeymap: "",
	hideOutsideVault: true,
};

export class YaziSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: YaziPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.settings;
		containerEl.empty();

		const save = async (reload = false) => {
			await p.saveSettings();
			if (reload) {
				p.reloadConfig();
				this.display();
			}
		};

		new Setting(containerEl).setName("Layout").setHeading();

		new Setting(containerEl)
			.setName("Open the explorer in")
			.setDesc("Used by the ribbon icon and the “Open” command.")
			.addDropdown((d) =>
				d
					.addOptions({ left: "Left sidebar", right: "Right sidebar", tab: "Main tab" })
					.setValue(s.location)
					.onChange(async (v) => {
						s.location = v as Location;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Replace the file explorer")
			.setDesc(
				"Show Yazi FM in place of Obsidian's file explorer in the left sidebar and close the core file explorer. Turn off to bring it back.",
			)
			.addToggle((t) =>
				t.setValue(s.replaceFileExplorer).onChange(async (v) => {
					s.replaceFileExplorer = v;
					await save();
					await p.applyFileExplorerReplacement(!v);
				}),
			);

		new Setting(containerEl)
			.setName("Sidebar column ratio")
			.setDesc("parent,current,preview in a sidebar, e.g. 0,1,0 or 1,3,2. Empty = use ratio from yazi.toml.")
			.addText((t) =>
				t
					.setPlaceholder("yazi.toml")
					.setValue(s.sidebarRatio)
					.onChange(async (v) => {
						s.sidebarRatio = v.trim();
						await save();
						p.refreshViews();
					}),
			);

		new Setting(containerEl)
			.setName("Markdown preview")
			.addDropdown((d) =>
				d
					.addOptions({ rendered: "Rendered", source: "Source text" })
					.setValue(s.markdownPreview)
					.onChange(async (v) => {
						s.markdownPreview = v as YaziSettings["markdownPreview"];
						await save();
						p.refreshViews();
					}),
			);

		new Setting(containerEl)
			.setName("Start at the active file")
			.setDesc("When the explorer is opened, jump to the folder of the active note and hover it.")
			.addToggle((t) =>
				t.setValue(s.startAtActiveFile).onChange(async (v) => {
					s.startAtActiveFile = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Opening files").setHeading();

		new Setting(containerEl)
			.setName("Open files in")
			.setDesc("“Current tab” reuses the last active editor tab (never the explorer tab itself).")
			.addDropdown((d) =>
				d
					.addOptions({ recent: "Current tab", "new-tab": "New tab" })
					.setValue(s.openIn)
					.onChange(async (v) => {
						s.openIn = v as YaziSettings["openIn"];
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Focus the file after opening")
			.setDesc("Off: keyboard focus stays in the explorer.")
			.addToggle((t) =>
				t.setValue(s.focusFileAfterOpen).onChange(async (v) => {
					s.focusFileAfterOpen = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Collapse the sidebar after opening a file")
			.setDesc("When the explorer is in a sidebar, hide that sidebar once a file opens in Obsidian.")
			.addToggle((t) =>
				t.setValue(s.collapseSidebarOnOpen).onChange(async (v) => {
					s.collapseSidebarOnOpen = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Keys").setHeading();

		new Setting(containerEl)
			.setName("Physical key positions")
			.setDesc("Read keys by their position on a QWERTY keyboard, so bindings work in the Russian layout too.")
			.addToggle((t) =>
				t.setValue(s.physicalKeys).onChange(async (v) => {
					s.physicalKeys = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Configuration source")
			.setDesc("Read keymap.toml and yazi.toml from your Yazi config folder, or from the fields below.")
			.addDropdown((d) =>
				d
					.addOptions({ "yazi-dir": "Yazi config folder", plugin: "Plugin settings" })
					.setValue(s.configSource)
					.onChange(async (v) => {
						s.configSource = v as ConfigSource;
						await save(true);
					}),
			);

		if (s.configSource === "yazi-dir") {
			new Setting(containerEl)
				.setName("Yazi config folder")
				.addText((t) =>
					t.setValue(s.yaziDir).onChange(async (v) => {
						s.yaziDir = v.trim() || DEFAULT_SETTINGS.yaziDir;
						await save();
					}),
				)
				.addButton((b) =>
					b.setButtonText("Reload").onClick(async () => {
						await save(true);
						new Notice("Yazi config reloaded");
					}),
				);
		} else {
			new Setting(containerEl)
				.setName("Import from Yazi config folder")
				.setDesc(`Copy keymap.toml and yazi.toml from ${s.yaziDir} into the fields below.`)
				.addButton((b) =>
					b.setButtonText("Import").onClick(async () => {
						const files = p.readYaziDir();
						s.keymapToml = files.keymap ?? "";
						s.yaziToml = files.yazi ?? "";
						await save(true);
					}),
				);
			this.textArea(containerEl, "keymap.toml", s.keymapToml, async (v) => {
				s.keymapToml = v;
				await save(true);
			});
			this.textArea(containerEl, "yazi.toml", s.yaziToml, async (v) => {
				s.yaziToml = v;
				await save(true);
			});
		}

		this.textArea(
			containerEl,
			"Obsidian-only keymap",
			s.obsidianKeymap,
			async (v) => {
				s.obsidianKeymap = v;
				await save(true);
			},
			"Same format as keymap.toml ([[mgr.prepend_keymap]] / [[mgr.append_keymap]]). Applied on top of your Yazi keymap, only in Obsidian.",
			6,
		);

		new Setting(containerEl)
			.setName("Hide paths outside the vault")
			.setDesc("Drop cd bindings (such as g d → ~/Downloads) that point outside the vault.")
			.addToggle((t) =>
				t.setValue(s.hideOutsideVault).onChange(async (v) => {
					s.hideOutsideVault = v;
					await save(true);
				}),
			);

		new Setting(containerEl)
			.setName("Ignored keys")
			.setDesc("Key sequences from your Yazi keymap to drop in Obsidian, separated by commas, e.g. g v, g r.")
			.addText((t) => {
				t.setPlaceholder("g v, g r").setValue(s.ignoredKeys);
				t.inputEl.addEventListener("blur", () => {
					if (t.getValue() !== s.ignoredKeys) {
						s.ignoredKeys = t.getValue();
						void save(true);
					}
				});
			});

		this.renderStatus(containerEl);
	}

	private textArea(
		el: HTMLElement,
		name: string,
		value: string,
		onSave: (v: string) => Promise<void>,
		desc = "",
		rows = 14,
	) {
		const setting = new Setting(el).setName(name).setDesc(`${desc ? desc + " " : ""}Saved when the field loses focus.`);
		setting.settingEl.addClass("yazi-setting-textarea");
		setting.addTextArea((t) => {
			t.setValue(value);
			t.inputEl.rows = rows;
			t.inputEl.spellcheck = false;
			t.inputEl.addEventListener("blur", () => {
				if (t.getValue() !== value) void onSave(t.getValue());
			});
		});
	}

	private renderStatus(el: HTMLElement) {
		const cfg = this.plugin.config;
		const box = el.createDiv({ cls: "yazi-setting-status" });
		box.createEl("p", { text: `${cfg.bindings.length} key bindings loaded.` });
		if (cfg.errors.length) {
			box.createEl("p", { text: "Errors:", cls: "mod-warning" });
			const ul = box.createEl("ul");
			for (const e of cfg.errors) ul.createEl("li", { text: e });
		}
		if (cfg.hidden.length) {
			const d = box.createEl("details");
			d.createEl("summary", { text: `${cfg.hidden.length} bindings hidden` });
			const ul = d.createEl("ul");
			for (const h of cfg.hidden) ul.createEl("li", { text: `${h.on.join(" ")} → ${h.run.join("; ")}  (${h.reason})` });
		}
		const seen = new Set<string>();
		const unsupported: string[] = [];
		for (const b of cfg.bindings) {
			const key = b.on.join(" ");
			if (seen.has(key)) continue;
			seen.add(key);
			for (const r of b.run) {
				const why = unsupportedReason(r);
				if (why) unsupported.push(`${key} → ${r}  (${why})`);
			}
		}
		if (unsupported.length) {
			const d = box.createEl("details");
			d.createEl("summary", { text: `${unsupported.length} bindings are not available in Obsidian` });
			const ul = d.createEl("ul");
			for (const u of unsupported) ul.createEl("li", { text: u });
		}
	}
}
