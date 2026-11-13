import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ParsedConfig, parseConfig } from "./config";
import { DEFAULT_SETTINGS, Location, YaziSettings, YaziSettingTab } from "./settings";
import { VIEW_TYPE, YaziView } from "./view";

export default class YaziPlugin extends Plugin {
	declare settings: YaziSettings;
	config!: ParsedConfig;

	async onload() {
		await this.loadSettings();
		this.reloadConfig();

		this.registerView(VIEW_TYPE, (leaf) => new YaziView(leaf, this));
		this.addSettingTab(new YaziSettingTab(this.app, this));

		this.addRibbonIcon("folder-open", "Open Yazi", () => void this.open(this.settings.location));

		this.addCommand({ id: "open", name: "Open", callback: () => void this.open(this.settings.location) });
		this.addCommand({ id: "open-left", name: "Open in left sidebar", callback: () => void this.open("left") });
		this.addCommand({ id: "open-right", name: "Open in right sidebar", callback: () => void this.open("right") });
		this.addCommand({ id: "open-tab", name: "Open in new tab", callback: () => void this.open("tab", true) });
		this.addCommand({
			id: "reveal",
			name: "Reveal active file",
			callback: () => void this.open(this.settings.location, false, true),
		});
		this.addCommand({
			id: "reload-config",
			name: "Reload Yazi config",
			callback: () => {
				this.reloadConfig();
				new Notice(
					this.config.errors.length
						? `Yazi config: ${this.config.errors.length} error(s), see settings`
						: `Yazi config reloaded (${this.config.bindings.length} bindings)`,
				);
			},
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	expandHome(p: string): string {
		return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
	}

	readYaziDir(): { keymap?: string; yazi?: string } {
		const dir = this.expandHome(this.settings.yaziDir);
		const read = (f: string) => {
			try {
				return fs.readFileSync(path.join(dir, f), "utf8");
			} catch {
				return undefined;
			}
		};
		return { keymap: read("keymap.toml"), yazi: read("yazi.toml") };
	}

	reloadConfig() {
		let keymap = this.settings.keymapToml;
		let yazi = this.settings.yaziToml;
		if (this.settings.configSource === "yazi-dir") {
			const files = this.readYaziDir();
			keymap = files.keymap ?? "";
			yazi = files.yazi ?? "";
		}
		this.config = parseConfig(keymap, yazi);
		if (this.config.errors.length) console.warn("[yazi-fm] config errors:", this.config.errors);
		this.refreshViews();
	}

	views(): YaziView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((l) => l.view)
			.filter((v): v is YaziView => v instanceof YaziView);
	}

	refreshViews() {
		for (const v of this.views()) v.onConfigChanged();
	}

	private leafIn(location: Location): YaziView | undefined {
		const ws = this.app.workspace;
		return this.views().find((v) => {
			const root = v.leaf.getRoot();
			if (location === "left") return root === ws.leftSplit;
			if (location === "right") return root === ws.rightSplit;
			return root === ws.rootSplit;
		});
	}

	async open(location: Location, forceNew = false, reveal = false) {
		const ws = this.app.workspace;
		const active = ws.getActiveFile();
		let view = forceNew ? undefined : this.leafIn(location);
		let created = false;
		if (!view) {
			let leaf: WorkspaceLeaf | null;
			if (location === "left") leaf = ws.getLeftLeaf(false);
			else if (location === "right") leaf = ws.getRightLeaf(false);
			else leaf = ws.getLeaf("tab");
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
			view = leaf.view instanceof YaziView ? leaf.view : undefined;
			created = true;
		}
		if (!view) return;
		await ws.revealLeaf(view.leaf);
		ws.setActiveLeaf(view.leaf, { focus: true });
		if (active instanceof TFile && (reveal || (created && this.settings.startAtActiveFile))) {
			view.revealPath(active.path);
		}
		view.focus();
	}
}
