import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "../clients/deps/js-yaml.js";

// GitHub's repository default is the only permission source not represented in
// workflow YAML. This repository keeps the historical write-capable default;
// explicit workflow/job permissions must narrow it.
export const REPOSITORY_DEFAULT_PERMISSIONS = "write-all";
export const WRITE_SCOPES = new Set([
	"actions",
	"checks",
	"contents",
	"deployments",
	"discussions",
	"id-token",
	"issues",
	"packages",
	"pages",
	"pull-requests",
	"repository-projects",
	"security-events",
	"statuses",
]);

function permissionMap(value) {
	if (value === "write-all")
		return Object.fromEntries([...WRITE_SCOPES].map((key) => [key, "write"]));
	if (value === "read-all")
		return Object.fromEntries([...WRITE_SCOPES].map((key) => [key, "read"]));
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => WRITE_SCOPES.has(key)),
	);
}

export function effectivePermissions(workflowPermissions, jobPermissions) {
	if (jobPermissions !== undefined) return permissionMap(jobPermissions);
	if (workflowPermissions !== undefined)
		return permissionMap(workflowPermissions);
	return permissionMap(REPOSITORY_DEFAULT_PERMISSIONS);
}

export function writeScopes(permissions) {
	return Object.entries(permissions)
		.filter(([, value]) => value === "write")
		.map(([key]) => key)
		.sort();
}

export function workflowDocument(source) {
	return yaml.load(source) ?? {};
}

export function dispatchableJobs(source, workflowPath = "workflow.yml") {
	const workflow = workflowDocument(source);
	const on = workflow.on;
	const triggers =
		typeof on === "string"
			? [on]
			: Array.isArray(on)
				? on
				: on && typeof on === "object"
					? Object.keys(on)
					: [];
	if (!triggers.includes("workflow_dispatch")) return [];
	return Object.entries(workflow.jobs ?? {}).map(([name, job]) => ({
		id: `${workflowPath}:${name}`,
		name,
		job,
		permissions: effectivePermissions(workflow.permissions, job.permissions),
		writeScopes: writeScopes(
			effectivePermissions(workflow.permissions, job.permissions),
		),
	}));
}

export function hasWriteToken(job) {
	return job.writeScopes.length > 0;
}

function guardText(value) {
	return (
		typeof value === "string" &&
		(value.includes("github.event_name == 'schedule'") ||
			value.includes("github.ref == 'refs/heads/master'"))
	);
}

export function guardSkipsOnRef(job, ref) {
	if (guardText(job.job.if))
		return ref !== "master" && ref !== "refs/heads/master";
	return false;
}

const WRITER_HINT =
	/\b(?:git\s+[^\n;|&]*push|gh\s+[^\n;|&]*(?:create|edit|comment|close|merge|delete|run|upload)|curl\b|wget\b|python\b[^\n;|&]*(?:requests\.|urllib)|node\s+-e\b[^\n;|&]*(?:fetch|request)|(?:npm|pnpm|yarn|bun)\s+(?:publish|dist-tag|deprecate|unpublish)|\.sh\b|node\s+(?:\.\/)?scripts\/(?:merge-train-warden|notify|upsert|detect|ci-verdict|backfill|check-close)|actions\/(?:stale|github-script)|peter-evans\/)/i;

export function writerSteps(job) {
	return (job.job.steps ?? []).flatMap((step, index) => {
		const text = `${step.run ?? ""} ${step.uses ?? ""}`;
		return WRITER_HINT.test(text) ? [step.name ?? `step ${index}`] : [];
	});
}

function cli() {
	const [file, flag, ref = "master"] = process.argv.slice(2);
	if (!file) {
		console.error(
			"usage: node scripts/dispatch-safety.mjs <workflow> [--ref <branch>]",
		);
		process.exitCode = 2;
		return;
	}
	const source = readFileSync(resolve(process.cwd(), file), "utf8");
	for (const job of dispatchableJobs(source, file)) {
		const writers = writerSteps(job);
		console.log(
			JSON.stringify({
				job: job.id,
				writers,
				guardSkips: guardSkipsOnRef(job, flag === "--ref" ? ref : "master"),
				writeScopes: job.writeScopes,
			}),
		);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	cli();
