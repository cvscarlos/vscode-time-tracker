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
