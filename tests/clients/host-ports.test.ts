import { describe, expect, it } from "vitest";
import {
	createDefaultHostPorts,
	type HostPorts,
} from "../../clients/host-ports.js";

describe("HostPorts contract (#1358 S2)", () => {
	it("preserves absent-host feature-detection defaults", async () => {
		const ports = createDefaultHostPorts();
		expect(ports.trust.isProjectTrusted()).toBe("unknown");
		expect(ports.mode.current()).toBe("unknown");
		expect(ports.mode.supportsTuiWidget()).toBe(true);
		expect(ports.mode.suppressesUserNotify()).toBe(false);
		expect(ports.spawn.abortSignal()).toBeUndefined();
		expect(ports.spawn.isAllowed("test")).toBe(true);
		expect(ports.workspace.cwd()).toBeUndefined();
		expect(ports.workspace.projectRoot()).toBeUndefined();
		expect(ports.session.id()).toBeUndefined();
		expect(ports.flags.get("x")).toBeUndefined();
		expect(await ports.tools.has("x")).toBe(false);
		expect(ports.tools.getActive()).toEqual([]);
		expect(() => {
			ports.notify.user("x");
			ports.log.extension({ subsystem: "test", message: "x" });
			ports.log.debug("x");
			ports.log.sink("test")({ x: 1 });
			ports.emit.bus("x", {});
			ports.emit.lens("x", {});
			ports.status.set("x", "y");
			ports.render.invalidate();
			ports.tools.setActive(["x"]);
		}).not.toThrow();
	});

	it("lets a fake drive every capability group", async () => {
		const called: string[] = [];
		const fake: HostPorts = createDefaultHostPorts({
			notify: { user: () => called.push("notify") },
			trust: { isProjectTrusted: () => "trusted" },
			mode: { current: () => "rpc", supportsTuiWidget: () => false, suppressesUserNotify: () => false },
			log: { extension: () => called.push("extension"), debug: () => called.push("debug"), sink: () => () => called.push("sink") },
			emit: { bus: () => called.push("bus"), lens: () => called.push("lens") },
			status: { set: () => called.push("status") },
			spawn: { abortSignal: () => AbortSignal.abort(), isAllowed: () => false },
			render: { invalidate: () => called.push("render") },
			session: { id: () => "s1" },
			workspace: { cwd: () => "/cwd", projectRoot: () => "/root" },
			flags: { get: () => true },
			tools: { has: async () => true, getActive: () => ["read"], setActive: () => called.push("tools") },
		});
		fake.notify.user("x"); fake.log.extension({ subsystem: "x", message: "x" }); fake.log.debug("x"); fake.log.sink("x")({});
		fake.emit.bus("x", {}); fake.emit.lens("x", {}); fake.status.set("x", "x"); fake.render.invalidate(); fake.tools.setActive([]);
		expect(fake.trust.isProjectTrusted()).toBe("trusted");
		expect(fake.mode.current()).toBe("rpc");
		expect(fake.spawn.abortSignal()?.aborted).toBe(true);
		expect(fake.spawn.isAllowed("x")).toBe(false);
		expect(fake.session.id()).toBe("s1");
		expect(fake.workspace.cwd()).toBe("/cwd");
		expect(fake.workspace.projectRoot()).toBe("/root");
		expect(fake.flags.get("x")).toBe(true);
		expect(await fake.tools.has("x")).toBe(true);
		expect(fake.tools.getActive()).toEqual(["read"]);
		expect(called).toEqual(["notify", "extension", "debug", "sink", "bus", "lens", "status", "render", "tools"]);
	});
});
