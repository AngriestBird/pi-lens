/** Session-local attribution captured before a stale message_end can drain. */

let lastStableSessionId: string | undefined;

/** Remember the stable id used by a live message_end's own cache row. */
export function noteLiveMessageEndSessionId(
	sessionId: string | undefined,
): void {
	lastStableSessionId = sessionId;
}

/** Return the last id observed while a message_end ctx was still live. */
export function getLastLiveMessageEndSessionId(): string | undefined {
	return lastStableSessionId;
}

/** Clear the attribution anchor at the real session boundary. */
export function resetMessageEndAttribution(): void {
	lastStableSessionId = undefined;
}
