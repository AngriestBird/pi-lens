export interface MemorySample {
	totalMb: number;
	availableMb: number;
	source: "meminfo" | "os";
}

export declare function readMemory(meminfoPath?: string): MemorySample;

export declare function parseMeminfo(text: string): {
	totalMb: number;
	availableMb: number;
	source: "meminfo";
};

export declare function shouldPrint(
	sample: { availableMb: number },
	state: {
		lastPrintedMb: number | null;
		thresholdMb: number;
		stepMb: number;
	},
): boolean;

export declare function formatVerdict(
	exit: { code: number | null; signal: string | null },
	watch: { totalMb: number; lowWaterMb: number; lowWaterAt: string | null },
): string;
