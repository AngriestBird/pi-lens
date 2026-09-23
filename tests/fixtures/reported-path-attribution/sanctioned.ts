import * as path from "node:path";
import { pathsEqual } from "../../../clients/path-utils.js";

export function parse(raw: string, cwd: string, target: string) {
	const match = raw.match(/^(.*?):(\d+):(\d+)/);
	return match && pathsEqual(path.resolve(cwd, match[1]), target);
}
