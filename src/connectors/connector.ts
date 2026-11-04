export interface EntryInput {
	segmentId: string;
	start: string; // ISO
	end: string; // ISO
	projectId: string | null;
	taskId: string | null;
	description: string; // WITHOUT the marker; connector appends [<markerPrefix>:<segmentId>]
	markerPrefix?: MarkerPrefix;
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

/** Which extension created an entry: VS Code (`vsc`) or Chrome (`chr`). */
export type MarkerPrefix = 'vsc' | 'chr';

export function markerFor(segmentId: string, prefix: MarkerPrefix = 'vsc'): string {
	return `[${prefix}:${segmentId}]`;
}

/** Focus-vs-idle suffix for a delivered entry's description, e.g. ` (14m focus, 3m idle)`.
 * Shown only when idle credit reached at least a minute; otherwise the title stays clean. */
export function breakdownSuffix(focusMinutes: number, idleMinutes: number): string {
	return idleMinutes >= 1 ? ` (${focusMinutes}m focus, ${idleMinutes}m idle)` : '';
}
