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
	/** The idle-credit tail: end - lastActivity. Time within activeMilliseconds
	 * that was credited via the idle cap rather than real activity. */
	idleMilliseconds: number;
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
	/** The checkpoint's write time — distinct from lastActivity, which tracks
	 * the last edit/activity. Used by recovery as the freshness signal and the
	 * recovered end, so a focused reading window (no edits, but alive) is not
	 * misread as stale. */
	at: string;
}

export interface CloseRecord {
	type: 'close';
	segment: LocalSegment;
}

export type JournalRecord = OpenRecord | CheckpointRecord | CloseRecord;
