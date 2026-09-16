export interface Win32Gate {
	file: string;
	line: number;
}

/** Tolerant read for a path this module's own walk produced (#3082); warns
 *  once per distinct path and returns undefined when the file has vanished. */
export declare function readWalkedFile(absolute: string): string | undefined;
export declare function findWin32Gates(cwd?: string): Win32Gate[];
export declare function getWin32GateFiles(cwd?: string): string[];
export declare function getWin32LaneFiles(cwd?: string): string[];
