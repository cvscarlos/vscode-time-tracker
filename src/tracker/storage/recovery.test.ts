import * as assert from 'node:assert';
import { recoverSegments } from './recovery';
import { JournalRecord, LocalSegment } from '../types';

const context = { workspaceKey: 'ws', projectName: 'proj', branch: 'main' };

const closed: LocalSegment = {
	id: 'seg-closed',
	instanceId: 'inst',
	start: '2026-07-21T09:00:00.000Z',
	end: '2026-07-21T09:30:00.000Z',
	activeMilliseconds: 1_800_000,
	workspaceKey: 'ws',
	projectName: 'proj',
	branch: 'main',
	syncState: 'pending',
};

suite('recovery', () => {
	test('keeps closed segments as-is', () => {
		const records: JournalRecord[] = [{ type: 'close', segment: closed }];
		const result = recoverSegments(records, 'inst');
		assert.equal(result.length, 1);
		assert.equal(result[0].id, 'seg-closed');
	});

	test('closes a dangling open at its last checkpoint', () => {
		const records: JournalRecord[] = [
			{
				type: 'open',
				id: 'seg-open',
				start: '2026-07-21T10:00:00.000Z',
				instanceId: 'inst',
				context,
			},
			{ type: 'checkpoint', id: 'seg-open', lastActivity: '2026-07-21T10:00:30.000Z' },
			{ type: 'checkpoint', id: 'seg-open', lastActivity: '2026-07-21T10:05:00.000Z' },
		];
		const result = recoverSegments(records, 'inst');
		assert.equal(result.length, 1);
		assert.equal(result[0].id, 'seg-open');
		assert.equal(result[0].end, '2026-07-21T10:05:00.000Z');
		assert.equal(result[0].activeMilliseconds, 300_000);
		assert.equal(result[0].projectName, 'proj');
	});

	test('drops a dangling open that has no checkpoint', () => {
		const records: JournalRecord[] = [
			{
				type: 'open',
				id: 'seg-nocp',
				start: '2026-07-21T10:00:00.000Z',
				instanceId: 'inst',
				context,
			},
		];
		const result = recoverSegments(records, 'inst');
		assert.equal(result.length, 0);
	});
});
