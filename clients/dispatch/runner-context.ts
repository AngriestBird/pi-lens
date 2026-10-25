import * as fs from "node:fs";
import * as path from "node:path";
import {
	normalizeHostToolPath,
	normalizeMapKey,
	walkUpDirs,
} from "../path-utils.js";

function resolveAgainstAncestors(cwd: string, filePath: string): string {
	// #4576: a runner reports the path it was given, and that path may be a
	// host-supplied spelling (`~/x`, `file://…`). Normalizing once at entry
	// keeps a literal `~` from being walked up as a relative directory, and
	// leaves every other relative path's ancestor walk unchanged.
	filePath = normalizeHostToolPath(filePath);
	if (path.isAbsolute(filePath)) {
		return path.resolve(filePath);
	}

	const normalizedRelative = filePath.replace(/\\/g, "/");
	const cwdBaseName = path.basename(path.resolve(cwd)).replace(/\\/g, "/");
	if (
		cwdBaseName &&
		(normalizedRelative === cwdBaseName ||
			normalizedRelative.startsWith(`${cwdBaseName}/`))
	) {
		const trimmedRelative =
			normalizedRelative === cwdBaseName
				? ""
				: normalizedRelative.slice(cwdBaseName.length + 1);
		const trimmedCandidate = trimmedRelative
			? path.resolve(cwd, trimmedRelative)
			: path.resolve(cwd);
		if (fs.existsSync(trimmedCandidate)) {
			return trimmedCandidate;
		}
	}

	const directCandidate = path.resolve(cwd, filePath);
	if (fs.existsSync(directCandidate)) {
		return directCandidate;
	}

	// #4689 item 6: the cwd's path identity and its ancestors, the directories
	// a tool run from `cwd` resolves `..` through. The cwd itself repeats
	// `directCandidate`, which has just been refused.
	for (const dir of walkUpDirs(cwd)) {
		const candidate = path.resolve(dir, filePath);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return directCandidate;
}

export function resolveRunnerPath(cwd: string, filePath: string): string {
	return normalizeMapKey(resolveAgainstAncestors(cwd, filePath));
}

export function toRunnerDisplayPath(cwd: string, filePath: string): string {
	const cwdKey = normalizeMapKey(path.resolve(cwd));
	const fileKey = resolveRunnerPath(cwd, filePath);
	const relative = path.relative(cwdKey, fileKey).replace(/\\/g, "/");
	if (relative && relative !== "." && !relative.startsWith("../")) {
		return relative;
	}
	return fileKey;
}
