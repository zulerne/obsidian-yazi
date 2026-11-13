import { parse as parseToml } from "smol-toml";
import { normalizeKey } from "./keys";
import { YAZI_DEFAULT_KEYMAP } from "./yazi-default-keymap";

export interface Binding {
	on: string[];
	run: string[];
	desc: string;
}

export type SortBy = "none" | "mtime" | "btime" | "extension" | "alphabetical" | "natural" | "size" | "random";
export type Linemode = "none" | "size" | "btime" | "mtime" | "permissions" | "owner";

/** Subset of yazi.toml [mgr] that makes sense inside a vault. */
export interface MgrOptions {
	ratio: [number, number, number];
	sort_by: SortBy;
	sort_sensitive: boolean;
	sort_reverse: boolean;
	sort_dir_first: boolean;
	linemode: Linemode;
	show_hidden: boolean;
	scrolloff: number;
}

// Yazi's own defaults (yazi-config/preset/yazi-default.toml).
export const DEFAULT_MGR: MgrOptions = {
	ratio: [1, 4, 3],
	sort_by: "alphabetical",
	sort_sensitive: false,
	sort_reverse: false,
	sort_dir_first: true,
	linemode: "none",
	show_hidden: false,
	scrolloff: 5,
};

const SORTS: SortBy[] = ["none", "mtime", "btime", "extension", "alphabetical", "natural", "size", "random"];
const LINEMODES: Linemode[] = ["none", "size", "btime", "mtime", "permissions", "owner"];

export interface ParsedConfig {
	bindings: Binding[];
	mgr: MgrOptions;
	errors: string[];
}

type Obj = Record<string, unknown>;

function platformAccepts(forValue: unknown): boolean {
	if (typeof forValue !== "string") return true;
	const p = process.platform;
	switch (forValue) {
		case "unix":
			return p !== "win32";
		case "macos":
			return p === "darwin";
		case "linux":
			return p === "linux";
		case "windows":
			return p === "win32";
		default:
			return true;
	}
}

function toBindings(list: unknown, where: string, errors: string[]): Binding[] {
	if (!Array.isArray(list)) return [];
	const out: Binding[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const o = item as Obj;
		if (!platformAccepts(o.for)) continue;
		const onRaw = Array.isArray(o.on) ? o.on : [o.on];
		const on: string[] = [];
		let bad = false;
		for (const k of onRaw) {
			const n = typeof k === "string" ? normalizeKey(k) : null;
			if (!n) {
				errors.push(`${where}: unknown key ${JSON.stringify(k)}`);
				bad = true;
				break;
			}
			on.push(n);
		}
		if (bad || on.length === 0) continue;
		const runRaw = Array.isArray(o.run) ? o.run : [o.run];
		const run = runRaw.filter((r): r is string => typeof r === "string");
		if (run.length === 0) {
			errors.push(`${where}: binding ${on.join(" ")} has no run`);
			continue;
		}
		out.push({ on, run, desc: typeof o.desc === "string" ? o.desc : "" });
	}
	return out;
}

function mgrSection(doc: Obj): Obj {
	// `[manager]` is the pre-0.4 name of `[mgr]`.
	const m = (doc.mgr ?? doc.manager) as Obj | undefined;
	return m && typeof m === "object" ? m : {};
}

function safeParse(text: string, name: string, errors: string[]): Obj {
	if (!text.trim()) return {};
	try {
		return parseToml(text) as Obj;
	} catch (e) {
		errors.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
		return {};
	}
}

export function parseConfig(keymapToml: string, yaziToml: string): ParsedConfig {
	const errors: string[] = [];

	const defaults = toBindings(mgrSection(parseToml(YAZI_DEFAULT_KEYMAP) as Obj).keymap, "default keymap", errors);

	const user = mgrSection(safeParse(keymapToml, "keymap.toml", errors));
	const base = Array.isArray(user.keymap) ? toBindings(user.keymap, "keymap.toml [mgr].keymap", errors) : defaults;
	const bindings = [
		...toBindings(user.prepend_keymap, "keymap.toml prepend_keymap", errors),
		...base,
		...toBindings(user.append_keymap, "keymap.toml append_keymap", errors),
	];

	const mgr: MgrOptions = { ...DEFAULT_MGR, ratio: [...DEFAULT_MGR.ratio] };
	const y = mgrSection(safeParse(yaziToml, "yazi.toml", errors));
	if (Array.isArray(y.ratio) && y.ratio.length === 3 && y.ratio.every((n) => typeof n === "number")) {
		mgr.ratio = y.ratio as [number, number, number];
	}
	if (typeof y.sort_by === "string" && SORTS.includes(y.sort_by as SortBy)) mgr.sort_by = y.sort_by as SortBy;
	if (typeof y.linemode === "string" && LINEMODES.includes(y.linemode as Linemode)) {
		mgr.linemode = y.linemode as Linemode;
	}
	for (const k of ["sort_sensitive", "sort_reverse", "sort_dir_first", "show_hidden"] as const) {
		if (typeof y[k] === "boolean") mgr[k] = y[k] as boolean;
	}
	if (typeof y.scrolloff === "number") mgr.scrolloff = y.scrolloff;

	return { bindings, mgr, errors };
}

// ---------------------------------------------------------------------------
// Command parsing: `name positional --flag --key=value -- raw rest`

export interface Cmd {
	name: string;
	args: string[];
	opts: Record<string, string | true>;
}

export function parseCmd(src: string): Cmd {
	const args: string[] = [];
	const opts: Record<string, string | true> = {};
	let i = 0;
	const s = src.trim();
	const tokens: string[] = [];
	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i])) i++;
		if (i >= s.length) break;
		// `--` followed by whitespace: everything after it is one raw argument.
		if (s.startsWith("--", i) && (i + 2 === s.length || /\s/.test(s[i + 2]))) {
			const rest = s.slice(i + 2).trim();
			if (rest) tokens.push("\u0000" + rest);
			break;
		}
		let tok = "";
		let quoted = false;
		while (i < s.length && !/\s/.test(s[i])) {
			const c = s[i];
			if (c === "'" || c === '"') {
				quoted = true;
				const end = s.indexOf(c, i + 1);
				if (end < 0) {
					tok += s.slice(i + 1);
					i = s.length;
				} else {
					tok += s.slice(i + 1, end);
					i = end + 1;
				}
			} else if (c === "\\" && i + 1 < s.length) {
				tok += s[i + 1];
				i += 2;
			} else {
				tok += c;
				i++;
			}
		}
		tokens.push(quoted ? "\u0000" + tok : tok);
	}
	const name = (tokens.shift() ?? "").replace(/^\u0000/, "");
	for (const t of tokens) {
		if (t.startsWith("\u0000")) args.push(t.slice(1));
		else if (t.startsWith("--") && t.length > 2) {
			const eq = t.indexOf("=");
			if (eq > 0) opts[t.slice(2, eq)] = t.slice(eq + 1);
			else opts[t.slice(2)] = true;
		} else args.push(t);
	}
	return { name, args, opts };
}

export function optBool(v: string | true | undefined): boolean | undefined {
	if (v === undefined) return undefined;
	if (v === true) return true;
	return !["no", "false", "0", "off"].includes(v.toLowerCase());
}

// ---------------------------------------------------------------------------
// Commands this plugin understands (used to report unsupported bindings).

export const SUPPORTED_COMMANDS = new Set([
	"escape", "quit", "close", "suspend", "arrow", "leave", "enter", "back", "forward",
	"toggle", "toggle_all", "visual_mode", "seek", "spot", "open", "yank", "paste", "unyank",
	"remove", "create", "rename", "shell", "hidden", "search", "filter", "find", "find_arrow",
	"sort", "linemode", "copy", "cd", "reveal", "help", "plugin", "noop", "obsidian",
	"tab_switch", "tab_swap", "tab_create", "tab_close", "tab_rename",
]);

export const SUPPORTED_PLUGINS = new Set([
	"smart-enter", "jump-to-char", "toggle-pane", "confirm-quit", "fzf", "zoxide", "smart-filter",
]);

export function unsupportedReason(run: string): string | null {
	const c = parseCmd(run);
	if (!SUPPORTED_COMMANDS.has(c.name)) return `command "${c.name}"`;
	if (c.name === "plugin") {
		const p = (c.args[0] ?? "").replace(/^\u0000/, "");
		if (!SUPPORTED_PLUGINS.has(p)) return `plugin "${p}"`;
	}
	if (c.name.startsWith("tab_") && c.name !== "tab_create") return "tabs";
	if (c.name === "shell" && c.opts.block) return "blocking shell";
	return null;
}
