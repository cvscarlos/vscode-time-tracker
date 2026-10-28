import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuleMatch } from './rules.ts';
import { type ChromeSegment, TabTracker } from './tracker.ts';

const t0 = Date.parse('2026-10-22T10:00:00Z');
const reddit: RuleMatch = { project: 'acme', host: 'www.reddit.com', rule: '*.reddit.com' };
const stackoverflow: RuleMatch = {
	project: 'acme',
	host: 'stackoverflow.com',
	rule: 'stackoverflow.com',
};

function setup(taskName = 'Chrome') {
	const closed: ChromeSegment[] = [];
	let n = 0;
	const tracker = new TabTracker(
		{},
		{
			taskName,
			newId: () => `seg-${++n}`,
			onClose: (segment) => {
				closed.push(segment);
			},
		}
	);
	return { tracker, closed };
}

const ms = (iso: string) => Date.parse(iso) - t0;

test('returning within the grace keeps one continuous segment', () => {
	const { tracker, closed } = setup();
	tracker.observe(reddit, t0);
	tracker.observe(undefined, t0 + 5000);
	tracker.observe(reddit, t0 + 12_000);
	tracker.observe(stackoverflow, t0 + 60_000);
	assert.equal(closed.length, 1);
	assert.equal(ms(closed[0].start), 0);
	assert.equal(ms(closed[0].end), 60_000);
});

test('a worker woken late still credits exactly 15 s of grace', () => {
	const { tracker, closed } = setup();
	tracker.observe(reddit, t0);
	tracker.observe(undefined, t0 + 30_000);
	tracker.heartbeat(t0 + 100_000);
	assert.equal(closed.length, 1);
	assert.equal(ms(closed[0].end), 45_000);
	assert.equal(tracker.status(t0 + 100_000), 'off');
});

test('sleep ends the segment at the last heartbeat', () => {
	const { tracker, closed } = setup();
	tracker.observe(reddit, t0);
	tracker.heartbeat(t0 + 30_000);
	tracker.heartbeat(t0 + 60_000);
	tracker.observe(reddit, t0 + 2 * 3_600_000);
	assert.equal(closed.length, 1);
	assert.equal(ms(closed[0].end), 60_000);
	assert.equal(tracker.status(t0 + 2 * 3_600_000), 'tracking');
});

test('switching directly to another matched host closes the segment immediately', () => {
	const { tracker, closed } = setup();
	tracker.observe(reddit, t0);
	tracker.observe(stackoverflow, t0 + 40_000);
	assert.equal(closed.length, 1);
	assert.equal(ms(closed[0].end), 40_000);
	assert.equal(tracker.status(t0 + 41_000), 'tracking');
	assert.equal(tracker.snapshot().open?.match.host, 'stackoverflow.com');
});

test('status shows the grace while away, then off once it expires', () => {
	const { tracker } = setup();
	assert.equal(tracker.status(t0), 'off');
	tracker.observe(reddit, t0);
	tracker.observe(undefined, t0 + 10_000);
	assert.equal(tracker.status(t0 + 20_000), 'grace');
	assert.equal(tracker.status(t0 + 25_000), 'off');
});

test('a closed segment carries the project, the fixed Chrome task, host and rule', () => {
	const { tracker, closed } = setup();
	tracker.observe(reddit, t0);
	tracker.observe(stackoverflow, t0 + 90_000);
	assert.deepEqual(closed[0], {
		id: 'seg-1',
		instanceId: 'chrome',
		start: new Date(t0).toISOString(),
		end: new Date(t0 + 90_000).toISOString(),
		activeMilliseconds: 90_000,
		idleMilliseconds: 0,
		workspaceKey: 'chrome:acme',
		projectName: 'acme',
		branch: 'Chrome',
		syncState: 'pending',
		host: 'www.reddit.com',
		rule: '*.reddit.com',
	});
});

test('a tracker rebuilt from its snapshot continues the same open segment', () => {
	const { tracker } = setup();
	tracker.observe(reddit, t0);
	const persisted = JSON.stringify(tracker.snapshot());
	const closed: ChromeSegment[] = [];
	const revived = new TabTracker(JSON.parse(persisted), {
		taskName: 'Chrome',
		newId: () => 'other',
		onClose: (segment) => {
			closed.push(segment);
		},
	});
	revived.observe(stackoverflow, t0 + 30_000);
	assert.equal(closed[0].id, 'seg-1');
	assert.equal(ms(closed[0].start), 0);
});

test('closed segments are filed under the browser task given to the tracker', () => {
	const { tracker, closed } = setup('Firefox');
	tracker.observe(reddit, t0);
	tracker.observe(stackoverflow, t0 + 60_000);
	assert.equal(closed[0].branch, 'Firefox');
});

test('a different rule on the same host starts a new segment, so each keeps its own rule', () => {
	const { tracker, closed } = setup();
	tracker.observe(reddit, t0);
	tracker.observe({ ...reddit, rule: 'www.reddit.com/r/acme' }, t0 + 30_000);
	assert.equal(closed.length, 1);
	assert.equal(closed[0].rule, '*.reddit.com');
});
