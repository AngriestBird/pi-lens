import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireBoundedPidFileLock } from "../../clients/bounded-pid-file-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("acquireBoundedPidFileLock", () => {
	it("logs and skips a contending write without disturbing the lock holder", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		const releaseFirst = acquireBoundedPidFileLock(lockPath, {
			waitMs: 10,
			retryMs: 1,
			timeoutMessage: "first lock timed out",
			onContention: "throw",
		});
		expect(releaseFirst).not.toBeNull();
		const firstToken = fs.readFileSync(lockPath, "utf8");
		const logContention = vi.fn();

		const releaseSecond = acquireBoundedPidFileLock(lockPath, {
			waitMs: 0,
			retryMs: 1,
			timeoutMessage: "second lock timed out",
			onContention: "skip-log",
			logContention,
		});

		expect(releaseSecond).toBeNull();
		expect(logContention).toHaveBeenCalledOnce();
		expect(fs.readFileSync(lockPath, "utf8")).toBe(firstToken);
		releaseFirst?.();
		expect(fs.existsSync(lockPath)).toBe(false);
	});
});
