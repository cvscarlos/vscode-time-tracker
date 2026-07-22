import * as assert from 'node:assert';
import { SolidtimeDestination, SolidtimeConnectorLike } from './solidtimeDestination';
import { MappingStore } from '../mappingStore';
import { EntryInput } from '../connector';
import { DeliveryBlock } from '../destination';

function memMemento() {
	const map = new Map<string, unknown>();
	return {
		get: <T>(k: string) => map.get(k) as T | undefined,
		update: (k: string, v: unknown) => {
			map.set(k, v);
			return Promise.resolve();
		},
	};
}

class FakeConnector implements SolidtimeConnectorLike {
	entries: EntryInput[] = [];
	updated: { id: string; description: string }[] = [];
	present = new Set<string>();
	async resolveMember() {
		return { organizationId: 'org', memberId: 'mem' };
	}
	async listEntryMarkers() {
		return this.present;
	}
	async findProjectByName() {
		return 'proj-id';
	}
	async createProject() {
		return 'proj-id';
	}
	async findTaskByName() {
		return 'task-id';
	}
	async createTask() {
		return 'task-id';
	}
	async createEntry(_org: string, _mem: string, entry: EntryInput) {
		this.entries.push(entry);
		return 'entry-1';
	}
	async updateEntryDescription(_org: string, id: string, description: string) {
		this.updated.push({ id, description });
	}
}

const block: DeliveryBlock = {
	segmentIds: ['seg-1'],
	start: new Date(0).toISOString(),
	end: new Date(60_000).toISOString(),
	workspaceKey: 'ws',
	projectName: 'proj',
	branch: 'main',
};

suite('SolidtimeDestination', () => {
	test('deliver resolves project/task and creates an entry, returning its id', async () => {
		const connector = new FakeConnector();
		const dest = new SolidtimeDestination(connector, new MappingStore(memMemento()));
		await dest.prepare(block.start);
		const ref = await dest.deliver(block);
		assert.equal(ref, 'entry-1');
		assert.equal(connector.entries.length, 1);
		assert.equal(connector.entries[0].projectId, 'proj-id');
		assert.equal(connector.entries[0].taskId, 'task-id');
	});

	test('deliver skips and returns "" when the marker is already present', async () => {
		const connector = new FakeConnector();
		connector.present = new Set(['seg-1']);
		const dest = new SolidtimeDestination(connector, new MappingStore(memMemento()));
		await dest.prepare(block.start);
		const ref = await dest.deliver(block);
		assert.equal(ref, '');
		assert.equal(connector.entries.length, 0);
	});

	test('retitle updates the entry description with the preserved marker', async () => {
		const connector = new FakeConnector();
		const dest = new SolidtimeDestination(connector, new MappingStore(memMemento()));
		await dest.prepare(block.start);
		await dest.retitle('entry-1', 'fix: thing', {
			markerId: 'seg-1',
			projectName: 'proj',
			branch: 'main',
			startMs: 0,
			endMs: 60_000,
		});
		assert.deepEqual(connector.updated, [{ id: 'entry-1', description: 'fix: thing [vsc:seg-1]' }]);
	});

	test('retitle is a no-op for an empty ref', async () => {
		const connector = new FakeConnector();
		const dest = new SolidtimeDestination(connector, new MappingStore(memMemento()));
		await dest.prepare(block.start);
		await dest.retitle('', 'x', { markerId: 'seg-1', projectName: 'proj', startMs: 0, endMs: 1 });
		assert.equal(connector.updated.length, 0);
	});
});
