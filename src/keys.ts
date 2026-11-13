// Key notation compatible with Yazi's keymap.toml: "j", "G", "<C-d>", "<S-Enter>", "<Space>", ...

const NAMED: Record<string, string> = {
	space: "Space",
	enter: "Enter",
	esc: "Esc",
	escape: "Esc",
	tab: "Tab",
	backtab: "BackTab",
	backspace: "Backspace",
	delete: "Delete",
	insert: "Insert",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = `F${i}`;

const EVENT_NAMES: Record<string, string> = {
	" ": "Space",
	Enter: "Enter",
	Escape: "Esc",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Delete",
	Insert: "Insert",
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
};
for (let i = 1; i <= 12; i++) EVENT_NAMES[`F${i}`] = `F${i}`;

// US QWERTY characters for physical key codes: [unshifted, shifted].
const CODE_CHARS: Record<string, [string, string]> = {
	Backquote: ["`", "~"],
	Minus: ["-", "_"],
	Equal: ["=", "+"],
	BracketLeft: ["[", "{"],
	BracketRight: ["]", "}"],
	Backslash: ["\\", "|"],
	IntlBackslash: ["`", "~"],
	Semicolon: [";", ":"],
	Quote: ["'", '"'],
	Comma: [",", "<"],
	Period: [".", ">"],
	Slash: ["/", "?"],
	Digit1: ["1", "!"],
	Digit2: ["2", "@"],
	Digit3: ["3", "#"],
	Digit4: ["4", "$"],
	Digit5: ["5", "%"],
	Digit6: ["6", "^"],
	Digit7: ["7", "&"],
	Digit8: ["8", "*"],
	Digit9: ["9", "("],
	Digit0: ["0", ")"],
};

const MOD_ORDER = ["C", "A", "S", "D"] as const;

function build(mods: Set<string>, key: string): string {
	const isChar = [...key].length === 1;
	if (isChar && mods.has("S")) {
		mods.delete("S");
		key = key.toUpperCase();
	}
	if (isChar && mods.size === 0) return key;
	const prefix = MOD_ORDER.filter((m) => mods.has(m))
		.map((m) => `${m}-`)
		.join("");
	return `<${prefix}${key}>`;
}

/** Normalize a key written in Yazi notation. Returns null if it cannot be parsed. */
export function normalizeKey(raw: string): string | null {
	if (!raw) return null;
	if (!(raw.startsWith("<") && raw.endsWith(">") && raw.length > 2)) {
		return [...raw].length === 1 ? raw : null;
	}
	let inner = raw.slice(1, -1);
	const mods = new Set<string>();
	while (inner.length > 2 && inner[1] === "-" && "CASDcasd".includes(inner[0])) {
		mods.add(inner[0].toUpperCase());
		inner = inner.slice(2);
	}
	let key: string;
	if ([...inner].length === 1) key = inner;
	else {
		const named = NAMED[inner.toLowerCase()];
		if (!named) return null;
		key = named;
	}
	if (key === "BackTab") {
		key = "Tab";
		mods.add("S");
	}
	return build(mods, key);
}

/**
 * Convert a keyboard event to Yazi notation.
 * physical = true resolves printable keys by their US-QWERTY position (layout independent).
 */
export function eventToKey(evt: KeyboardEvent, physical: boolean): string | null {
	if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Process", "Unidentified"].includes(evt.key)) {
		return null;
	}
	const mods = new Set<string>();
	if (evt.ctrlKey) mods.add("C");
	if (evt.altKey) mods.add("A");
	if (evt.metaKey) mods.add("D");

	const named = EVENT_NAMES[evt.key];
	if (named) {
		if (evt.shiftKey) mods.add("S");
		return build(mods, named);
	}

	let ch: string | null = null;
	const code = evt.code || "";
	const usePhysical = physical || evt.altKey || evt.ctrlKey;
	if (usePhysical) {
		if (/^Key[A-Z]$/.test(code)) {
			const c = code.slice(3);
			ch = evt.shiftKey ? c : c.toLowerCase();
		} else if (CODE_CHARS[code]) {
			ch = CODE_CHARS[code][evt.shiftKey ? 1 : 0];
		}
	}
	if (ch === null) {
		if ([...evt.key].length !== 1) return null;
		ch = evt.key;
	}
	// Shift is already reflected in the character.
	return build(mods, ch);
}

/** Pretty-print a key sequence the way Yazi's help/which does. */
export function formatKeys(keys: string[]): string {
	return keys.join(" ");
}
