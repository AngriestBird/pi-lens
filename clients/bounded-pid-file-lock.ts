import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

const waitArray = new Int32Array(new SharedArrayBuffer(4));

function ownerPidIsLive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Acquire a bounded synchronous cross-process file lock.
 *
 * PID liveness cannot distinguish a recycled PID from the original owner. A
 * recycled PID can therefore make a stale lock look live, but only for the
 * caller's bounded wait. OS start-time validation would require a platform-
 * specific subprocess on this synchronous behavior-gating path; the unique
 * token instead prevents a late release from deleting a replacement lock.
 */
interface BoundedPidFileLockOptions {
	waitMs: number;
	retryMs: number;
	timeoutMessage: string;
}

export function acquireBoundedPidFileLock(
	lockPath: string,
	options: BoundedPidFileLockOptions & { onContention: "throw" },
): () => void;
export function acquireBoundedPidFileLock(
	lockPath: string,
	options: BoundedPidFileLockOptions & {
		onContention: "skip-log";
		logContention: () => void;
	},
): (() => void) | null;
export function acquireBoundedPidFileLock(
	lockPath: string,
	options: BoundedPidFileLockOptions & (
		| { onContention: "throw" }
		| { onContention: "skip-log"; logContention: () => void }
	),
): (() => void) | null {
	const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
	const deadline = Date.now() + options.waitMs;
	for (;;) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeFileSync(fd, token, "utf8");
			fs.closeSync(fd);
			return () => {
				try {
					if (fs.readFileSync(lockPath, "utf8") === token) {
						fs.unlinkSync(lockPath);
					}
				} catch {
					// Protected write completed; cleanup is best-effort.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const [pidText] = fs.readFileSync(lockPath, "utf8").split(":", 1);
				if (!ownerPidIsLive(Number.parseInt(pidText ?? "", 10))) {
					fs.unlinkSync(lockPath);
					continue;
				}
			} catch (lockError) {
				if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
			}
			if (Date.now() >= deadline) {
				if (options.onContention === "throw") {
					throw new Error(options.timeoutMessage);
				}
				options.logContention();
				return null;
			}
			Atomics.wait(waitArray, 0, 0, options.retryMs);
		}
	}
}
