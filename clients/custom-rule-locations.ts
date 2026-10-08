import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.js";

/** Relocatable machine-level root for rules shared by all projects. */
export function getUserRuleRoot(): string {
	return path.join(getGlobalPiLensDir(), "rules");
}
