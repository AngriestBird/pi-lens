import * as fs from "node:fs";
import * as path from "node:path";

function localConfigPath(repoRoot: string): string {
	const gitEntry = path.join(repoRoot, ".git");
	if (fs.existsSync(gitEntry) && fs.statSync(gitEntry).isFile()) {
		const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(gitEntry, "utf8"));
		if (match) return path.resolve(repoRoot, match[1].trim(), "config");
	}
	return path.join(gitEntry, "config");
}

export function assertCleanGitConfig(configPath: string): void {
	if (!fs.existsSync(configPath)) return;
	const text = fs.readFileSync(configPath, "utf8");
	let section = "";
	let identity = false;
	let bare = false;
	for (const line of text.split(/\r?\n/)) {
		const header = /^\s*\[([^\]]+)\]/.exec(line);
		if (header) {
			section = header[1].trim().toLowerCase();
			continue;
		}
		if (section === "user" && /^\s*(?:name|email)\s*=/.test(line))
			identity = true;
		if (section === "core" && /^\s*bare\s*=\s*true\s*$/i.test(line))
			bare = true;
	}
	if (identity || bare) {
		throw new Error(
			`Git contamination guard failed for ${configPath}: ${identity ? "local user identity" : "core.bare=true"}`,
		);
	}
}

export default function teardown(): void {
	assertCleanGitConfig(localConfigPath(process.cwd()));
}
