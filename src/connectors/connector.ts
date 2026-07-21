export interface EntryInput {
	segmentId: string;
	start: string; // ISO
	end: string; // ISO
	projectId: string | null;
	taskId: string | null;
	description: string; // WITHOUT the marker; connector appends [vsc:<segmentId>]
}

export interface TimeSyncConnector {
	resolveMember(): Promise<{ organizationId: string; memberId: string }>;
	findProjectByName(organizationId: string, name: string): Promise<string | null>;
	createProject(organizationId: string, name: string): Promise<string>;
	findTaskByName(organizationId: string, projectId: string, name: string): Promise<string | null>;
	createTask(organizationId: string, projectId: string, name: string): Promise<string>;
	listEntryMarkers(
		organizationId: string,
		memberId: string,
		sinceIso: string
	): Promise<Set<string>>; // set of segmentIds already present
	createEntry(organizationId: string, memberId: string, entry: EntryInput): Promise<string>; // returns the created entry id
	updateEntryDescription(organizationId: string, entryId: string, description: string): Promise<void>;
}

export class ConnectorError extends Error {
	constructor(
		message: string,
		readonly status: number | undefined,
		readonly retryable: boolean
	) {
		super(message);
	}
}

export function markerFor(segmentId: string): string {
	return `[vsc:${segmentId}]`;
}
