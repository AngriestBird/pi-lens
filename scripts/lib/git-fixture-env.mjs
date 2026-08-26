import { execFileSync, execSync } from "node:child_process";

const SCRUBBED = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
];

function envFor(cwd, overrides) {
	const env = { ...process.env, ...(overrides ?? {}) };
	for (const name of SCRUBBED) delete env[name];
	env.GIT_CONFIG_GLOBAL = `${cwd}/gitconfig`;
	env.GIT_CONFIG_NOSYSTEM = "1";
	return env;
}

export function gitExecFileSync(args, options = {}) {
	const cwd = options.cwd ?? process.cwd();
	return execFileSync("git", args, {
		...options,
		env: envFor(cwd, options.env),
	});
}

export function gitExecSync(command, options = {}) {
	const cwd = options.cwd ?? process.cwd();
	return execSync(command, {
		...options,
		env: envFor(cwd, options.env),
	});
}
