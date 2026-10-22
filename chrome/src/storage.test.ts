import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChromeOutboxStore, StorageCache, type StorageArea } from './storage.ts';
import type { ChromeSegment } from './tracker.ts';

function memoryArea(): StorageArea {
	const items = new Map<string, unknown>();
	return {
		get: async () => Object.fromEntries(items),
		set: async (values) => {
			for (const [key, value] of Object.entries(values)) {
				items.set(key, value);
			}
		},
		remove: async (key) => {
			items.delete(key);
		},
	};
}

const segment: ChromeSegment = {
	id: 'seg-1',
	instanceId: 'chrome',
	start: '2026-10-22T10:00:00.000Z',
	end: '2026-10-22T10:05:00.000Z',
	activeMilliseconds: 300_000,
	idleMilliseconds: 0,
	workspaceKey: 'chrome:acme',
	projectName: 'acme',
	branch: 'Chrome',
	syncState: 'pending',
	host: 'www.reddit.com',
	rule: '*.reddit.com',
};

test('a segment leaves the outbox once delivered to every destination', async () => {
	const area = memoryArea();
	const cache = await StorageCache.load(area);
	const store = new ChromeOutboxStore(cache);
	store.append({ type: 'close', segment });
	assert.deepEqual(
		store.listUndelivered(['solidtime']).map((s) => s.id),
		['seg-1']
	);
	assert.deepEqual(store.segmentsByIds(['seg-1']), [segment]);

	store.markDelivered('seg-1', 'solidtime');
	store.compact(['solidtime']);
	await cache.flushed();

	const reloaded = new ChromeOutboxStore(await StorageCache.load(area));
	assert.deepEqual(reloaded.listUndelivered(['solidtime']), []);
});

test('a failed storage write does not stop later writes from being saved', async () => {
	const area = memoryArea();
	const healthySet = area.set;
	let isFull = true;
	area.set = async (values) => {
		if (isFull) {
			throw new Error('QUOTA_BYTES quota exceeded');
		}
		await healthySet(values);
	};
	const cache = await StorageCache.load(area);
	await assert.rejects(cache.update('first', 1));
	isFull = false;
	await cache.update('second', 2);
	const reloaded = await StorageCache.load(area);
	assert.equal(reloaded.get('second'), 2);
});
