import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

/** True for a path below the host temporary directory. */
export function isUnderSystemTmpDir(candidate: string): boolean {
	return isWithin(path.resolve(os.tmpdir()), path.resolve(candidate));
}

/**
 * Host-created pi-agent staging paths are not user projects. Keep this test
 * deliberately narrower than the temporary-directory test: ordinary tmp
 * fixtures are real test inputs and must remain eligible LSP roots.
 */
export function ephemeralStagingRoot(candidate: string): string | undefined {
	const resolved = path.resolve(candidate);
	const tmpRoot = path.resolve(os.tmpdir());
	if (!isWithin(tmpRoot, resolved)) return undefined;
	const relative = path.relative(tmpRoot, resolved);
	const segments: string[] = [];
	for (const segment of relative.split(path.sep)) {
		if (segment) segments.push(segment);
	}
	const index = segments.findIndex((segment) =>
		/^pi-agent(?:-|$)/i.test(segment),
	);
	return index < 0
		? undefined
		: path.join(tmpRoot, ...segments.slice(0, index + 1));
}

/** True for a real checkout rooted below the host temporary directory. */
export function isEphemeralCheckoutRoot(candidate: string): boolean {
	const resolved = path.resolve(candidate);
	if (!isUnderSystemTmpDir(resolved)) return false;
	try {
		const git = fs.statSync(path.join(resolved, ".git"));
		return git.isDirectory() || git.isFile();
	} catch {
		return false;
	}
}
