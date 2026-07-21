import * as assert from 'node:assert';
import { EntryInput, TimeSyncConnector } from './connector';
import { MappingStore } from './mappingStore';
import { SyncEngine } from './syncEngine';
import { FileOutboxStore } from '../tracker/storage/fileOutboxStore';
import { LocalSegment } from '../tracker/types';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const clock = () => new Date('2026-07-21T12:00:00Z');
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
function seg(id: string): LocalSegment {
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
	}
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
			projectNameFor: (s) => s.projectName,
			// eslint-disable-next-line unicorn/no-null -- SyncEngineDeps.taskNameFor contract uses null for "no task"
			taskNameFor: (s) => s.branch ?? null,
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
			projectNameFor: (s) => s.projectName,
			// eslint-disable-next-line unicorn/no-null -- SyncEngineDeps.taskNameFor contract uses null for "no task"
			taskNameFor: () => null,
			log: () => {},
			onStatus: () => {},
		});
		await engine.runOnce();
		assert.equal(connector.created.length, 0);
		assert.equal(store.listUndelivered().length, 0); // marked delivered via reconciliation
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
			projectNameFor: (s) => s.projectName,
			// eslint-disable-next-line unicorn/no-null -- SyncEngineDeps.taskNameFor contract uses null for "no task"
			taskNameFor: () => null,
			log: () => {},
			onStatus: () => {},
		});
		await engine.runOnce();
		assert.equal(mappings.getProjectId('ws'), 'p-proj');
	});
});
