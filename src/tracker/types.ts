export interface TrackingContext {
	workspaceKey: string;
	projectName: string;
	repositoryKey?: string;
	branch?: string;
}

export interface LocalSegment {
	id: string;
	instanceId: string;
	start: string;
	end: string;
	activeMilliseconds: number;
	workspaceKey: string;
	projectName: string;
	repositoryKey?: string;
	branch?: string;
	syncState: 'pending';
}

export interface OpenRecord {
	type: 'open';
	id: string;
	start: string;
	instanceId: string;
	context: TrackingContext;
}

export interface CheckpointRecord {
	type: 'checkpoint';
	id: string;
	lastActivity: string;
}

export interface CloseRecord {
	type: 'close';
	segment: LocalSegment;
}

export type JournalRecord = OpenRecord | CheckpointRecord | CloseRecord;
