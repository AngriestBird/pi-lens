export const FORCE_WORKER_FAIL_ENV: string;
export const FORCED_ERROR_MARKER: string;
export function rpcMessageFailure(message: unknown): string | undefined;
export function logRecordFailure(
	file: "extension.log" | "latency.log",
	record: unknown,
	allowFallbackReason?: string,
): string | undefined;
