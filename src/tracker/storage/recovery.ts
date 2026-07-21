import { CheckpointRecord, JournalRecord, LocalSegment, OpenRecord } from '../types';
import { SegmentStore } from './segmentStore';

export function recoverSegments(records: JournalRecord[], instanceId: string): LocalSegment[] {
	const segments: LocalSegment[] = [];
	const closedIds = new Set<string>();
	const opens = new Map<string, OpenRecord>();
	const lastCheckpoint = new Map<string, CheckpointRecord>();

	for (const record of records) {
		if (record.type === 'close') {
			segments.push(record.segment);
			closedIds.add(record.segment.id);
		} else if (record.type === 'open') {
			opens.set(record.id, record);
		} else {
			lastCheckpoint.set(record.id, record);
		}
	}

	for (const [id, open] of opens) {
		if (closedIds.has(id)) {
			continue;
		}
		const checkpoint = lastCheckpoint.get(id);
		if (!checkpoint) {
			continue;
		}
		const start = Date.parse(open.start);
		const end = Date.parse(checkpoint.lastActivity);
		segments.push({
			id,
			instanceId,
			start: open.start,
			end: checkpoint.lastActivity,
			activeMilliseconds: end - start,
			workspaceKey: open.context.workspaceKey,
			projectName: open.context.projectName,
			repositoryKey: open.context.repositoryKey,
			branch: open.context.branch,
			syncState: 'pending',
		});
	}

	return segments;
}

export function buildSegmentStore(records: JournalRecord[], instanceId: string): SegmentStore {
	const store = new SegmentStore();
	for (const segment of recoverSegments(records, instanceId)) {
		store.add(segment);
	}
	return store;
}
