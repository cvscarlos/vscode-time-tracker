import * as assert from 'node:assert';
import { aggregate } from './aggregate';
import { LocalSegment } from '../tracker/types';

const NOW = Date.parse('2026-07-21T17:00:00.000Z');
const opts = { nowMs: NOW, settleMs: 5 * 60_000, mergeGapMs: 2 * 60_000 };

function seg(
	id: string,
	startIso: string,
	endIso: string,
	branch = 'main',
	idleMilliseconds = 0
): LocalSegment {
	return {
		id,
		instanceId: 'w',
		start: startIso,
		end: endIso,
		activeMilliseconds: Date.parse(endIso) - Date.parse(startIso),
		idleMilliseconds,
		workspaceKey: 'ws',
		projectName: 'proj',
		branch,
		syncState: 'pending',
	};
}

suite('aggregate', () => {
	test('merges two contiguous same-branch segments into one rounded block', () => {
		// 16:19:10–16:21:05 and 16:21:05–16:21:40, both settled (ended > 5min before NOW)
		const { blocks } = aggregate(
			[
				seg('a', '2026-07-21T16:19:10.000Z', '2026-07-21T16:21:05.000Z'),
				seg('b', '2026-07-21T16:21:05.000Z', '2026-07-21T16:21:40.000Z'),
			],
			opts
		);
		assert.equal(blocks.length, 1);
		assert.deepEqual(blocks[0].segmentIds, ['a', 'b']);
		assert.equal(blocks[0].start, '2026-07-21T16:19:00.000Z'); // round(16:19:10)
		assert.equal(blocks[0].end, '2026-07-21T16:22:00.000Z'); // round(16:21:40)
	});

	test('adjacent segments in different groups do not produce overlapping rounded blocks', () => {
		// Abut at 07:44:10; floor/ceil overlapped them by a minute, round-nearest makes them touch.
		const { blocks } = aggregate(
			[
				seg('a', '2026-07-21T07:42:30.000Z', '2026-07-21T07:44:10.000Z', 'main'),
				seg('b', '2026-07-21T07:44:10.000Z', '2026-07-21T08:02:40.000Z', 'dev'),
			],
			opts
		);
		assert.equal(blocks.length, 2);
		const a = blocks.find((x) => x.segmentIds[0] === 'a');
		const b = blocks.find((x) => x.segmentIds[0] === 'b');
		assert.ok(a && b && a.end <= b.start, `${a?.end} <= ${b?.start}`);
	});

	test('does not merge across a gap larger than mergeGapMs', () => {
		const { blocks } = aggregate(
			[
				seg('a', '2026-07-21T16:00:00.000Z', '2026-07-21T16:05:00.000Z'),
				seg('b', '2026-07-21T16:10:00.000Z', '2026-07-21T16:15:00.000Z'), // 5-min gap
			],
			opts
		);
		assert.equal(blocks.length, 2);
	});

	test('does not merge different branches', () => {
		const { blocks } = aggregate(
			[
				seg('a', '2026-07-21T16:00:00.000Z', '2026-07-21T16:05:00.000Z', 'main'),
				seg('b', '2026-07-21T16:05:00.000Z', '2026-07-21T16:10:00.000Z', 'dev'),
			],
			opts
		);
		assert.equal(blocks.length, 2);
	});

	test('holds an unsettled block (ended less than settleMs ago)', () => {
		const recentEnd = new Date(NOW - 60_000).toISOString(); // 1 min ago < 5-min settle
		const recentStart = new Date(NOW - 4 * 60_000).toISOString();
		const { blocks, discarded } = aggregate([seg('a', recentStart, recentEnd)], opts);
		assert.equal(blocks.length, 0);
		assert.deepEqual(discarded, []); // held, not settled — must not be discarded
	});

	test('drops a zero-length block (under one minute after rounding)', () => {
		// A zero-length segment on a minute boundary floors start and ceils end to the
		// same minute → rounded duration 0 (< 1 min) → dropped.
		const { blocks, discarded } = aggregate(
			[seg('a', '2026-07-21T16:00:00.000Z', '2026-07-21T16:00:00.000Z')],
			opts
		);
		assert.equal(blocks.length, 0);
		// Settled but sub-minute: safe to discard permanently rather than rescan forever.
		assert.deepEqual(discarded, ['a']);
	});

	test('splits a rounded block into focus/idle minutes from the summed segment idle', () => {
		// 5-minute block (both ends on a minute boundary, so rounding is exact)
		// with 3 minutes of summed idle credit -> 2 focus, 3 idle.
		const { blocks } = aggregate(
			[seg('a', '2026-07-21T16:00:00.000Z', '2026-07-21T16:05:00.000Z', 'main', 3 * 60_000)],
			opts
		);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].focusMinutes, 2);
		assert.equal(blocks[0].idleMinutes, 3);
		assert.equal(blocks[0].focusMinutes + blocks[0].idleMinutes, 5);
	});

	test('a block with no idle credit reports idleMinutes 0 and focusMinutes as the full duration', () => {
		const { blocks } = aggregate(
			[seg('a', '2026-07-21T16:00:00.000Z', '2026-07-21T16:05:00.000Z')],
			opts
		);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].idleMinutes, 0);
		assert.equal(blocks[0].focusMinutes, 5);
	});
});
