import { afterEach, describe, expect, it } from "vitest";
import {
	adoptProjectTrustFromContext,
	getProjectTrustState,
	isLspSpawnAllowedByTrust,
	isToolInstallAllowedByTrust,
	projectTrustDenialReason,
	readProjectTrustFromContext,
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.ts";

afterEach(() => {
	resetProjectTrust();
});

describe("readProjectTrustFromContext (#1334 S5)", () => {
	it("maps the host boolean onto the three-valued state", () => {
		expect(readProjectTrustFromContext({ isProjectTrusted: () => true })).toBe(
			"trusted",
		);
		expect(readProjectTrustFromContext({ isProjectTrusted: () => false })).toBe(
			"untrusted",
		);
	});

	it("reports 'unknown' when the host has no trust surface at all", () => {
		expect(readProjectTrustFromContext({})).toBe("unknown");
		expect(readProjectTrustFromContext(undefined)).toBe("unknown");
		expect(readProjectTrustFromContext(null)).toBe("unknown");
		// Present but not callable — an older/foreign host shape.
		expect(readProjectTrustFromContext({ isProjectTrusted: true })).toBe(
			"unknown",
		);
	});

	it("never guesses 'untrusted' from a throwing or non-boolean accessor", () => {
		expect(
			readProjectTrustFromContext({
				isProjectTrusted: () => {
					throw new Error("host blew up");
				},
			}),
		).toBe("unknown");
		expect(
			readProjectTrustFromContext({ isProjectTrusted: () => undefined }),
		).toBe("unknown");
	});
});

describe("project-trust policy gates", () => {
	it("defaults to fail-open when nothing has been adopted", () => {
		expect(getProjectTrustState()).toBe("unknown");
		expect(isToolInstallAllowedByTrust()).toBe(true);
		expect(isLspSpawnAllowedByTrust()).toBe(true);
		expect(projectTrustDenialReason()).toBeUndefined();
	});

	it("blocks installs and LSP spawns only on an explicit host denial", () => {
		setProjectTrustState("trusted");
		expect(isToolInstallAllowedByTrust()).toBe(true);
		expect(isLspSpawnAllowedByTrust()).toBe(true);
		expect(projectTrustDenialReason()).toBeUndefined();

		setProjectTrustState("untrusted");
		expect(isToolInstallAllowedByTrust()).toBe(false);
		expect(isLspSpawnAllowedByTrust()).toBe(false);
		expect(projectTrustDenialReason()).toContain("not trusted");
	});

	it("adopts from a ctx and latches the result", () => {
		expect(adoptProjectTrustFromContext({ isProjectTrusted: () => false })).toBe(
			"untrusted",
		);
		expect(getProjectTrustState()).toBe("untrusted");

		// A later session_start on a trusted cwd must lift the gate again.
		expect(adoptProjectTrustFromContext({ isProjectTrusted: () => true })).toBe(
			"trusted",
		);
		expect(isLspSpawnAllowedByTrust()).toBe(true);

		// …and an older host re-reads as "unknown", not as a sticky denial.
		expect(adoptProjectTrustFromContext({})).toBe("unknown");
		expect(isToolInstallAllowedByTrust()).toBe(true);
	});
});
