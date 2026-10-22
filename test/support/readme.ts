import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * **The README's fenced TypeScript block that names itself `// <file>`**, verbatim, for a suite that
 * runs what the README shows rather than a copy of it.
 */
export function readmeBlock(file: string): string {
	const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
	const named = new RegExp(
		`^\`\`\`ts\\n(// ${file.replaceAll(".", "\\.")}\\n[\\s\\S]*?)^\`\`\`$`,
		"m",
	);
	const block = named.exec(readme)?.[1];
	if (block === undefined) throw new Error(`the README shows no \`// ${file}\` block`);
	return block;
}
