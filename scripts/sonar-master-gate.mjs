#!/usr/bin/env node
/**
 * Read SonarCloud's master quality gate and unresolved vulnerabilities once.
 * A gate error is a nightly quality failure; inability to read SonarCloud is
 * an outage, not evidence of a bad master, so it is reported as a warning and
 * exits successfully.
 */

const PROJECT_KEY = "apmantza_pi-lens";
const BRANCH = "master";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RENDERED_CONDITIONS = 50;
const MAX_RENDERED_FINDINGS = 50;

function apiUrl(pathname, params) {
	const base = process.env.SONAR_API_BASE_URL ?? "https://sonarcloud.io/api";
	const url = new URL(`${base.replace(/\/$/, "")}/${pathname}`);
	for (const [key, value] of Object.entries(params))
		url.searchParams.set(key, value);
	return url;
}

async function readJson(url, signal) {
	const response = await fetch(url, {
		signal,
		headers: { accept: "application/json" },
	});
	if (!response.ok)
		throw new Error(`${response.status} ${response.statusText}`);
	return response.json();
}

function conditionText(condition) {
	return `${condition.metricKey ?? "unknown metric"}: actual ${condition.actualValue ?? "n/a"}, threshold ${condition.errorThreshold ?? "n/a"}`;
}

function findingText(finding) {
	const component = String(finding.component ?? "unknown file").replace(
		/^.*?:/,
		"",
	);
	const location =
		finding.line == null ? component : `${component}:${finding.line}`;
	return `${finding.rule ?? "unknown rule"}, ${location}, ${finding.message ?? "no message"}`;
}

async function main() {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const [gate, issues] = await Promise.all([
			readJson(
				apiUrl("qualitygates/project_status", {
					projectKey: PROJECT_KEY,
					branch: BRANCH,
				}),
				controller.signal,
			),
			readJson(
				apiUrl("issues/search", {
					componentKeys: PROJECT_KEY,
					branch: BRANCH,
					resolved: "false",
					types: "VULNERABILITY",
					ps: "100",
				}),
				controller.signal,
			),
		]);
		const failingConditions = (gate.projectStatus?.conditions ?? []).filter(
			(condition) => condition.status === "ERROR",
		);
		const findings = issues.issues ?? [];
		if (gate.projectStatus?.status !== "OK") {
			console.error(
				`SonarCloud master quality gate: ${gate.projectStatus?.status ?? "UNKNOWN"}`,
			);
			if (failingConditions.length === 0)
				console.error("Failing conditions: none reported by SonarCloud");
			for (const condition of failingConditions.slice(
				0,
				MAX_RENDERED_CONDITIONS,
			)) {
				console.error(`- ${conditionText(condition)}`);
			}
			if (failingConditions.length > MAX_RENDERED_CONDITIONS)
				console.error(
					`- ... ${failingConditions.length - MAX_RENDERED_CONDITIONS} more condition(s)`,
				);
			console.error(`Open vulnerability findings: ${findings.length}`);
			for (const finding of findings.slice(0, MAX_RENDERED_FINDINGS))
				console.error(`- ${findingText(finding)}`);
			if (findings.length > MAX_RENDERED_FINDINGS)
				console.error(
					`- ... ${findings.length - MAX_RENDERED_FINDINGS} more finding(s)`,
				);
			return 1;
		}
		console.log(
			`SonarCloud master quality gate: OK (open vulnerability findings: ${findings.length})`,
		);
		return 0;
	} catch (error) {
		console.error(
			`⚠ SonarCloud master quality gate unavailable (${error?.message ?? error}); treating outage as non-quality failure.`,
		);
		return 0;
	} finally {
		clearTimeout(timeout);
	}
}

process.exitCode = await main();
