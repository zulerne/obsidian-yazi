import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, TextAreaComponent } from "obsidian";
import type YaziPlugin from "./main";
import { unsupportedReason } from "./config";
import type { KeyMode } from "./keys";

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
	keyMode: KeyMode;
	/** Column ratio used in a sidebar; empty = use yazi.toml ratio. */
	sidebarRatio: string;
	markdownPreview: "rendered" | "source";
	/** Show icons assigned with the Iconize plugin. */
	useIconize: boolean;
	startAtActiveFile: boolean;
	configSource: ConfigSource;
	yaziDir: string;
	keymapToml: string;
	yaziToml: string;
	/** Yazi-format keymap applied only in Obsidian, on top of keymap.toml. */
	obsidianKeymap: string;
	/** Key sequences to drop from the Yazi keymap, e.g. "g t, g f, w". */
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
	keyMode: "auto",
	sidebarRatio: "0,1,0",
	markdownPreview: "rendered",
	useIconize: true,
	startAtActiveFile: true,
	configSource: "yazi-dir",
	yaziDir: "~/.config/yazi",
	keymapToml: "",
	yaziToml: "",
	ignoredKeys: "",
	obsidianKeymap: "",
	hideOutsideVault: true,
};

/** Settings whose change requires re-reading the Yazi config. */
const RELOAD_KEYS = new Set<keyof YaziSettings>([
	"configSource",
	"yaziDir",
	"hideOutsideVault",
	"ignoredKeys",
]);
/** Settings whose change only needs the open explorers to re-render. */
const REFRESH_KEYS = new Set<keyof YaziSettings>(["sidebarRatio", "markdownPreview", "useIconize"]);

/**
 * Save a text area shortly after typing stops and when it loses focus, so the text is kept
 * even if the settings close without a blur event.
 */
function saveOnEdit(input: HTMLTextAreaElement, save: () => void): void {
	let timer: number | null = null;
	const flush = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		save();
	};
	input.addEventListener("input", () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(flush, 600);
	});
	input.addEventListener("blur", flush);
}

export class YaziSettingTab extends PluginSettingTab {
	private statusEl: HTMLElement | null = null;
	private reloadTimer: number | null = null;

	constructor(
		app: App,
		private plugin: YaziPlugin,
	) {
		super(app, plugin);
	}

	// --- Obsidian 1.13+: declarative settings (rendered and searchable by Obsidian) ---

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = () => this.plugin.settings;
		const pluginSource = () => s().configSource === "plugin";
		return [
			{
				type: "group",
				heading: "Layout",
				items: [
					{
						name: "Open the explorer in",
						desc: "Used by the ribbon icon and the “Open” command.",
						control: {
							type: "dropdown",
							key: "location",
							options: { left: "Left sidebar", right: "Right sidebar", tab: "Main tab" },
						},
					},
					{
						name: "Replace the file explorer",
						desc: "Show Yazi FM in place of Obsidian's file explorer in the left sidebar and close the core file explorer. Turn off to bring it back.",
						control: { type: "toggle", key: "replaceFileExplorer" },
					},
					{
						name: "Sidebar column ratio",
						desc: "parent,current,preview in a sidebar, e.g. 0,1,0 or 1,3,2. Empty = use ratio from yazi.toml.",
						control: {
							type: "text",
							key: "sidebarRatio",
							placeholder: "yazi.toml",
							validate: (v: string) =>
								!v.trim() || /^\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*$/.test(v)
									? undefined
									: "Use three numbers, e.g. 0,1,0",
						},
					},
					{
						name: "Markdown preview",
						control: {
							type: "dropdown",
							key: "markdownPreview",
							options: { rendered: "Rendered", source: "Source text" },
						},
					},
					{
						name: "Use Iconize icons",
						desc: "Show the icons and colors assigned with the Iconize plugin, when it is installed.",
						control: { type: "toggle", key: "useIconize" },
					},
					{
						name: "Start at the active file",
						desc: "When the explorer is opened, jump to the folder of the active note and hover it.",
						control: { type: "toggle", key: "startAtActiveFile" },
					},
				],
			},
			{
				type: "group",
				heading: "Opening files",
				items: [
					{
						name: "Open files in",
						desc: "“Current tab” reuses the last active editor tab (never the explorer tab itself).",
						control: {
							type: "dropdown",
							key: "openIn",
							options: { recent: "Current tab", "new-tab": "New tab" },
						},
					},
					{
						name: "Focus the file after opening",
						desc: "Off: keyboard focus stays in the explorer.",
						control: { type: "toggle", key: "focusFileAfterOpen" },
					},
					{
						name: "Collapse the sidebar after opening a file",
						desc: "When the explorer is in a sidebar, hide that sidebar once a file opens in Obsidian.",
						control: { type: "toggle", key: "collapseSidebarOnOpen" },
					},
				],
			},
			{
				type: "group",
				heading: "Keys",
				items: [
					{
						name: "Keyboard layout",
						desc: "Auto: Latin keys as typed, other layouts by key position. Physical: always by position on a QWERTY keyboard. Typed: always the character your layout produces.",
						control: {
							type: "dropdown",
							key: "keyMode",
							options: { auto: "Auto", physical: "Physical (QWERTY positions)", typed: "Typed characters" },
						},
					},
					{
						name: "Configuration source",
						desc: "Read keymap.toml and yazi.toml from your Yazi config folder, or from the fields below.",
						control: {
							type: "dropdown",
							key: "configSource",
							options: { "yazi-dir": "Yazi config folder", plugin: "Plugin settings" },
						},
					},
					{
						name: "Yazi config folder",
						visible: () => !pluginSource(),
						render: (setting) => {
							setting.addText((t) =>
								t.setValue(s().yaziDir).onChange(async (v) => {
									s().yaziDir = v.trim() || DEFAULT_SETTINGS.yaziDir;
									await this.plugin.saveSettings();
								}),
							);
							setting.addButton((b) =>
								b.setButtonText("Reload").onClick(() => {
									this.reloadConfig();
									new Notice("Yazi config reloaded");
								}),
							);
						},
					},
					{
						name: "Import from Yazi config folder",
						desc: "Copy keymap.toml and yazi.toml from the Yazi config folder into the fields below.",
						visible: pluginSource,
						render: (setting) => {
							setting.addButton((b) =>
								b.setButtonText("Import").onClick(async () => {
									const files = this.plugin.readYaziDir();
									s().keymapToml = files.keymap ?? "";
									s().yaziToml = files.yazi ?? "";
									await this.plugin.saveSettings();
									this.keymapArea?.setValue(s().keymapToml);
									this.yaziArea?.setValue(s().yaziToml);
									this.reloadConfig();
								}),
							);
						},
					},
					{
						name: "keymap.toml",
						visible: pluginSource,
						render: (setting) => {
							this.keymapArea = this.textAreaControl(setting, () => s().keymapToml, (v) => (s().keymapToml = v));
						},
					},
					{
						name: "yazi.toml",
						visible: pluginSource,
						render: (setting) => {
							this.yaziArea = this.textAreaControl(setting, () => s().yaziToml, (v) => (s().yaziToml = v));
						},
					},
					{
						name: "Obsidian-only keymap",
						desc: "Same format as keymap.toml ([[mgr.prepend_keymap]] / [[mgr.append_keymap]]). Applied on top of your Yazi keymap, only in Obsidian.",
						render: (setting) => {
							this.textAreaControl(setting, () => s().obsidianKeymap, (v) => (s().obsidianKeymap = v), 6);
						},
					},
					{
						name: "Hide paths outside the vault",
						desc: "Drop cd bindings (such as g d → ~/Downloads) that point outside the vault.",
						control: { type: "toggle", key: "hideOutsideVault" },
					},
					{
						name: "Ignored keys",
						desc: "Key sequences from your Yazi keymap to drop in Obsidian, separated by commas, e.g. g t, g f, w.",
						control: { type: "text", key: "ignoredKeys", placeholder: "g t, g f, w" },
					},
					{
						name: "Status",
						searchable: false,
						render: (setting) => {
							this.statusEl = setting.descEl;
							this.fillStatus(setting.descEl);
						},
					},
				],
			},
		];
	}

	private keymapArea: TextAreaComponent | null = null;
	private yaziArea: TextAreaComponent | null = null;

	private textAreaControl(
		setting: Setting,
		get: () => string,
		set: (v: string) => void,
		rows = 14,
	): TextAreaComponent {
		let area!: TextAreaComponent;
		setting.settingEl.addClass("yazi-setting-textarea");
		setting.addTextArea((t) => {
			area = t;
			t.setValue(get());
			t.inputEl.rows = rows;
			t.inputEl.spellcheck = false;
			saveOnEdit(t.inputEl, () => {
				if (t.getValue() === get()) return;
				set(t.getValue());
				void this.plugin.saveSettings().then(() => this.reloadConfig());
			});
		});
		return area;
	}

	// Called by the declarative settings framework (Obsidian 1.13+) when a control changes.
	async setControlValue(key: string, value: unknown): Promise<void> {
		const k = key as keyof YaziSettings;
		const p = this.plugin;
		(p.settings as unknown as Record<string, unknown>)[key] = value;
		await p.saveSettings();
		if (k === "replaceFileExplorer") await p.applyFileExplorerReplacement(!value);
		if (k === "configSource") (this as unknown as { refreshDomState?: () => void }).refreshDomState?.();
		if (RELOAD_KEYS.has(k)) this.scheduleReload();
		if (REFRESH_KEYS.has(k)) p.refreshViews();
	}

	private scheduleReload() {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			this.reloadConfig();
		}, 400);
	}

	private reloadConfig() {
		this.plugin.reloadConfig();
		if (this.statusEl) this.fillStatus(this.statusEl);
	}

	private fillStatus(el: HTMLElement) {
		el.empty();
		this.renderStatus(el);
	}

	// --- Obsidian < 1.13: imperative fallback ---

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
			.setName("Use Iconize icons")
			.setDesc("Show the icons and colors assigned with the Iconize plugin, when it is installed.")
			.addToggle((t) =>
				t.setValue(s.useIconize).onChange(async (v) => {
					s.useIconize = v;
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
			.setName("Keyboard layout")
			.setDesc(
				"Auto: Latin keys as typed, other layouts by key position. Physical: always by position on a QWERTY keyboard. Typed: always the character your layout produces.",
			)
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Auto", physical: "Physical (QWERTY positions)", typed: "Typed characters" })
					.setValue(s.keyMode)
					.onChange(async (v) => {
						s.keyMode = v as KeyMode;
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
			.setDesc("Key sequences from your Yazi keymap to drop in Obsidian, separated by commas, e.g. g t, g f, w.")
			.addText((t) => {
				t.setPlaceholder("g t, g f, w").setValue(s.ignoredKeys);
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
		const setting = new Setting(el).setName(name);
		if (desc) setting.setDesc(desc);
		setting.settingEl.addClass("yazi-setting-textarea");
		setting.addTextArea((t) => {
			t.setValue(value);
			t.inputEl.rows = rows;
			t.inputEl.spellcheck = false;
			let saved = value;
			saveOnEdit(t.inputEl, () => {
				const v = t.getValue();
				if (v === saved) return;
				saved = v;
				void onSave(v);
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
