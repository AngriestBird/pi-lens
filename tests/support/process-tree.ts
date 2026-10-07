import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * SIGKILL a spawned child AND everything below it (#4081).
 *
 * `child.kill("SIGKILL")` reaches only the direct child. The real pi leaves
 * grandchildren behind (knip, `npx ast-grep scan`, typescript-language-server
 * --version), and they are not even in its process group: pi's launcher
 * spawns them detached, so each is the leader of its own group. They are
 * reparented and keep writing under the scratch HOME for up to ~1.5 s, which
 * is what turned a recursive teardown into ENOTEMPTY. A group kill of the
 * child's group would not reach them, so the tree is walked by parent pid.
 *
 * Returns the pids signalled (the child first), for a caller that must wait
 * until they are gone. An already-reaped child returns [] and signals nothing:
 * its pid may have been recycled, and its children are no longer discoverable.
 *
 * POSIX: SIGSTOP the child and every descendant found (a stopped process
 * cannot fork a replacement), then SIGKILL each pid and, since a descendant is
 * usually its own group leader, its group.
 * Windows: `taskkill /T /F`, the same tree kill the production seam uses.
 */
export function killProcessTree(child: {
	pid?: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
}): number[] {
	const root = child.pid;
	if (
		root === undefined ||
		child.exitCode !== null ||
		child.signalCode !== null
	)
		return [];
	if (process.platform === "win32") {
		const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
		spawnSync(taskkill, ["/PID", String(root), "/T", "/F"], {
			shell: false,
			windowsHide: true,
			stdio: "ignore",
		});
		return [root];
	}
	// The root first, so it cannot fork while its descendants are listed; then
	// every descendant, stopped before any is killed. Known limit, stated: a
	// descendant that forks between the `ps` snapshot and its own SIGSTOP leaves
	// one unsignalled grandchild, which the callers' bounded removal retry
	// absorbs.
	signal(root, "SIGSTOP");
	const tree = [root, ...descendantsOf(root)];
	for (const pid of tree.slice(1)) signal(pid, "SIGSTOP");
	for (const pid of tree) {
		// Only a descendant that leads its own group answers to -pid; for every
		// other pid this is ESRCH, which `signal` swallows.
		if (pid !== root) signal(-pid, "SIGKILL");
		signal(pid, "SIGKILL");
	}
	return tree;
}

function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch {
		// ESRCH: already gone. EPERM: not ours to signal.
	}
}

/** Every pid below `root`, from one `ps` snapshot (empty when `ps` is absent). */
function descendantsOf(root: number): number[] {
	const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
		encoding: "utf8",
		timeout: 2_000,
	});
	if (ps.status !== 0 || typeof ps.stdout !== "string") return [];
	const children = new Map<number, number[]>();
	for (const line of ps.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		const parent = Number(match[2]);
		children.set(parent, [...(children.get(parent) ?? []), Number(match[1])]);
	}
	const out: number[] = [];
	for (const queue = [root]; queue.length > 0;) {
		for (const pid of children.get(queue.pop() as number) ?? []) {
			out.push(pid);
			queue.push(pid);
		}
	}
	return out;
}

/**
 * Whether `pid` still exists and is not a zombie. A zombie holds no file
 * handles and is only waiting for its (reparented) parent to reap it, so it
 * cannot write under a directory being removed.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
	try {
		return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return true;
	}
}
