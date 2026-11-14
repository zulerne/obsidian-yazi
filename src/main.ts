import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ParsedConfig, hideBindings, parseConfig, parseKeyList } from "./config";
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

		this.app.workspace.onLayoutReady(() => {
			void this.applyFileExplorerReplacement();
			// Obsidian can recreate the core file explorer (e.g. "Reveal file in navigation").
			this.registerEvent(
				this.app.workspace.on("layout-change", () => {
					if (this.settings.replaceFileExplorer && !this.replacing) void this.applyFileExplorerReplacement();
				}),
			);
		});

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

	private replacing = false;

	/**
	 * Replace the core File explorer in the left sidebar with Yazi FM, in the same tab slot.
	 * With restore = true, bring the core File explorer back instead.
	 */
	async applyFileExplorerReplacement(restore = false) {
		const ws = this.app.workspace;
		if (restore) {
			if (!ws.getLeavesOfType("file-explorer").length) {
				const leaf = ws.getLeftLeaf(false);
				await leaf?.setViewState({ type: "file-explorer" });
			}
			return;
		}
		if (!this.settings.replaceFileExplorer || this.replacing) return;
		const explorers = ws.getLeavesOfType("file-explorer").filter((l) => l.getRoot() === ws.leftSplit);
		if (!explorers.length) return;
		this.replacing = true;
		try {
			const target = explorers[0];
			// Keep a single explorer in the left sidebar.
			for (const l of ws.getLeavesOfType(VIEW_TYPE)) if (l.getRoot() === ws.leftSplit) l.detach();
			for (const l of explorers.slice(1)) l.detach();
			const active = ws.getActiveFile();
			await target.setViewState({ type: VIEW_TYPE, active: false });
			if (target.view instanceof YaziView && active instanceof TFile && this.settings.startAtActiveFile) {
				target.view.revealPath(active.path);
			}
		} finally {
			this.replacing = false;
		}
	}

	async loadSettings() {
		const saved = (await this.loadData()) as (Partial<YaziSettings> & { physicalKeys?: boolean }) | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		// 0.1.x stored a boolean "physicalKeys"; map it to keyMode.
		if (saved && saved.keyMode === undefined && typeof saved.physicalKeys === "boolean") {
			this.settings.keyMode = saved.physicalKeys ? "physical" : "typed";
		}
		delete (this.settings as { physicalKeys?: boolean }).physicalKeys;
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
		const adapter = this.app.vault.adapter;
		this.config = hideBindings(parseConfig(keymap, yazi, this.settings.obsidianKeymap), {
			vaultBase: this.settings.hideOutsideVault && adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null,
			home: os.homedir(),
			ignored: parseKeyList(this.settings.ignoredKeys),
		});
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

	private async leafIn(location: Location): Promise<YaziView | undefined> {
		const ws = this.app.workspace;
		const leaf = ws.getLeavesOfType(VIEW_TYPE).find((l) => {
			const root = l.getRoot();
			if (location === "left") return root === ws.leftSplit;
			if (location === "right") return root === ws.rightSplit;
			return root === ws.rootSplit;
		});
		if (!leaf) return undefined;
		// Sidebar leaves are loaded lazily; the view is a placeholder until then.
		await leaf.loadIfDeferred();
		return leaf.view instanceof YaziView ? leaf.view : undefined;
	}

	async open(location: Location, forceNew = false, reveal = false) {
		const ws = this.app.workspace;
		const active = ws.getActiveFile();
		let view = forceNew ? undefined : await this.leafIn(location);
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
		// revealLeaf() flashes the tab header, so expand the sidebar and activate the tab directly.
		const root = view.leaf.getRoot();
		if (root === ws.leftSplit || root === ws.rightSplit) {
			if (root === ws.leftSplit && ws.leftSplit.collapsed) ws.leftSplit.expand();
			if (root === ws.rightSplit && ws.rightSplit.collapsed) ws.rightSplit.expand();
		}
		ws.setActiveLeaf(view.leaf, { focus: true });
		if (active instanceof TFile && (reveal || (created && this.settings.startAtActiveFile))) {
			view.revealPath(active.path);
		}
		view.focus();
	}
}
