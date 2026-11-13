// Copy the built plugin into the Obsidian vault: node scripts/install.mjs [vault path]
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vault) {
	console.error("Usage: OBSIDIAN_VAULT=/path/to/vault npm run install-vault");
	process.exit(1);
}
const dir = join(vault, ".obsidian/plugins/yazi-fm");
mkdirSync(dir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(dir, f));
console.log(`Installed to ${dir}`);
