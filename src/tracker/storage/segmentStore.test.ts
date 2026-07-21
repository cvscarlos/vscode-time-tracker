import * as assert from 'node:assert';
import { SegmentStore } from './segmentStore';
import { LocalSegment } from '../types';

function seg(overrides: Partial<LocalSegment>): LocalSegment {
	return {
		id: 'seg',
		instanceId: 'inst',
		start: '2026-07-21T09:00:00.000Z',
		end: '2026-07-21T09:10:00.000Z',
		activeMilliseconds: 600_000,
		workspaceKey: 'ws',
		projectName: 'proj',
		syncState: 'pending',
		...overrides,
	};
}

suite('SegmentStore', () => {
	test('sums total active time for a given day', () => {
		const store = new SegmentStore();
		store.add(seg({ id: 'a', activeMilliseconds: 600_000 }));
		store.add(seg({ id: 'b', activeMilliseconds: 300_000 }));
		store.add(seg({ id: 'c', start: '2026-07-20T09:00:00.000Z', activeMilliseconds: 999 }));
		assert.equal(store.totalMillisecondsOn('2026-07-21'), 900_000);
	});

	test('groups totals by project for a day', () => {
		const store = new SegmentStore();
		store.add(seg({ id: 'a', projectName: 'proj', activeMilliseconds: 600_000 }));
		store.add(seg({ id: 'b', projectName: 'other', activeMilliseconds: 120_000 }));
		const totals = store.totalMillisecondsByProjectOn('2026-07-21');
		assert.equal(totals.get('proj'), 600_000);
		assert.equal(totals.get('other'), 120_000);
	});
});
