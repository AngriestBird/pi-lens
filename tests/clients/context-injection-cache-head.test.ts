/**
 * #4631, at tier 2 (#4632's slice-0 pilot): the prompt-cache prefix is what the
 * PROVIDER receives, across turns.
 *
 * pi 0.87+ hands a `context` handler the conversation with every system message
 * filtered out; when that handler returns a changed list, pi rebuilds one
 * merged system head from every system message (`restoreSystemMessages`). The
 * head bytes then differ from the one the provider cached, so every injecting
 * turn missed the prompt cache. A bare handler-return test cannot see this: the
 * defect is the host's post-processing of the return, observed on the next
 * request. So this file runs a real `AgentSession` (pi's own services and
 * session, pi-ai's `fauxProvider`) and asserts the messages pi actually sent.
 *
 * The expected head comes from pi-ai's own replay (`getCurrentSystemMessage`,
 * `collapseSystemMessages`), never a hand-rolled merge.
 */
import * as path from "node:path";
import {
	type FauxResponseStep,
	collapseSystemMessages,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	normalizeContext,
} from "@earendil-works/pi-ai";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { _resetSessionLifecycleForTests } from "../../clients/session-lifecycle.js";
import extension from "../../index.js";
import {
	piSessionEnv,
	startPiSession,
	type PiSessionHandle,
} from "../support/pi-session.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./test-utils.js";

const TMP_PREFIX = "pi-lens-4631-";

/** The same flags every real-session witness passes; none may reach a tool. */
const FLAGS = new Map<string, boolean>([
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
]);

let env: ReturnType<typeof setupTestEnvironment>;
let root: string;
let handle: PiSessionHandle | undefined;

beforeEach(() => {
	_resetSessionLifecycleForTests();
	env = setupTestEnvironment(TMP_PREFIX);
	root = path.join(env.tmpDir, "fixture");
	for (const [key, value] of Object.entries(piSessionEnv(root)))
		vi.stubEnv(key, value);
});

afterEach(async () => {
	try {
		await handle?.dispose();
		handle = undefined;
	} finally {
		_resetSessionLifecycleForTests();
		vi.unstubAllEnvs();
		env.cleanup();
	}
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});

function start(
	responses: readonly FauxResponseStep[],
): Promise<PiSessionHandle> {
	return startPiSession({
		root,
		responses,
		extensionFactories: [extension],
		flags: FLAGS,
	});
}

describe("#4631 the injecting turn keeps the prompt-cache head pi sent before it", () => {
	it("keeps the system head byte-identical on an injecting turn", async () => {
		handle = await start([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			fauxAssistantMessage("third answer"),
		]);
		const { requests } = handle;

		await handle.prompt("first question");
		const before = requests.at(-1);
		if (!before) throw new Error("the plain turn sent no request");

		handle.stageGuidance(
			"NARROW-DIFF-GUIDANCE: change only the line under test",
		);
		await handle.prompt("second question");
		const injecting = requests.at(-1);
		expect(injecting).toBeDefined();
		const sent = injecting as NonNullable<typeof injecting>;

		await handle.prompt("third question");
		const after = requests.at(-1);
		if (!after) throw new Error("the follow-up turn sent no request");

		// The transcript's own head is the only system message: the injection
		// never makes the host rebuild one.
		expect(sent.filter((message) => message.role === "system")).toHaveLength(1);
		// pi's own replay of this transcript is the head the provider received.
		expect(sent[0]).toEqual(getCurrentSystemMessage(sent));
		// Nothing is mid-list, so pi's collapse is a no-op for this request.
		expect(
			collapseSystemMessages(normalizeContext({ messages: [...sent] }))
				.messages,
		).toEqual(sent);
		// The cached prefix survives BYTE for byte: the provider hashes the
		// serialized message, so key order and values both count. The previous
		// turn's head, and the following turn's, are the same bytes.
		expect(JSON.stringify(sent[0])).toBe(JSON.stringify(before[0]));
		expect(JSON.stringify(after[0])).toBe(JSON.stringify(before[0]));
		// The payload still lands, on the last user message.
		expect(JSON.stringify(sent.at(-1))).toContain("NARROW-DIFF-GUIDANCE");
	});

	it("keeps the earlier prefix when a lazy-tool activation appends its delta", async () => {
		handle = await start([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage(
				fauxToolCall("pi_lens_activate_tools", { tools: ["ast_grep_search"] }),
			),
			fauxAssistantMessage("activation answer"),
			fauxAssistantMessage("third answer"),
		]);
		const { requests } = handle;

		await handle.prompt("first question");
		const plain = requests.at(-1);
		if (!plain) throw new Error("the plain turn sent no request");

		// pi appends one system message announcing the tool delta before the
		// request that follows the activation, which is the mid-list shape
		// `restoreSystemMessages` used to fold into the head.
		await handle.prompt("activate the search tool");
		const requestBeforeActivation = requests.at(-2);
		const activated = requests.at(-1);
		if (!requestBeforeActivation || !activated)
			throw new Error("the activation turn did not send both requests");
		const delta = activated.at(-1);
		expect(delta?.role).toBe("system");
		if (delta?.role !== "system")
			throw new Error("the activation turn appended no system delta");
		expect(delta.toolsAdded?.map((tool) => tool.name)).toContain(
			"ast_grep_search",
		);
		// The delta is only appended: the earlier request prefix and the head
		// are byte-identical.
		expect(activated.slice(0, requestBeforeActivation.length)).toEqual(
			requestBeforeActivation,
		);
		expect(JSON.stringify(activated[0])).toBe(JSON.stringify(plain[0]));

		handle.stageGuidance("ACTIVATION-GUIDANCE: keep the delta mid-list");
		await handle.prompt("third question");
		const injecting = requests.at(-1);
		if (!injecting) throw new Error("the injecting turn sent no request");

		// Injecting with the delta present keeps the whole earlier transcript,
		// delta included, as the unchanged prefix, byte for byte.
		expect(injecting.slice(0, activated.length)).toEqual(activated);
		expect(JSON.stringify(injecting.slice(0, activated.length))).toBe(
			JSON.stringify(activated),
		);
		expect(JSON.stringify(injecting[0])).toBe(JSON.stringify(plain[0]));
		expect(injecting[activated.length - 1]).toEqual(delta);
		expect(JSON.stringify(injecting.at(-1))).toContain("ACTIVATION-GUIDANCE");
	});
});
