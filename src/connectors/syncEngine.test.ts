import * as assert from 'node:assert';
import { EntryInput, TimeSyncConnector } from './connector';
import { MappingStore } from './mappingStore';
import { SyncEngine } from './syncEngine';
import { FileOutboxStore } from '../tracker/storage/fileOutboxStore';
import { Store } from '../tracker/storage/store';
import { LocalSegment } from '../tracker/types';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const clock = () => new Date('2026-07-21T12:00:00Z');
// Fixed "now" used for settlement math: 30+ minutes after the default seeded
// segment's end, well past SETTLE_MS, so existing tests see settled blocks.
const NOW_MS = Date.parse('2026-07-21T10:00:00.000Z');
const SETTLE_MS = 5 * 60_000;
const MERGE_GAP_MS = 2 * 60_000;

function tempStore(): FileOutboxStore {
	return new FileOutboxStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-sync-')), 'w', clock);
}
function memMemento() {
	const m = new Map<string, unknown>();
	return {
		get: <T>(k: string) => m.get(k) as T | undefined,
		update: async (k: string, v: unknown) => void m.set(k, v),
	};
}
function seg(id: string, overrides: Partial<LocalSegment> = {}): LocalSegment {
	return {
		id,
		instanceId: 'w',
		start: '2026-07-21T09:00:00.000Z',
		end: '2026-07-21T09:30:00.000Z',
		activeMilliseconds: 1_800_000,
		workspaceKey: 'ws',
		projectName: 'proj',
		branch: 'main',
		syncState: 'pending',
		...overrides,
	};
}

class FakeConnector implements TimeSyncConnector {
	created: EntryInput[] = [];
	projects = new Map<string, string>();
	constructor(private present = new Set<string>()) {}
	async resolveMember() {
		return { organizationId: 'org', memberId: 'mem' };
	}
	async findProjectByName() {
		// eslint-disable-next-line unicorn/no-null -- TimeSyncConnector contract uses null for "not found"
		return null;
	}
	async createProject(_o: string, name: string) {
		const id = 'p-' + name;
		this.projects.set(name, id);
		return id;
	}
	async findTaskByName() {
		// eslint-disable-next-line unicorn/no-null -- TimeSyncConnector contract uses null for "not found"
		return null;
	}
	async createTask(_o: string, _p: string, name: string) {
		return 't-' + name;
	}
	async listEntryMarkers() {
		return this.present;
	}
	async createEntry(_o: string, _m: string, e: EntryInput) {
		this.created.push(e);
		return 'entry-' + e.segmentId;
	}
	async updateEntryDescription() {}
}

suite('SyncEngine', () => {
	test('delivers an undelivered segment, provisions project, marks delivered', async () => {
		const store = tempStore();
		store.append({ type: 'close', segment: seg('a') });
		const connector = new FakeConnector();
		const engine = new SyncEngine({
			store,
			connector,
			mappings: new MappingStore(memMemento()),
			now: () => NOW_MS,
			settleMs: SETTLE_MS,
			mergeGapMs: MERGE_GAP_MS,
			log: () => {},
			onStatus: () => {},
		});
		await engine.runOnce();
		assert.equal(connector.created.length, 1);
		assert.equal(connector.created[0].segmentId, 'a');
		assert.equal(store.listUndelivered().length, 0);
	});

	test('does NOT re-create an entry whose marker is already present on the server', async () => {
		const store = tempStore();
		store.append({ type: 'close', segment: seg('b') });
		const connector = new FakeConnector(new Set(['b']));
		const engine = new SyncEngine({
			store,
			connector,
			mappings: new MappingStore(memMemento()),
			now: () => NOW_MS,
			settleMs: SETTLE_MS,
			mergeGapMs: MERGE_GAP_MS,
			log: () => {},
			onStatus: () => {},
		});
		await engine.runOnce();
		assert.equal(connector.created.length, 0);
		assert.equal(store.listUndelivered().length, 0); // marked delivered via reconciliation
	});

	test('does NOT create an entry when the segment was delivered after the claim', async () => {
		// A concurrent window delivered this segment between our listUndelivered()
		// snapshot and our claim. isDelivered() must gate the send to avoid a
		// duplicate, even though listUndelivered() still reported it.
		const delivered = new Set<string>();
		const claimed = new Set<string>();
		const store: Store = {
			append: () => {},
			recover: () => [],
			listUndelivered: () => [seg('d')],
			claim: (id: string) => {
				claimed.add(id);
				return true;
			},
			isDelivered: (id: string) => id === 'd', // already delivered elsewhere
			markDelivered: (id: string) => void delivered.add(id),
			compact: () => {},
		};
		const connector = new FakeConnector();
		const engine = new SyncEngine({
			store,
			connector,
			mappings: new MappingStore(memMemento()),
			now: () => NOW_MS,
			settleMs: SETTLE_MS,
			mergeGapMs: MERGE_GAP_MS,
			log: () => {},
			onStatus: () => {},
		});
		await engine.runOnce();
		assert.equal(connector.created.length, 0);
		assert.ok(claimed.has('d'));
	});

	test('caches a provisioned project id in the mapping store', async () => {
		const store = tempStore();
		store.append({ type: 'close', segment: seg('c') });
		const mappings = new MappingStore(memMemento());
		const connector = new FakeConnector();
		const engine = new SyncEngine({
			store,
			connector,
			mappings,
			now: () => NOW_MS,
			settleMs: SETTLE_MS,
			mergeGapMs: MERGE_GAP_MS,
			log: () => {},
			onStatus: () => {},
		});
		await engine.runOnce();
		assert.equal(mappings.getProjectId('ws'), 'p-proj');
	});

	test('merges two contiguous settled segments into one block and delivers a single entry', async () => {
		const store = tempStore();
		store.append({
			type: 'close',
			segment: seg('m1', { start: '2026-07-21T09:00:00.000Z', end: '2026-07-21T09:10:00.000Z' }),
		});
		store.append({
			type: 'close',
			segment: seg('m2', { start: '2026-07-21T09:11:00.000Z', end: '2026-07-21T09:20:00.000Z' }),
		});
		const connector = new FakeConnector();
		const engine = new SyncEngine({
			store,
			connector,
			mappings: new MappingStore(memMemento()),
			now: () => NOW_MS,
			settleMs: SETTLE_MS,
			mergeGapMs: MERGE_GAP_MS,
			log: () => {},
			onStatus: () => {},
		});
		await engine.runOnce();
		assert.equal(connector.created.length, 1);
		assert.equal(connector.created[0].segmentId, 'm1');
		assert.equal(connector.created[0].start, '2026-07-21T09:00:00.000Z');
		assert.equal(connector.created[0].end, '2026-07-21T09:20:00.000Z');
		assert.equal(store.listUndelivered().length, 0);
	});

	test('holds an unsettled segment: no entry created, segment stays undelivered', async () => {
		const store = tempStore();
		// Ends only 1 minute before "now" — well inside SETTLE_MS (5 minutes) —
		// so the block is not yet ready and must be held.
		store.append({ type: 'close', segment: seg('u1', { end: '2026-07-21T09:59:00.000Z' }) });
		const connector = new FakeConnector();
		const engine = new SyncEngine({
			store,
			connector,
			mappings: new MappingStore(memMemento()),
			now: () => NOW_MS,
			settleMs: SETTLE_MS,
			mergeGapMs: MERGE_GAP_MS,
			log: () => {},
			onStatus: () => {},
		});
		await engine.runOnce();
		assert.equal(connector.created.length, 0);
		assert.equal(store.listUndelivered().length, 1);
	});
});
