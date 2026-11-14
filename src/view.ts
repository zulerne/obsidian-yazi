import { exec, execFile, spawn } from "child_process";
import { homedir } from "os";
import {
	App,
	Component,
	FileSystemAdapter,
	FuzzySuggestModal,
	ItemView,
	MarkdownRenderer,
	Notice,
	Platform,
	Scope,
	TAbstractFile,
	TFile,
	TFolder,
	ViewStateResult,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";
import type YaziPlugin from "./main";
import { Binding, Cmd, Linemode, SortBy, optBool, parseCmd } from "./config";
import { eventToKey } from "./keys";

export const VIEW_TYPE = "yazi-fm";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const TEXT_EXT = new Set([
	"md", "txt", "canvas", "base", "json", "css", "js", "mjs", "ts", "csv", "tsv", "yaml", "yml", "toml",
	"html", "htm", "xml", "sh", "zsh", "py", "lua", "rs", "go", "sql", "ini", "conf", "log",
]);
const PREVIEW_MAX_CHARS = 60_000;

interface Overlay {
	el: HTMLElement;
	onKey(key: string): boolean;
}

interface PromptOptions {
	title: string;
	value?: string;
	cursor?: number;
	onChange?(value: string): void;
	onSubmit(value: string): void | Promise<void>;
	onCancel?(): void;
}

type Ratio = [number, number, number];

interface ViewState {
	cwd?: string;
	hovered?: string;
}

function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

function joinPath(dir: string, name: string): string {
	return normalizePath(dir ? `${dir}/${name}` : name);
}

function splitExt(name: string): [string, string] {
	const i = name.lastIndexOf(".");
	return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

function smartRegex(query: string, mode: "smart" | "insensitive" | "sensitive" = "smart"): RegExp {
	const insensitive = mode === "insensitive" || (mode === "smart" && !/[A-Z]/.test(query));
	const flags = insensitive ? "i" : "";
	try {
		return new RegExp(query, flags);
	} catch {
		return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
	}
}

function matchMode(c: Cmd): "smart" | "insensitive" | "sensitive" {
	return c.opts.smart ? "smart" : c.opts.insensitive ? "insensitive" : "sensitive";
}

function readableSize(n: number): string {
	const units = ["B", "K", "M", "G", "T"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return i === 0 ? `${v}B` : `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

// Same format as Yazi's Linemode:mtime() — "%m/%d %H:%M" this year, "%m/%d  %Y" otherwise.
function formatTime(ms: number): string {
	if (!ms) return "";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	const md = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
	return d.getFullYear() === new Date().getFullYear()
		? `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}`
		: `${md}  ${d.getFullYear()}`;
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function fileIcon(f: TAbstractFile): string {
	if (f instanceof TFolder) return "folder";
	if (!(f instanceof TFile)) return "file";
	const ext = f.extension.toLowerCase();
	if (ext === "md") return "file-text";
	if (IMAGE_EXT.has(ext)) return "image";
	if (ext === "pdf") return "file-type";
	if (ext === "canvas") return "layout-dashboard";
	if (["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) return "file-audio";
	if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "file-video";
	return "file";
}

/** The parts of Electron's `shell` module this plugin uses. */
interface ElectronShell {
	openPath(path: string): Promise<string>;
	showItemInFolder(path: string): void;
}

/** Undocumented but stable App internals, accessed defensively. */
interface AppInternals {
	commands?: { executeCommandById?(id: string): boolean };
	viewRegistry?: { isExtensionRegistered?(ext: string): boolean };
}

function appInternals(app: App): AppInternals {
	return app as unknown as AppInternals;
}

function childCount(f: TAbstractFile): number {
	return f instanceof TFolder ? f.children.length : 0;
}

class JumpModal extends FuzzySuggestModal<TAbstractFile> {
	constructor(
		app: App,
		private items: TAbstractFile[],
		private onChoose: (f: TAbstractFile) => void,
		private onDone: () => void,
	) {
		super(app);
	}
	getItems(): TAbstractFile[] {
		return this.items;
	}
	getItemText(f: TAbstractFile): string {
		return f.path;
	}
	onChooseItem(f: TAbstractFile): void {
		this.onChoose(f);
	}
	onClose(): void {
		this.onDone();
	}
}

export class YaziView extends ItemView {
	private plugin: YaziPlugin;

	// --- state -------------------------------------------------------------
	private cwd = "";
	private entries: TAbstractFile[] = [];
	private cursor = 0;
	private pendingHover: string | null = null;
	private hoverMemo = new Map<string, string>();
	private back: string[] = [];
	private fwd: string[] = [];
	private selected = new Set<string>();
	private visual: { start: number; unset: boolean } | null = null;
	private yanked: { paths: string[]; cut: boolean } | null = null;
	private filter: RegExp | null = null;
	private filterText = "";
	private find: RegExp | null = null;
	private search: { query: string; via: string; results: TAbstractFile[]; running: boolean } | null = null;
	private searchToken = 0;
	private sortBy: SortBy = "alphabetical";
	private sortReverse = false;
	private sortDirFirst = true;
	private sortSensitive = false;
	private linemode: Linemode = "none";
	private showHidden = false;
	private ratioOverride: Ratio | null = null;
	private randomKeys = new Map<string, number>();

	// --- keys ----------------------------------------------------------------
	private pending: string[] = [];
	private candidates: Binding[] = [];
	private overlay: Overlay | null = null;
	private awaitChar: ((key: string) => void) | null = null;
	private handledEvents = new WeakSet<KeyboardEvent>();
	private prompting: PromptOptions | null = null;

	// --- dom -----------------------------------------------------------------
	private rootEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private parentEl!: HTMLElement;
	private currentEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private whichEl!: HTMLElement;
	private inputWrap!: HTMLElement;
	private inputTitle!: HTMLElement;
	private inputEl!: HTMLInputElement;
	private sinkEl!: HTMLInputElement;
	private previewComp: Component | null = null;
	private previewKey = "";
	private previewTimer: number | null = null;
	private refreshTimer: number | null = null;
	private initialized = false;

	constructor(leaf: WorkspaceLeaf, plugin: YaziPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.scope = new Scope(this.app.scope);
		// Obsidian handles Escape through scopes before DOM listeners see it.
		this.scope.register(null, "Escape", (evt) => {
			if (!this.ownsFocus()) return;
			this.handleKeyEvent(evt);
			return false;
		});
		this.applyMgrDefaults();
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return "Yazi";
	}
	getIcon() {
		return "folder-open";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), cwd: this.cwd, hovered: this.hovered()?.path };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as ViewState;
		if (typeof s.cwd === "string" && this.getFolder(s.cwd)) {
			this.cwd = s.cwd;
			this.pendingHover = s.hovered ?? null;
			if (this.initialized) this.refresh();
		}
		await super.setState(state, result);
	}

	private applyMgrDefaults() {
		const m = this.plugin.config.mgr;
		this.sortBy = m.sort_by;
		this.sortReverse = m.sort_reverse;
		this.sortDirFirst = m.sort_dir_first;
		this.sortSensitive = m.sort_sensitive;
		this.linemode = m.linemode;
		this.showHidden = m.show_hidden;
	}

	onConfigChanged() {
		this.applyMgrDefaults();
		this.cancelPending();
		this.refresh();
		this.previewKey = "";
		this.schedulePreview();
	}

	// =========================================================================
	// Lifecycle & DOM

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("yazi-root");
		this.rootEl = root;

		this.headerEl = root.createDiv({ cls: "yazi-header" });
		const panes = root.createDiv({ cls: "yazi-panes" });
		this.parentEl = panes.createDiv({ cls: "yazi-pane yazi-parent" });
		this.currentEl = panes.createDiv({ cls: "yazi-pane yazi-current" });
		this.previewEl = panes.createDiv({ cls: "yazi-pane yazi-preview" });
		this.whichEl = root.createDiv({ cls: "yazi-which" });
		this.whichEl.hide();
		this.inputWrap = root.createDiv({ cls: "yazi-input" });
		this.inputTitle = this.inputWrap.createSpan({ cls: "yazi-input-title" });
		this.inputEl = this.inputWrap.createEl("input", { type: "text" });
		this.inputEl.spellcheck = false;
		this.inputWrap.hide();
		this.statusEl = root.createDiv({ cls: "yazi-status" });

		// Keyboard focus target. It is an <input> so that global key handlers that
		// ignore text fields (for example Vimium-style plugins) leave our keys alone.
		this.sinkEl = root.createEl("input", { cls: "yazi-sink", type: "text" });
		this.sinkEl.readOnly = true;
		this.sinkEl.setAttr("inputmode", "none");
		this.sinkEl.setAttr("aria-label", "Yazi");
		this.sinkEl.tabIndex = 0;

		this.registerDomEvent(this.sinkEl, "keydown", (e) => this.handleKeyEvent(e));
		this.registerDomEvent(this.inputEl, "keydown", (e) => this.handleKeyEvent(e));
		this.registerDomEvent(this.inputEl, "input", () => this.prompting?.onChange?.(this.inputEl.value));
		this.registerDomEvent(this.inputEl, "blur", () => {
			// Clicking elsewhere cancels the prompt like Esc.
			window.setTimeout(() => {
				if (this.prompting && activeDocument.activeElement !== this.inputEl) this.closePrompt(false);
			}, 0);
		});
		this.registerDomEvent(root, "mousedown", (e) => {
			if (e.target !== this.inputEl) window.setTimeout(() => this.focus(), 0);
		});
		this.registerDomEvent(this.currentEl, "click", (e) => this.onRowClick(e, "current"));
		this.registerDomEvent(this.currentEl, "dblclick", (e) => this.onRowClick(e, "current", true));
		this.registerDomEvent(this.parentEl, "click", (e) => this.onRowClick(e, "parent"));
		this.registerDomEvent(this.previewEl, "click", (e) => this.onRowClick(e, "preview"));

		const ws = this.app.workspace;
		this.registerEvent(
			ws.on("active-leaf-change", (leaf) => {
				if (leaf === this.leaf) this.focus();
			}),
		);
		// Only re-render when our own size really changed (not while a sidebar is collapsed or animating).
		let lastSize = "";
		this.registerEvent(
			ws.on("resize", () => {
				const w = this.contentEl.clientWidth;
				const h = this.contentEl.clientHeight;
				if (!w || !h) return;
				const size = `${w}x${h}`;
				if (size === lastSize) return;
				lastSize = size;
				this.render();
			}),
		);
		const v = this.app.vault;
		this.registerEvent(v.on("create", () => this.scheduleRefresh()));
		this.registerEvent(v.on("delete", (f) => this.onDelete(f)));
		this.registerEvent(v.on("rename", (f, old) => this.onRename(f, old)));
		this.registerEvent(
			v.on("modify", (f) => {
				if (f === this.hovered()) this.previewKey = "";
				this.scheduleRefresh();
			}),
		);

		this.initialized = true;
		this.refresh();
	}

	async onClose() {
		this.previewComp?.unload();
		this.previewComp = null;
		this.searchToken++;
	}

	focus() {
		if (!this.sinkEl || this.prompting) return;
		this.sinkEl.focus({ preventScroll: true });
	}

	private ownsFocus(): boolean {
		const a = activeDocument.activeElement;
		return a === this.sinkEl || a === this.inputEl;
	}

	private isSidebar(): boolean {
		const root = this.leaf.getRoot();
		const ws = this.app.workspace;
		return root === ws.leftSplit || root === ws.rightSplit;
	}

	// =========================================================================
	// Data

	private getFolder(path: string): TFolder | null {
		return path === "" ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(path);
	}

	private absPath(p: string): string {
		const a = this.app.vault.adapter;
		if (a instanceof FileSystemAdapter) return p ? `${a.getBasePath()}/${p}` : a.getBasePath();
		return p;
	}

	private hovered(): TAbstractFile | undefined {
		return this.entries[this.cursor];
	}

	private visible(list: TAbstractFile[]): TAbstractFile[] {
		return this.showHidden ? list : list.filter((f) => !f.name.startsWith("."));
	}

	private sorted(list: TAbstractFile[]): TAbstractFile[] {
		const by = this.sortBy;
		if (by === "none") return this.sortReverse ? [...list].reverse() : [...list];
		const sens = this.sortSensitive;
		const name = (f: TAbstractFile) => (sens ? f.name : f.name.toLowerCase());
		const alpha = (a: TAbstractFile, b: TAbstractFile) => {
			const x = name(a);
			const y = name(b);
			return x < y ? -1 : x > y ? 1 : 0;
		};
		const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: sens ? "case" : "base" });
		const stat = (f: TAbstractFile, k: "mtime" | "ctime" | "size") =>
			f instanceof TFile ? f.stat[k] : k === "size" ? childCount(f) : 0;
		const ext = (f: TAbstractFile) => (f instanceof TFile ? f.extension.toLowerCase() : "");
		if (by === "random") {
			for (const f of list) if (!this.randomKeys.has(f.path)) this.randomKeys.set(f.path, Math.random());
		}
		const primary = (a: TAbstractFile, b: TAbstractFile): number => {
			switch (by) {
				case "mtime":
					return stat(a, "mtime") - stat(b, "mtime");
				case "btime":
					return stat(a, "ctime") - stat(b, "ctime");
				case "size":
					return stat(a, "size") - stat(b, "size");
				case "extension":
					return ext(a) < ext(b) ? -1 : ext(a) > ext(b) ? 1 : 0;
				case "natural":
					return collator.compare(a.name, b.name);
				case "random":
					return (this.randomKeys.get(a.path) ?? 0) - (this.randomKeys.get(b.path) ?? 0);
				default:
					return alpha(a, b);
			}
		};
		return [...list].sort((a, b) => {
			if (this.sortDirFirst) {
				const da = a instanceof TFolder ? 0 : 1;
				const db = b instanceof TFolder ? 0 : 1;
				if (da !== db) return da - db;
			}
			const r = primary(a, b) || alpha(a, b);
			return this.sortReverse ? -r : r;
		});
	}

	private listFolder(folder: TFolder | null): TAbstractFile[] {
		return folder ? this.sorted(this.visible(folder.children)) : [];
	}

	private displayName(f: TAbstractFile): string {
		if (this.search && this.cwd && f.path.startsWith(this.cwd + "/")) return f.path.slice(this.cwd.length + 1);
		if (this.search) return f.path;
		return f.name;
	}

	/** Recompute the entry list, keeping the hovered file where possible. */
	refresh() {
		if (!this.initialized) return;
		if (!this.getFolder(this.cwd)) this.cwd = this.nearestExisting(this.cwd);
		const keep = this.pendingHover ?? this.hovered()?.path ?? this.hoverMemo.get(this.cwd);
		const prevCursor = this.cursor;
		this.pendingHover = null;

		let list: TAbstractFile[];
		if (this.search) {
			const exists = (f: TAbstractFile) => this.app.vault.getAbstractFileByPath(f.path) === f;
			this.search.results = this.search.results.filter(exists);
			list = this.sorted(this.visible(this.search.results));
		} else list = this.listFolder(this.getFolder(this.cwd));
		if (this.filter) {
			const re = this.filter;
			list = list.filter((f) => re.test(this.displayName(f)));
		}
		this.entries = list;

		const idx = keep ? list.findIndex((f) => f.path === keep) : -1;
		this.cursor = idx >= 0 ? idx : Math.min(prevCursor, Math.max(0, list.length - 1));
		if (this.visual && this.visual.start >= list.length) this.visual.start = Math.max(0, list.length - 1);
		this.render();
	}

	private scheduleRefresh() {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refresh();
		}, 40);
	}

	private nearestExisting(p: string): string {
		let cur = p;
		while (cur && !this.getFolder(cur)) cur = parentOf(cur);
		return cur;
	}

	private onDelete(f: TAbstractFile) {
		this.selected.delete(f.path);
		if (this.yanked) {
			this.yanked.paths = this.yanked.paths.filter((p) => p !== f.path);
			if (!this.yanked.paths.length) this.yanked = null;
		}
		this.scheduleRefresh();
	}

	private onRename(f: TAbstractFile, oldPath: string) {
		const move = (p: string) =>
			p === oldPath ? f.path : p.startsWith(oldPath + "/") ? f.path + p.slice(oldPath.length) : p;
		this.selected = new Set([...this.selected].map(move));
		if (this.yanked) this.yanked.paths = this.yanked.paths.map(move);
		this.cwd = move(this.cwd);
		this.back = this.back.map(move);
		this.fwd = this.fwd.map(move);
		const h = this.hovered();
		if (h === f && !this.pendingHover) this.pendingHover = f.path;
		this.scheduleRefresh();
	}

	// =========================================================================
	// Rendering

	private ratio(): Ratio {
		if (this.ratioOverride) return this.ratioOverride;
		if (this.isSidebar()) {
			const parts = this.plugin.settings.sidebarRatio.split(",").map((s) => Number(s.trim()));
			if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0) && parts[1] > 0) {
				return parts as Ratio;
			}
		}
		return this.plugin.config.mgr.ratio;
	}

	private render() {
		if (!this.initialized) return;
		const [rp, rc, rv] = this.ratio();
		const setW = (el: HTMLElement, r: number) => {
			el.setCssProps({ "--yazi-grow": String(r) });
			el.toggleClass("is-hidden", r === 0);
		};
		setW(this.parentEl, rp);
		setW(this.currentEl, rc);
		setW(this.previewEl, rv);

		this.renderHeader();
		if (rp > 0) this.renderParent();
		this.renderCurrent();
		this.renderStatus();
		this.schedulePreview();
	}

	private renderHeader() {
		const h = this.headerEl;
		h.empty();
		const vault = this.app.vault.getName();
		h.createSpan({ cls: "yazi-header-path", text: this.cwd ? `${vault}/${this.cwd}` : vault });
		const tags: string[] = [];
		if (this.search) tags.push(`search: ${this.search.query}${this.search.running ? " …" : ""}`);
		if (this.filter) tags.push(`filter: ${this.filterText}`);
		for (const t of tags) h.createSpan({ cls: "yazi-header-tag", text: ` (${t})` });
	}

	private row(parent: HTMLElement, f: TAbstractFile, name: string): HTMLElement {
		const el = parent.createDiv({ cls: "yazi-row" });
		el.toggleClass("is-dir", f instanceof TFolder);
		const icon = el.createSpan({ cls: "yazi-icon" });
		setIcon(icon, fileIcon(f));
		el.createSpan({ cls: "yazi-name", text: name });
		return el;
	}

	private parentSig = "";
	private currentSig = "";

	/** Rebuild rows only when the listing itself changes; otherwise just update classes. */
	private renderParent() {
		const el = this.parentEl;
		const parentPath = this.search ? this.cwd : parentOf(this.cwd);
		const list = !this.cwd && !this.search ? [] : this.search ? [] : this.listFolder(this.getFolder(parentPath));
		const sig = parentPath + "\n" + list.map((f) => f.path).join("\n");
		if (sig !== this.parentSig || !el.firstChild) {
			this.parentSig = sig;
			el.empty();
			const listEl = el.createDiv({ cls: "yazi-list" });
			list.forEach((f, i) => {
				this.row(listEl, f, f.name).dataset.index = String(i);
			});
		}
		const listEl = el.firstElementChild as HTMLElement | null;
		if (!listEl) return;
		let hoveredRow: HTMLElement | null = null;
		list.forEach((f, i) => {
			const r = listEl.children[i] as HTMLElement | undefined;
			if (!r) return;
			const on = f.path === this.cwd;
			r.toggleClass("is-hovered", on);
			if (on) hoveredRow = r;
		});
		if (hoveredRow) this.scrollIntoView(listEl, hoveredRow);
	}

	private visualRange(): [number, number] | null {
		if (!this.visual) return null;
		return [Math.min(this.visual.start, this.cursor), Math.max(this.visual.start, this.cursor)];
	}

	private isSelectedIndex(i: number): boolean {
		const f = this.entries[i];
		const range = this.visualRange();
		if (range && i >= range[0] && i <= range[1]) return !this.visual!.unset;
		return this.selected.has(f.path);
	}

	private renderCurrent() {
		const el = this.currentEl;
		let sig: string;
		if (!this.entries.length) {
			sig = "empty:" + (this.search?.running ? "Searching…" : this.filter || this.search ? "No matches" : "Empty");
		} else {
			sig = this.entries
				.map((f) => `${f.path}|${this.displayName(f)}|${this.linemodeText(f)}|${f instanceof TFolder ? 1 : 0}`)
				.join("\n");
		}
		if (sig !== this.currentSig || !el.firstChild) {
			this.currentSig = sig;
			el.empty();
			const listEl = el.createDiv({ cls: "yazi-list" });
			if (!this.entries.length) {
				listEl.createDiv({ cls: "yazi-empty", text: sig.slice("empty:".length) });
				return;
			}
			this.entries.forEach((f, i) => {
				const r = this.row(listEl, f, this.displayName(f));
				r.dataset.index = String(i);
				const lm = this.linemodeText(f);
				if (lm) r.createSpan({ cls: "yazi-linemode", text: lm });
			});
		}
		if (!this.entries.length) return;
		const listEl = el.firstElementChild as HTMLElement | null;
		if (!listEl) return;
		const yanked = new Set(this.yanked?.paths ?? []);
		const range = this.visualRange();
		const unset = this.visual?.unset ?? false;
		let hoveredRow: HTMLElement | null = null;
		this.entries.forEach((f, i) => {
			const r = listEl.children[i] as HTMLElement | undefined;
			if (!r) return;
			const inRange = !!range && i >= range[0] && i <= range[1];
			r.toggleClass("is-hovered", i === this.cursor);
			r.toggleClass("is-selected", this.isSelectedIndex(i));
			r.toggleClass("is-visual", inRange && !unset);
			r.toggleClass("is-visual-unset", inRange && unset);
			r.toggleClass("is-copied", yanked.has(f.path) && !this.yanked?.cut);
			r.toggleClass("is-cut", yanked.has(f.path) && !!this.yanked?.cut);
			r.toggleClass("is-found", !!this.find && this.find.test(this.displayName(f)));
			if (i === this.cursor) hoveredRow = r;
		});
		if (hoveredRow) this.scrollIntoView(listEl, hoveredRow);
	}

	private linemodeText(f: TAbstractFile): string {
		switch (this.linemode) {
			case "size":
				return f instanceof TFile ? readableSize(f.stat.size) : String(childCount(f));
			case "mtime":
				return f instanceof TFile ? formatTime(f.stat.mtime) : "";
			case "btime":
				return f instanceof TFile ? formatTime(f.stat.ctime) : "";
			default:
				return "";
		}
	}

	private scrollIntoView(container: HTMLElement, row: HTMLElement) {
		const rh = row.offsetHeight || 22;
		const visibleRows = Math.max(1, Math.floor(container.clientHeight / rh));
		const off = Math.min(this.plugin.config.mgr.scrolloff, Math.floor((visibleRows - 1) / 2)) * rh;
		const top = row.offsetTop;
		if (top - off < container.scrollTop) container.scrollTop = Math.max(0, top - off);
		else if (top + rh + off > container.scrollTop + container.clientHeight) {
			container.scrollTop = top + rh + off - container.clientHeight;
		}
	}

	private renderStatus() {
		const s = this.statusEl;
		s.empty();
		const mode = this.visual ? (this.visual.unset ? "UNS" : "SEL") : "NOR";
		s.createSpan({ cls: `yazi-mode yazi-mode-${mode.toLowerCase()}`, text: mode });
		const h = this.hovered();
		if (h) {
			const size = h instanceof TFile ? readableSize(h.stat.size) : String(childCount(h));
			s.createSpan({ cls: "yazi-status-size", text: size });
			s.createSpan({ cls: "yazi-status-name", text: h.name });
		}
		const right = s.createSpan({ cls: "yazi-status-right" });
		if (this.selected.size) right.createSpan({ cls: "yazi-count-selected", text: ` ${this.selected.size} ` });
		if (this.yanked) {
			right.createSpan({
				cls: this.yanked.cut ? "yazi-count-cut" : "yazi-count-copied",
				text: ` ${this.yanked.paths.length} `,
			});
		}
		if (this.pending.length) right.createSpan({ cls: "yazi-pending", text: this.pending.join("") });
		right.createSpan({
			cls: "yazi-position",
			text: this.entries.length ? `${this.cursor + 1}/${this.entries.length}` : "0/0",
		});
	}

	private schedulePreview() {
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = window.setTimeout(() => {
			this.previewTimer = null;
			void this.renderPreview();
		}, 25);
	}

	private async renderPreview() {
		const el = this.previewEl;
		const h = this.hovered();
		if (this.ratio()[2] === 0) {
			this.clearPreview();
			return;
		}
		const key = h
			? `${h.path}|${h instanceof TFile ? h.stat.mtime : childCount(h)}|${this.showHidden}|${this.sortBy}|${this.sortReverse}`
			: "";
		if (key === this.previewKey) return;
		this.clearPreview();
		this.previewKey = key;
		if (!h) return;

		if (h instanceof TFolder) {
			const list = el.createDiv({ cls: "yazi-list" });
			const items = this.listFolder(h);
			if (!items.length) list.createDiv({ cls: "yazi-empty", text: "Empty" });
			for (const f of items) this.row(list, f, f.name).dataset.path = f.path;
			return;
		}
		if (!(h instanceof TFile)) return;
		const file = h;
		const ext = file.extension.toLowerCase();
		if (IMAGE_EXT.has(ext)) {
			el.createDiv({ cls: "yazi-preview-image" }).createEl("img", {
				attr: { src: this.app.vault.getResourcePath(file) },
			});
			return;
		}
		if (TEXT_EXT.has(ext)) {
			const text = await this.app.vault.cachedRead(file);
			if (this.previewKey !== key) return;
			const body = text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS) : text;
			if (ext === "md" && this.plugin.settings.markdownPreview === "rendered") {
				const box = el.createDiv({ cls: "yazi-preview-md markdown-rendered" });
				const comp = new Component();
				comp.load();
				this.previewComp = comp;
				await MarkdownRenderer.render(this.app, body, box, file.path, comp);
			} else {
				el.createEl("pre", { cls: "yazi-preview-text", text: body });
			}
			return;
		}
		const info = el.createDiv({ cls: "yazi-preview-info" });
		info.createDiv({ text: file.name });
		info.createDiv({ text: readableSize(file.stat.size) });
		info.createDiv({ text: new Date(file.stat.mtime).toLocaleString() });
	}

	private clearPreview() {
		this.previewComp?.unload();
		this.previewComp = null;
		this.previewEl.empty();
		this.previewEl.scrollTop = 0;
		this.previewKey = "";
	}

	private onRowClick(e: MouseEvent, pane: "current" | "parent" | "preview", dbl = false) {
		const t = e.targetNode;
		const row = t?.instanceOf(HTMLElement) ? t.closest<HTMLElement>(".yazi-row") : null;
		if (!row) return;
		if (pane === "current") {
			const i = Number(row.dataset.index);
			if (!Number.isFinite(i)) return;
			this.commitVisual();
			this.cursor = i;
			this.render();
			if (dbl) void this.smartEnter();
		} else if (pane === "parent") {
			const parentPath = parentOf(this.cwd);
			const f = this.listFolder(this.getFolder(parentPath))[Number(row.dataset.index)];
			if (f instanceof TFolder) this.cd(f.path);
			else if (f) this.reveal(f.path);
		} else if (row.dataset.path) {
			this.reveal(row.dataset.path);
		}
	}

	// =========================================================================
	// Keyboard

	private handleKeyEvent(evt: KeyboardEvent) {
		if (this.handledEvents.has(evt) || evt.isComposing) return;
		this.handledEvents.add(evt);

		if (this.prompting) {
			if (evt.key === "Enter") {
				evt.preventDefault();
				evt.stopPropagation();
				this.closePrompt(true);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				this.closePrompt(false);
			}
			return;
		}
		if (activeDocument.activeElement !== this.sinkEl) return;

		const key = eventToKey(evt, this.plugin.settings.keyMode);
		if (!key) return;
		let handled = true;
		if (this.overlay) handled = this.overlay.onKey(key);
		else if (this.awaitChar) {
			const cb = this.awaitChar;
			this.awaitChar = null;
			// The character itself matters here (e.g. a non-Latin file name), not its key position.
			const typed = [...evt.key].length === 1 && !evt.ctrlKey && !evt.metaKey && !evt.altKey ? evt.key : key;
			if (key !== "<Esc>") cb(typed);
		} else handled = this.feed(key);

		const plain = !evt.metaKey && !evt.ctrlKey && !evt.altKey;
		if (handled || plain) {
			evt.preventDefault();
			evt.stopPropagation();
		}
	}

	/** Yazi's key matching: the first binding whose first key matches decides. */
	private feed(key: string): boolean {
		const bindings = this.plugin.config.bindings;
		if (!this.pending.length) {
			const first = bindings.find((b) => b.on[0] === key);
			if (!first) return false;
			if (first.on.length === 1) {
				void this.runBinding(first);
				return true;
			}
			this.pending = [key];
			this.candidates = bindings.filter((b) => b.on.length > 1 && b.on[0] === key);
			this.showWhich();
			return true;
		}
		if (key === "<Esc>" || key === "<C-[>" || key === "<C-c>") {
			this.cancelPending();
			return true;
		}
		const n = this.pending.length;
		const next = this.candidates.filter((b) => b.on[n] === key);
		if (!next.length) {
			this.cancelPending();
			return true;
		}
		const done = next.find((b) => b.on.length === n + 1);
		if (done) {
			this.cancelPending();
			void this.runBinding(done);
			return true;
		}
		this.pending.push(key);
		this.candidates = next.filter((b) => b.on.length > n + 1);
		this.showWhich();
		return true;
	}

	private cancelPending() {
		this.pending = [];
		this.candidates = [];
		this.whichEl?.hide();
		if (this.initialized) this.renderStatus();
	}

	private showWhich() {
		const w = this.whichEl;
		w.empty();
		const n = this.pending.length;
		const seen = new Set<string>();
		const grid = w.createDiv({ cls: "yazi-which-grid" });
		for (const b of this.candidates) {
			const rest = b.on.slice(n).join(" ");
			if (seen.has(rest)) continue;
			seen.add(rest);
			const item = grid.createDiv({ cls: "yazi-which-item" });
			item.createSpan({ cls: "yazi-which-key", text: rest });
			item.createSpan({ cls: "yazi-which-desc", text: b.desc || b.run.join("; ") });
		}
		w.show();
		this.renderStatus();
	}

	private async runBinding(b: Binding) {
		for (const r of b.run) {
			try {
				await this.exec(parseCmd(r));
			} catch (e) {
				console.error("[yazi-fm]", r, e);
				new Notice(`Yazi: ${r} failed: ${(e as Error).message}`);
				break;
			}
		}
	}

	// =========================================================================
	// Commands

	async exec(c: Cmd): Promise<void> {
		switch (c.name) {
			case "noop":
			case "suspend":
				return;
			case "escape":
				return this.cmdEscape(c);
			case "quit":
			case "close":
				return this.quit();
			case "arrow":
				return this.arrow(c.args[0] ?? "0");
			case "leave":
				return this.leave();
			case "enter":
				return this.enter();
			case "back":
				return this.history(-1);
			case "forward":
				return this.history(1);
			case "toggle":
				return this.toggle(c.opts.state);
			case "toggle_all":
				return this.toggleAll(c.opts.state);
			case "visual_mode":
				return this.visualMode(!!c.opts.unset);
			case "seek":
				this.previewEl.scrollTop += Number(c.args[0] ?? 0) * this.lineHeight();
				return;
			case "spot":
				return this.spot();
			case "open":
				return this.openCmd(c);
			case "yank":
				return this.yank(!!c.opts.cut);
			case "unyank":
				this.yanked = null;
				this.render();
				return;
			case "paste":
				return this.paste(!!c.opts.force);
			case "remove":
				return this.remove(c);
			case "create":
				return this.create(c);
			case "rename":
				return this.rename(c);
			case "shell":
				return this.shell(c);
			case "hidden": {
				const a = c.args[0] ?? "toggle";
				this.showHidden = a === "show" ? true : a === "hide" ? false : !this.showHidden;
				this.refresh();
				return;
			}
			case "search":
				return this.searchCmd(c);
			case "filter":
				return this.filterCmd(c);
			case "find":
				return this.findCmd(c);
			case "find_arrow":
				return this.findArrow(!!c.opts.previous);
			case "sort":
				return this.sortCmd(c);
			case "linemode":
				this.linemode = (c.args[0] as Linemode) ?? "none";
				this.render();
				return;
			case "copy":
				return this.copy(c);
			case "cd":
				return this.cdCmd(c);
			case "reveal": {
				const p = this.resolvePath(c.args.join(" "));
				if (p !== null) this.reveal(p);
				return;
			}
			case "help":
				return this.help();
			case "plugin":
				return this.pluginCmd(c);
			case "obsidian": {
				const id = c.args[0];
				if (id && !appInternals(this.app).commands?.executeCommandById?.(id)) {
					new Notice(`Yazi: unknown Obsidian command ${id}`);
				}
				return;
			}
			case "tab_switch":
			case "tab_swap":
			case "tab_rename":
			case "tab_close":
				return;
			case "tab_create":
				void this.plugin.open("tab", true);
				return;
			default:
				new Notice(`Yazi: “${c.name}” is not supported in Obsidian`);
		}
	}

	private lineHeight(): number {
		return parseFloat(getComputedStyle(this.previewEl).lineHeight) || 20;
	}

	private cmdEscape(c: Cmd) {
		const all = !!c.opts.all;
		const explicit = all || c.opts.find || c.opts.visual || c.opts.select || c.opts.filter || c.opts.search;
		const steps: [boolean | string | undefined, () => boolean][] = [
			[c.opts.find, () => (this.find ? ((this.find = null), true) : false)],
			[c.opts.visual, () => (this.visual ? (this.exitVisual(), true) : false)],
			[c.opts.select, () => (this.selected.size ? (this.selected.clear(), true) : false)],
			[c.opts.filter, () => (this.filter ? (this.clearFilter(), true) : false)],
			[c.opts.search, () => (this.search ? (this.cancelSearch(), true) : false)],
		];
		for (const [flag, fn] of steps) {
			if (explicit) {
				if (all || flag) fn();
			} else if (fn()) break;
		}
		this.refresh();
	}

	private arrow(step: string) {
		const n = this.entries.length;
		if (!n) return;
		let c = this.cursor;
		const rh = this.currentEl.querySelector<HTMLElement>(".yazi-row")?.offsetHeight || 24;
		const list = this.currentEl.querySelector<HTMLElement>(".yazi-list");
		const rows = Math.max(1, Math.floor((list?.clientHeight ?? this.currentEl.clientHeight) / rh));
		if (step === "top") c = 0;
		else if (step === "bot") c = n - 1;
		else if (step === "prev") c = c === 0 ? n - 1 : c - 1;
		else if (step === "next") c = c === n - 1 ? 0 : c + 1;
		else if (step.endsWith("vp")) {
			const first = list ? Math.floor(list.scrollTop / rh) : 0;
			c = first + Math.round(((rows - 1) * Number(step.slice(0, -2))) / 100);
		} else if (step.endsWith("%")) c += Math.trunc((rows * Number(step.slice(0, -1))) / 100);
		else c += Number(step) || 0;
		this.cursor = Math.max(0, Math.min(n - 1, c));
		this.render();
	}

	private cd(path: string, opts: { hover?: string; history?: boolean } = {}) {
		if (!this.getFolder(path)) {
			new Notice(`Yazi: no such folder ${path}`);
			return;
		}
		const changing = path !== this.cwd || !!this.search;
		if (changing) {
			const h = this.hovered();
			if (h && !this.search) this.hoverMemo.set(this.cwd, h.path);
			if (opts.history !== false && path !== this.cwd) {
				this.back.push(this.cwd);
				this.fwd = [];
			}
			this.exitVisual();
			this.find = null;
			this.filter = null;
			this.filterText = "";
			this.cancelSearch();
			this.cwd = path;
			this.cursor = 0;
		}
		this.pendingHover = opts.hover ?? this.hoverMemo.get(path) ?? null;
		this.refresh();
		this.app.workspace.requestSaveLayout();
	}

	/** Go to the folder containing `path` and hover it. */
	reveal(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!f) return;
		this.cd(f.parent && !f.parent.isRoot() ? f.parent.path : "", { hover: f.path });
	}

	revealPath(path: string) {
		if (!this.initialized) {
			this.cwd = parentOf(path);
			this.pendingHover = path;
			return;
		}
		this.reveal(path);
	}

	private leave() {
		if (this.search) {
			this.cancelSearch();
			this.refresh();
			return;
		}
		if (!this.cwd) return;
		this.cd(parentOf(this.cwd), { hover: this.cwd });
	}

	private enter() {
		const h = this.hovered();
		if (h instanceof TFolder) this.cd(h.path);
	}

	private async smartEnter() {
		const h = this.hovered();
		if (h instanceof TFolder) this.cd(h.path);
		else if (h instanceof TFile) await this.openFiles([h], "default");
	}

	private history(dir: -1 | 1) {
		const from = dir < 0 ? this.back : this.fwd;
		const to = dir < 0 ? this.fwd : this.back;
		while (from.length) {
			const p = from.pop()!;
			if (!this.getFolder(p)) continue;
			to.push(this.cwd);
			this.cd(p, { history: false });
			return;
		}
	}

	// --- selection -----------------------------------------------------------

	private toggle(state: string | true | undefined) {
		const h = this.hovered();
		if (!h) return;
		const on = state === "on" ? true : state === "off" ? false : !this.selected.has(h.path);
		if (on) this.selected.add(h.path);
		else this.selected.delete(h.path);
		this.render();
	}

	private toggleAll(state: string | true | undefined) {
		for (const f of this.entries) {
			const on = state === "on" ? true : state === "off" ? false : !this.selected.has(f.path);
			if (on) this.selected.add(f.path);
			else this.selected.delete(f.path);
		}
		this.render();
	}

	private visualMode(unset: boolean) {
		if (this.visual) this.commitVisual();
		else if (this.entries.length) this.visual = { start: this.cursor, unset };
		this.render();
	}

	private commitVisual() {
		const range = this.visualRange();
		if (!range || !this.visual) return;
		for (let i = range[0]; i <= range[1]; i++) {
			const p = this.entries[i]?.path;
			if (!p) continue;
			if (this.visual.unset) this.selected.delete(p);
			else this.selected.add(p);
		}
		this.visual = null;
	}

	private exitVisual() {
		this.commitVisual();
	}

	/** Selected files (visual range included), or the hovered file. */
	private targets(hoveredOnly = false): TAbstractFile[] {
		this.commitVisual();
		const h = this.hovered();
		if (hoveredOnly || !this.selected.size) return h ? [h] : [];
		const out: TAbstractFile[] = [];
		for (const p of this.selected) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (f) out.push(f);
		}
		return out;
	}

	// --- file operations -----------------------------------------------------

	private yank(cut: boolean) {
		const t = this.targets();
		if (!t.length) return;
		this.yanked = { paths: t.map((f) => f.path), cut };
		this.selected.clear();
		this.render();
	}

	private uniquePath(dir: string, name: string): string {
		const [stem, ext] = splitExt(name);
		for (let i = 1; ; i++) {
			const p = joinPath(dir, `${stem}_${i}${ext}`);
			if (!this.app.vault.getAbstractFileByPath(p)) return p;
		}
	}

	private async paste(force: boolean) {
		if (!this.yanked) return;
		const { paths, cut } = this.yanked;
		const dest = this.cwd;
		let last: string | null = null;
		for (const p of paths) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (!f) continue;
			if (f instanceof TFolder && (dest === f.path || dest.startsWith(f.path + "/"))) {
				new Notice(`Yazi: cannot paste ${f.name} into itself`);
				continue;
			}
			let target = joinPath(dest, f.name);
			const existing = this.app.vault.getAbstractFileByPath(target);
			if (existing === f) {
				if (cut) continue;
				target = this.uniquePath(dest, f.name);
			} else if (existing) {
				if (force) await this.app.fileManager.trashFile(existing);
				else target = this.uniquePath(dest, f.name);
			}
			if (cut) await this.app.fileManager.renameFile(f, target);
			else await this.app.vault.copy(f, target);
			last = target;
		}
		if (cut) this.yanked = null;
		if (last) this.pendingHover = last;
		this.refresh();
	}

	private async remove(c: Cmd) {
		const t = this.targets(!!c.opts.hovered);
		if (!t.length) return;
		const permanently = !!c.opts.permanently;
		if (!c.opts.force) {
			const s = t.length === 1 ? "" : "s";
			const title = permanently
				? `Permanently delete ${t.length} selected file${s}?`
				: `Trash ${t.length} selected file${s}?`;
			if (!(await this.confirm(title, t.map((f) => f.path)))) return;
		}
		for (const f of t) {
			if (permanently) await this.app.vault.delete(f, true);
			else await this.app.fileManager.trashFile(f);
			this.selected.delete(f.path);
		}
		this.refresh();
	}

	private async ensureFolder(path: string) {
		if (!path || this.app.vault.getFolderByPath(path)) return;
		await this.ensureFolder(parentOf(path));
		await this.app.vault.createFolder(path);
	}

	private create(c: Cmd) {
		this.prompt({
			title: c.opts.dir ? "Create (dir):" : "Create:",
			onSubmit: async (value) => {
				if (!value.trim()) return;
				const isDir = !!c.opts.dir || value.endsWith("/");
				const path = joinPath(this.cwd, value.replace(/\/+$/, ""));
				const existing = this.app.vault.getAbstractFileByPath(path);
				if (isDir) {
					if (existing) {
						new Notice(`Yazi: ${path} already exists`);
						return;
					}
					await this.ensureFolder(path);
				} else {
					if (existing instanceof TFolder) {
						new Notice(`Yazi: ${path} is a folder`);
						return;
					}
					if (existing instanceof TFile) {
						if (!c.opts.force && !(await this.confirm("Overwrite file?", [path]))) return;
						await this.app.vault.modify(existing, "");
					} else {
						await this.ensureFolder(parentOf(path));
						await this.app.vault.create(path, "");
					}
				}
				this.pendingHover = this.topLevelUnderCwd(path);
				this.refresh();
			},
		});
	}

	/** For "a/b/c.md" created in cwd, hover "a" (what is visible in the listing). */
	private topLevelUnderCwd(path: string): string {
		const rel = this.cwd ? path.slice(this.cwd.length + 1) : path;
		const first = rel.split("/")[0];
		return joinPath(this.cwd, first);
	}

	private rename(c: Cmd) {
		const t = this.targets(!!c.opts.hovered);
		if (t.length > 1) {
			new Notice("Yazi: bulk rename is not supported, rename files one by one");
			return;
		}
		const f = t[0];
		if (!f) return;
		const [stem, ext] = f instanceof TFile ? splitExt(f.name) : [f.name, ""];
		let value = f.name;
		switch (c.opts.empty) {
			case "stem":
				value = ext;
				break;
			case "ext":
				value = ext ? `${stem}.` : stem;
				break;
			case "dot_ext":
				value = stem;
				break;
			case "all":
				value = "";
				break;
		}
		let cursor = value.length;
		if (c.opts.cursor === "start") cursor = 0;
		else if (c.opts.cursor === "before_ext") {
			const [s2, e2] = f instanceof TFile ? splitExt(value) : [value, ""];
			cursor = e2 ? s2.length : value.length;
		}
		this.prompt({
			title: "Rename:",
			value,
			cursor,
			onSubmit: async (name) => {
				name = name.trim();
				if (!name || name === f.name) return;
				const dir = f.parent && !f.parent.isRoot() ? f.parent.path : "";
				const target = joinPath(dir, name);
				const existing = this.app.vault.getAbstractFileByPath(target);
				if (existing && existing !== f) {
					if (!c.opts.force && !(await this.confirm("Overwrite file?", [target]))) return;
					await this.app.fileManager.trashFile(existing);
				}
				await this.ensureFolder(parentOf(target));
				await this.app.fileManager.renameFile(f, target);
				this.pendingHover = target;
				this.refresh();
			},
		});
	}

	private async copy(c: Cmd) {
		const what = c.args[0] ?? "path";
		const files = this.targets(!!c.opts.hovered);
		if (!files.length) return;
		const dirOf = (f: TAbstractFile) => (f.parent && !f.parent.isRoot() ? f.parent.path : "");
		const url = (p: string) => "file://" + encodeURI(p);
		const pick = (f: TAbstractFile): string => {
			switch (what) {
				case "url":
					return url(this.absPath(f.path));
				case "dirpath":
					return this.absPath(dirOf(f));
				case "dirurl":
					return url(this.absPath(dirOf(f)));
				case "filename":
					return f.name;
				case "name_without_ext":
					return f instanceof TFile ? f.basename : f.name;
				case "vault_path":
					return f.path;
				case "wikilink":
					return f instanceof TFile ? this.app.fileManager.generateMarkdownLink(f, "") : f.path;
				default:
					return this.absPath(f.path);
			}
		};
		const text = files.map(pick).join("\n");
		await navigator.clipboard.writeText(text);
		new Notice(`Copied ${files.length > 1 ? `${files.length} items` : text}`, 1500);
	}

	// --- opening -------------------------------------------------------------

	private isViewable(f: TFile): boolean {
		const reg = appInternals(this.app).viewRegistry;
		if (reg?.isExtensionRegistered) return reg.isExtensionRegistered(f.extension);
		return ["md", "canvas", "pdf", ...IMAGE_EXT].includes(f.extension.toLowerCase());
	}

	private electronShell(): ElectronShell | null {
		if (!Platform.isDesktopApp) return null;
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		const mod = req?.("electron") as { shell?: ElectronShell } | undefined;
		return mod?.shell ?? null;
	}

	private mainLeaf(): WorkspaceLeaf {
		const ws = this.app.workspace;
		if (this.plugin.settings.openIn === "new-tab") return ws.getLeaf("tab");
		const recent = ws.getMostRecentLeaf(ws.rootSplit);
		if (recent && recent !== this.leaf && !(recent.view instanceof YaziView)) return recent;
		return ws.getLeaf("tab");
	}

	private async openFiles(files: TFile[], how: "default" | "tab" | "split" | "window" | "system" | "finder") {
		const ws = this.app.workspace;
		const focus = this.plugin.settings.focusFileAfterOpen;
		let lastLeaf: WorkspaceLeaf | null = null;
		for (const [i, f] of files.entries()) {
			if (how === "system" || how === "finder" || (how === "default" && !this.isViewable(f))) {
				const sh = this.electronShell();
				if (!sh) {
					new Notice("Yazi: not available on this platform");
					return;
				}
				if (how === "finder") sh.showItemInFolder(this.absPath(f.path));
				else await sh.openPath(this.absPath(f.path));
				continue;
			}
			const leaf =
				how === "split"
					? ws.getLeaf("split")
					: how === "window"
						? ws.getLeaf("window")
						: how === "tab" || i > 0
							? ws.getLeaf("tab")
							: this.mainLeaf();
			await leaf.openFile(f, { active: false });
			lastLeaf = leaf;
		}
		if (lastLeaf && this.plugin.settings.collapseSidebarOnOpen && this.isSidebar()) {
			this.collapseSidebar();
			ws.setActiveLeaf(lastLeaf, { focus: true });
			return;
		}
		if (lastLeaf && focus) ws.setActiveLeaf(lastLeaf, { focus: true });
		else this.focus();
	}

	private collapseSidebar() {
		const ws = this.app.workspace;
		if (this.leaf.getRoot() === ws.leftSplit) ws.leftSplit.collapse();
		else ws.rightSplit.collapse();
	}

	private async openCmd(c: Cmd) {
		const t = this.targets(!!c.opts.hovered);
		if (!t.length) return;
		const files = t.filter((f): f is TFile => f instanceof TFile);
		if (!c.opts.interactive) {
			if (!files.length && t[0] instanceof TFolder) {
				this.cd(t[0].path);
				return;
			}
			// Obsidian extensions: open --tab / --split / --window
			const how = c.opts.tab ? "tab" : c.opts.split ? "split" : c.opts.window ? "window" : "default";
			await this.openFiles(files, how);
			return;
		}
		if (!files.length) return;
		const items: [string, () => void][] = [
			["Open", () => void this.openFiles(files, "default")],
			["Open in new tab", () => void this.openFiles(files, "tab")],
			["Open to the right", () => void this.openFiles(files, "split")],
			["Open in new window", () => void this.openFiles(files, "window")],
		];
		if (Platform.isDesktopApp) {
			items.push(["Open with default app", () => void this.openFiles(files, "system")]);
			items.push([Platform.isMacOS ? "Reveal in Finder" : "Show in system explorer", () => void this.openFiles(files, "finder")]);
		}
		this.picker(`Open ${files.length > 1 ? `${files.length} files` : files[0].name} with:`, items);
	}

	private async quit() {
		const ws = this.app.workspace;
		if (this.isSidebar()) {
			this.collapseSidebar();
			const recent = ws.getMostRecentLeaf(ws.rootSplit);
			if (recent) ws.setActiveLeaf(recent, { focus: true });
		} else {
			this.leaf.detach();
		}
	}

	// --- search / filter / find ------------------------------------------------

	private clearFilter() {
		this.filter = null;
		this.filterText = "";
	}

	private cancelSearch() {
		this.searchToken++;
		this.search = null;
	}

	private filterCmd(c: Cmd) {
		const before = this.filterText;
		const mode = matchMode(c);
		const apply = (v: string) => {
			this.filterText = v;
			this.filter = v ? smartRegex(v, mode) : null;
			this.refresh();
		};
		this.prompt({
			title: "Filter:",
			value: before,
			onChange: apply,
			onSubmit: apply,
			onCancel: () => apply(""),
		});
	}

	private findCmd(c: Cmd) {
		const prev = !!c.opts.previous;
		const mode = matchMode(c);
		const origin = this.cursor;
		this.prompt({
			title: prev ? "Find previous:" : "Find next:",
			onChange: (v) => {
				this.find = v ? smartRegex(v, mode) : null;
				this.cursor = origin;
				if (this.find) this.jumpToMatch(prev, true);
				else this.render();
			},
			onSubmit: (v) => {
				this.find = v ? smartRegex(v, mode) : null;
				this.render();
			},
			onCancel: () => {
				this.find = null;
				this.cursor = origin;
				this.render();
			},
		});
	}

	private jumpToMatch(previous: boolean, includeCurrent = false) {
		const re = this.find;
		const n = this.entries.length;
		if (!re || !n) return;
		for (let k = includeCurrent ? 0 : 1; k <= n; k++) {
			const i = (((this.cursor + (previous ? -k : k)) % n) + n) % n;
			if (re.test(this.displayName(this.entries[i]))) {
				this.cursor = i;
				break;
			}
		}
		this.render();
	}

	private findArrow(previous: boolean) {
		this.jumpToMatch(previous);
	}

	private searchCmd(c: Cmd) {
		const via = typeof c.opts.via === "string" ? c.opts.via : (c.args[0] ?? "fd");
		if (via !== "fd" && via !== "rg" && via !== "rga") {
			new Notice(`Yazi: search via ${via} is not supported`);
			return;
		}
		this.prompt({
			title: `Search via ${via}:`,
			onSubmit: (q) => void this.runSearch(q, via),
		});
	}

	private async runSearch(query: string, via: string) {
		const token = ++this.searchToken;
		const base = this.getFolder(this.cwd);
		if (!base) return;
		const re = smartRegex(query);
		const all: TAbstractFile[] = [];
		const walk = (folder: TFolder) => {
			for (const ch of folder.children) {
				if (!this.showHidden && ch.name.startsWith(".")) continue;
				all.push(ch);
				if (ch instanceof TFolder) walk(ch);
			}
		};
		walk(base);
		this.find = null;
		this.clearFilter();
		this.exitVisual();
		const h = this.hovered();
		if (h && !this.search) this.hoverMemo.set(this.cwd, h.path);
		this.search = { query, via, results: [], running: true };
		this.cursor = 0;

		if (via === "fd") {
			this.search.results = query ? all.filter((f) => re.test(f.name)) : all;
			this.search.running = false;
			this.refresh();
			return;
		}
		this.refresh();
		const files = all.filter((f): f is TFile => f instanceof TFile && TEXT_EXT.has(f.extension.toLowerCase()));
		const found: TAbstractFile[] = [];
		let lastPaint = Date.now();
		for (const f of files) {
			if (token !== this.searchToken) return;
			const text = await this.app.vault.cachedRead(f);
			if (re.test(text)) {
				found.push(f);
				if (Date.now() - lastPaint > 150 && this.search) {
					this.search.results = [...found];
					this.refresh();
					lastPaint = Date.now();
				}
			}
		}
		if (token !== this.searchToken || !this.search) return;
		this.search.results = found;
		this.search.running = false;
		this.refresh();
	}

	private sortCmd(c: Cmd) {
		const by = c.args[0] as SortBy | undefined;
		if (by) this.sortBy = by;
		const rev = optBool(c.opts.reverse);
		if (rev !== undefined) this.sortReverse = rev;
		const df = optBool(c.opts["dir-first"] ?? c.opts.dir_first);
		if (df !== undefined) this.sortDirFirst = df;
		const sens = optBool(c.opts.sensitive);
		if (sens !== undefined) this.sortSensitive = sens;
		if (by === "random") this.randomKeys.clear();
		this.refresh();
	}

	// --- cd / paths ----------------------------------------------------------

	/** Map a Yazi path argument to a vault path. Returns null if it is outside the vault. */
	private resolvePath(raw: string): string | null {
		let p = raw.trim();
		if (!p || p === "~" || p === "/") return "";
		const home = Platform.isDesktopApp ? homedir() : "";
		if (p.startsWith("~/") && home) p = home + p.slice(1);
		if (p.startsWith("/")) {
			const base = this.absPath("");
			if (p === base || p === base + "/") return "";
			if (p.startsWith(base + "/")) return normalizePath(p.slice(base.length + 1));
			new Notice(`Yazi: ${raw} is outside the vault`);
			return null;
		}
		const parts = (this.cwd ? this.cwd.split("/") : []).concat(p.split("/"));
		const out: string[] = [];
		for (const part of parts) {
			if (!part || part === ".") continue;
			if (part === "..") out.pop();
			else out.push(part);
		}
		return out.join("/");
	}

	private cdCmd(c: Cmd) {
		const go = (raw: string) => {
			const p = this.resolvePath(raw);
			if (p === null) return;
			const f = p === "" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFolder) this.cd(f.isRoot() ? "" : f.path);
			else if (f) this.reveal(f.path);
			else new Notice(`Yazi: ${raw} not found`);
		};
		if (c.opts.interactive) this.prompt({ title: "Change directory:", onSubmit: go });
		else go(c.args.join(" "));
	}

	// --- shell -----------------------------------------------------------------

	private shell(c: Cmd) {
		if (!Platform.isDesktopApp) {
			new Notice("Yazi: shell commands need the desktop app");
			return;
		}
		if (c.opts.block) {
			new Notice("Yazi: blocking shell commands need a terminal, they are not supported in Obsidian");
			return;
		}
		const template = c.args.join(" ");
		if (c.opts.interactive) {
			this.prompt({ title: "Shell:", value: template, onSubmit: (v) => this.runShell(v, !!c.opts.orphan, true) });
		} else this.runShell(template, !!c.opts.orphan, false);
	}

	private runShell(template: string, orphan: boolean, showOutput: boolean) {
		if (!template.trim()) return;
		const quote = (fs: TAbstractFile[]) => fs.map((f) => shellQuote(this.absPath(f.path))).join(" ");
		const h = this.hovered();
		const cmd = template.replace(/%([sh%])/g, (_m, k: string) => {
			if (k === "%") return "%";
			if (k === "h") return h ? shellQuote(this.absPath(h.path)) : "";
			return quote(this.targets());
		});
		const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
		const cwd = this.absPath(this.cwd);

		// `ya emit <cmd> ...` from a shell command: expand it with the shell and run it here.
		const emit = cmd.match(/^\s*ya\s+emit\s+([\s\S]+)$/);
		if (emit) {
			execFile(
				"/bin/sh",
				["-c", `printf '%s\\n' ${emit[1]}`],
				{ cwd, env },
				(err, stdout) => {
					if (err) {
						new Notice(`Yazi: ${err.message}`);
						return;
					}
					const words = stdout.replace(/\n$/, "").split("\n");
					const name = words.shift() ?? "";
					const args: string[] = [];
					const opts: Record<string, string | true> = {};
					for (const w of words) {
						if (w.startsWith("--") && w.length > 2) {
							const eq = w.indexOf("=");
							if (eq > 0) opts[w.slice(2, eq)] = w.slice(eq + 1);
							else opts[w.slice(2)] = true;
						} else args.push(w);
					}
					void this.exec({ name, args, opts });
				},
			);
			return;
		}

		if (orphan) {
			spawn("/bin/sh", ["-c", cmd], { cwd, env, detached: true, stdio: "ignore" }).unref();
			return;
		}
		exec(cmd, { cwd, env }, (err, stdout, stderr) => {
			if (err) new Notice(`Yazi: command failed (${err.code ?? "error"})\n${(stderr || err.message).slice(0, 400)}`);
			else if (showOutput && stdout.trim()) new Notice(stdout.slice(0, 1000), 8000);
		});
	}

	// --- plugins ---------------------------------------------------------------

	private async pluginCmd(c: Cmd) {
		const name = c.args[0] ?? "";
		const arg = c.args[1] ?? (typeof c.opts.args === "string" ? c.opts.args : "");
		switch (name) {
			case "smart-enter":
				return this.smartEnter();
			case "confirm-quit":
				return this.quit();
			case "jump-to-char":
				this.awaitChar = (k) => {
					if ([...k].length !== 1) return;
					this.find = new RegExp("^" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
					this.jumpToMatch(false);
				};
				return;
			case "toggle-pane":
				return this.togglePane(arg);
			case "smart-filter":
				return this.filterCmd({ name: "filter", args: [], opts: { smart: true } });
			case "fzf":
				return this.fuzzy(false);
			case "zoxide":
				return this.fuzzy(true);
			default:
				new Notice(`Yazi: plugin “${name}” is not available in Obsidian`);
		}
	}

	private togglePane(arg: string) {
		const base = this.ratio();
		const orig = this.ratioOverride ? this.baseRatio() : base;
		const [what, pane] = arg.split("-") as ["min" | "max" | "reset", "parent" | "current" | "preview"];
		const idx = { parent: 0, current: 1, preview: 2 }[pane];
		if (what === "reset" || idx === undefined) {
			this.ratioOverride = null;
		} else if (what === "min") {
			const r = [...base] as Ratio;
			if (r[idx] === 0) r[idx] = orig[idx] || [1, 4, 3][idx];
			else r[idx] = 0;
			if (r[1] === 0 && r[0] === 0 && r[2] === 0) r[1] = 1;
			this.ratioOverride = r;
		} else {
			const maxed = base.every((v, i) => (i === idx ? v > 0 : v === 0));
			if (maxed) this.ratioOverride = null;
			else {
				const r: Ratio = [0, 0, 0];
				r[idx] = 1;
				this.ratioOverride = r;
			}
		}
		if (this.ratioOverride && this.ratioOverride.every((v, i) => v === orig[i])) this.ratioOverride = null;
		this.previewKey = "";
		this.render();
	}

	private baseRatio(): Ratio {
		const saved = this.ratioOverride;
		this.ratioOverride = null;
		const r = this.ratio();
		this.ratioOverride = saved;
		return r;
	}

	private fuzzy(foldersOnly: boolean) {
		const base = foldersOnly ? this.app.vault.getRoot() : this.getFolder(this.cwd);
		if (!base) return;
		const items: TAbstractFile[] = [];
		const walk = (folder: TFolder) => {
			for (const ch of folder.children) {
				if (!this.showHidden && ch.name.startsWith(".")) continue;
				if (!foldersOnly || ch instanceof TFolder) items.push(ch);
				if (ch instanceof TFolder) walk(ch);
			}
		};
		walk(base);
		const modal = new JumpModal(this.app, items, (f) => {
			if (foldersOnly && f instanceof TFolder) this.cd(f.path);
			else this.reveal(f.path);
		}, () => window.setTimeout(() => this.focus(), 0));
		modal.setPlaceholder(foldersOnly ? "Jump to a folder" : "Jump to a file or folder");
		modal.open();
	}

	// =========================================================================
	// Prompt, confirm, picker, help, spot

	private prompt(opts: PromptOptions) {
		this.cancelPending();
		this.prompting = opts;
		this.inputTitle.setText(opts.title);
		this.inputEl.value = opts.value ?? "";
		this.inputWrap.show();
		this.inputEl.focus();
		const pos = opts.cursor ?? this.inputEl.value.length;
		this.inputEl.setSelectionRange(pos, pos);
	}

	private closePrompt(submit: boolean) {
		const p = this.prompting;
		if (!p) return;
		this.prompting = null;
		const value = this.inputEl.value;
		this.inputWrap.hide();
		this.focus();
		if (submit) {
			Promise.resolve(p.onSubmit(value)).catch((e) => new Notice(`Yazi: ${(e as Error).message}`));
		} else p.onCancel?.();
	}

	private openOverlay(build: (el: HTMLElement) => (key: string) => boolean, cls: string) {
		this.closeOverlay();
		const el = this.rootEl.createDiv({ cls: `yazi-overlay ${cls}` });
		const onKey = build(el);
		this.overlay = { el, onKey };
	}

	private closeOverlay() {
		this.overlay?.el.remove();
		this.overlay = null;
	}

	private confirm(title: string, lines: string[]): Promise<boolean> {
		return new Promise((resolve) => {
			this.openOverlay((el) => {
				el.createDiv({ cls: "yazi-overlay-title", text: title });
				const list = el.createDiv({ cls: "yazi-overlay-body" });
				for (const l of lines.slice(0, 50)) list.createDiv({ text: l });
				if (lines.length > 50) list.createDiv({ text: `… and ${lines.length - 50} more` });
				el.createDiv({ cls: "yazi-overlay-foot", text: "[y]es  [n]o" });
				return (key) => {
					if (key === "y" || key === "Y" || key === "<Enter>") {
						this.closeOverlay();
						resolve(true);
					} else if (["n", "N", "q", "<Esc>", "<C-[>", "<C-c>"].includes(key)) {
						this.closeOverlay();
						resolve(false);
					}
					return true;
				};
			}, "yazi-confirm");
		});
	}

	private picker(title: string, items: [string, () => void][]) {
		let idx = 0;
		this.openOverlay((el) => {
			el.createDiv({ cls: "yazi-overlay-title", text: title });
			const body = el.createDiv({ cls: "yazi-overlay-body" });
			const draw = () => {
				body.empty();
				items.forEach(([label], i) => {
					const r = body.createDiv({ cls: "yazi-pick", text: `${i + 1}. ${label}` });
					if (i === idx) r.addClass("is-hovered");
					r.onclick = () => {
						this.closeOverlay();
						items[i][1]();
					};
				});
			};
			draw();
			return (key) => {
				if (key === "j" || key === "<Down>") idx = (idx + 1) % items.length;
				else if (key === "k" || key === "<Up>") idx = (idx - 1 + items.length) % items.length;
				else if (key === "<Enter>" || key === "l") {
					this.closeOverlay();
					items[idx][1]();
					return true;
				} else if (/^[1-9]$/.test(key) && Number(key) <= items.length) {
					this.closeOverlay();
					items[Number(key) - 1][1]();
					return true;
				} else if (["<Esc>", "<C-[>", "<C-c>", "q"].includes(key)) {
					this.closeOverlay();
					return true;
				}
				draw();
				return true;
			};
		}, "yazi-picker");
	}

	private help() {
		let filter = "";
		let idx = 0;
		this.openOverlay((el) => {
			el.createDiv({ cls: "yazi-overlay-title", text: "Help — j/k move, / filter, Esc close" });
			const body = el.createDiv({ cls: "yazi-overlay-body yazi-help" });
			const rows = () =>
				this.plugin.config.bindings.filter((b) => {
					if (!filter) return true;
					const q = filter.toLowerCase();
					return (b.on.join(" ") + " " + b.run.join("; ") + " " + b.desc).toLowerCase().includes(q);
				});
			const draw = () => {
				body.empty();
				const list = rows();
				idx = Math.max(0, Math.min(idx, list.length - 1));
				list.forEach((b, i) => {
					const r = body.createDiv({ cls: "yazi-help-row" });
					if (i === idx) r.addClass("is-hovered");
					r.createSpan({ cls: "yazi-help-key", text: b.on.join(" ") });
					r.createSpan({ cls: "yazi-help-run", text: b.run.join("; ") });
					r.createSpan({ cls: "yazi-help-desc", text: b.desc });
				});
				const cur = body.children[idx] as HTMLElement | undefined;
				if (cur) this.scrollIntoView(body, cur);
			};
			draw();
			return (key) => {
				const n = rows().length;
				if (key === "j" || key === "<Down>") idx = Math.min(n - 1, idx + 1);
				else if (key === "k" || key === "<Up>") idx = Math.max(0, idx - 1);
				else if (key === "<C-d>") idx = Math.min(n - 1, idx + 10);
				else if (key === "<C-u>") idx = Math.max(0, idx - 10);
				else if (key === "g") idx = 0;
				else if (key === "G") idx = n - 1;
				else if (key === "/") {
					this.prompt({
						title: "Filter:",
						value: filter,
						onChange: (v) => {
							filter = v;
							idx = 0;
							draw();
						},
						onSubmit: (v) => {
							filter = v;
							draw();
						},
						onCancel: () => {
							filter = "";
							draw();
						},
					});
					return true;
				} else if (["<Esc>", "<C-[>", "<C-c>", "q", "~", "<F1>"].includes(key)) {
					if (filter && key === "<Esc>") filter = "";
					else {
						this.closeOverlay();
						return true;
					}
				}
				draw();
				return true;
			};
		}, "yazi-help-overlay");
	}

	private spot() {
		const h = this.hovered();
		if (!h) return;
		this.openOverlay((el) => {
			el.createDiv({ cls: "yazi-overlay-title", text: h.name });
			const body = el.createDiv({ cls: "yazi-overlay-body yazi-spot" });
			const row = (k: string, v: string) => {
				const r = body.createDiv({ cls: "yazi-spot-row" });
				r.createSpan({ cls: "yazi-spot-key", text: k });
				r.createSpan({ text: v });
			};
			row("Path", h.path);
			if (h instanceof TFile) {
				row("Type", h.extension || "file");
				row("Size", `${readableSize(h.stat.size)} (${h.stat.size} bytes)`);
				row("Created", new Date(h.stat.ctime).toLocaleString());
				row("Modified", new Date(h.stat.mtime).toLocaleString());
				const cache = this.app.metadataCache.getFileCache(h);
				if (cache?.frontmatter) {
					for (const [k, v] of Object.entries(cache.frontmatter)) row(k, typeof v === "string" ? v : JSON.stringify(v));
				}
				const backlinks = Object.entries(this.app.metadataCache.resolvedLinks).filter(([, l]) => l[h.path]).length;
				row("Backlinks", String(backlinks));
			} else {
				row("Type", "folder");
				row("Items", String(childCount(h)));
			}
			return (key) => {
				if (["<Esc>", "<C-[>", "<C-c>", "<Tab>", "q"].includes(key)) this.closeOverlay();
				return true;
			};
		}, "yazi-spot-overlay");
	}
}
