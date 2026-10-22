import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSites } from './describe.ts';
import type { ChromeSegment } from './tracker.ts';

function segment(host: string, rule: string, seconds: number): ChromeSegment {
	return {
		id: `${host}-${seconds}`,
		instanceId: 'chrome',
		start: new Date(0).toISOString(),
		end: new Date(seconds * 1000).toISOString(),
		activeMilliseconds: seconds * 1000,
		idleMilliseconds: 0,
		workspaceKey: 'chrome:acme',
		projectName: 'acme',
		branch: 'Chrome',
		syncState: 'pending',
		host,
		rule,
	};
}

test('lists hosts by time spent, with the matched rule when it differs from the host', () => {
	const description = describeSites([
		segment('www.reddit.com', '*.reddit.com', 120),
		segment('feature-x--preview.medium.com', '*--preview.medium.com', 30),
		segment('stackoverflow.com', 'stackoverflow.com', 90),
		segment('www.reddit.com', '*.reddit.com', 60),
	]);
	assert.equal(
		description,
		'www.reddit.com (*.reddit.com), stackoverflow.com, feature-x--preview.medium.com (*--preview.medium.com)'
	);
});

test('a long site list is cut on an item boundary', () => {
	const segments = Array.from({ length: 40 }, (_, index) =>
		segment(`host-${index}.reddit.com`, '*.reddit.com', 100 - index)
	);
	const description = describeSites(segments, 100);
	assert.ok(description.length <= 100);
	assert.ok(description.endsWith(', …'));
	const items = description.slice(0, -', …'.length).split(', ');
	for (const item of items) {
		assert.match(item, /^host-\d+\.reddit\.com \(\*\.reddit\.com\)$/);
	}
});

test('the description plus the chr marker fits the 500-character SolidTime limit', () => {
	// Short hosts fill the list right up to the cap, so the cap itself is what's tested.
	const segments = Array.from({ length: 100 }, (_, index) =>
		segment(`${index}.io`, `${index}.io`, 200 - index)
	);
	const marker = ` [chr:${crypto.randomUUID()}]`;
	assert.ok(`${describeSites(segments)}${marker}`.length <= 500);
});
