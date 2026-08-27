export interface EntryInput {
	segmentId: string;
	start: string; // ISO
	end: string; // ISO
	projectId: string | null;
	taskId: string | null;
	description: string; // WITHOUT the marker; connector appends [vsc:<segmentId>]
}

export class ConnectorError extends Error {
	constructor(
		message: string,
		readonly status: number | undefined,
		readonly isRetryable: boolean
	) {
		super(message);
	}
}

export function markerFor(segmentId: string): string {
	return `[vsc:${segmentId}]`;
}

/** Focus-vs-idle suffix for a delivered entry's description, e.g. ` (14m focus, 3m idle)`.
 * Shown only when idle credit reached at least a minute; otherwise the title stays clean. */
export function breakdownSuffix(focusMinutes: number, idleMinutes: number): string {
	return idleMinutes >= 1 ? ` (${focusMinutes}m focus, ${idleMinutes}m idle)` : '';
}
