import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	settleRegistryMutationsBeforeTeardown,
	setTmpHygieneAfterAllProbeForTests,
	writeTmpHygieneLeakNotice,
} from "./vitest-setup.js";

import {
	_settleRegistryMutationsForTests,
	registerInstance,
} from "../../clients/instance-registry.js";

describe("worker console channel (#3128)", () => {
	it("drains a held registry mutation before worker teardown (#3617)", async () => {
		const home = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-teardown-3617-"),
		);
		const previousHome = process.env.PI_LENS_HOME;
		const root = fs.mkdtempSync(path.join(home, "root-"));
		const registryPath = path.join(home, "instances.json");
		fs.writeFileSync(`${registryPath}.lock`, `${process.ppid} ${Date.now()}\n`);
		try {
			process.env.PI_LENS_HOME = home;
			const mutation = registerInstance(root);
			setImmediate(() => fs.rmSync(`${registryPath}.lock`, { force: true }));
			await settleRegistryMutationsBeforeTeardown();
			expect(fs.existsSync(registryPath)).toBe(true);
			expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toMatchObject({
				instances: [{ projectRoot: root }],
			});
			await mutation;
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			await _settleRegistryMutationsForTests();
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	it("writes tmp-hygiene leak notices to stderr with a newline", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			writeTmpHygieneLeakNotice("/tmp/pi-lens-hygiene", 3);
			expect(write).toHaveBeenCalledTimes(1);
			const message = String(write.mock.calls[0]?.[0]);
			expect(message).toContain("3 unadmitted entry(s)");
			expect(message.endsWith("\n")).toBe(true);
		} finally {
			write.mockRestore();
		}
	});

	it("reports an unadmitted entry from the worker teardown path", () => {
		const leakedEntry = path.join(
			os.tmpdir(),
			`pi-lens-worker-teardown-${Date.now()}-${process.pid}`,
		);
		const previousTrace = process.env.PI_LENS_TMP_HYGIENE_TRACE;
		delete process.env.PI_LENS_TMP_HYGIENE_TRACE;
		fs.mkdirSync(leakedEntry);
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		setTmpHygieneAfterAllProbeForTests(() => {
			try {
				const notices = write.mock.calls
					.map(([chunk]) => String(chunk))
					.filter((message) => message.startsWith("[tmp-hygiene]"));
				expect(notices).toHaveLength(1);
				const message = notices[0] ?? "";
				expect(message).toContain("unadmitted entry(s)");
				expect(message.endsWith("\n")).toBe(true);
			} finally {
				write.mockRestore();
				fs.rmSync(leakedEntry, { recursive: true, force: true });
				if (previousTrace === undefined)
					delete process.env.PI_LENS_TMP_HYGIENE_TRACE;
				else process.env.PI_LENS_TMP_HYGIENE_TRACE = previousTrace;
			}
		});
	});
});
