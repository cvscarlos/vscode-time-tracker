import * as assert from 'node:assert';
import { SolidtimeDestination, SolidtimeConnectorLike } from './solidtimeDestination';
import { MappingStore } from '../mappingStore';
import { ConnectorError, EntryInput } from '../connector';
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
	findProjectCalls = 0;
	findTaskCalls = 0;
	/** Set to make the next `createEntry` throw instead of succeeding. */
	failNextEntryWith: ConnectorError | undefined;
	async resolveMember() {
		return { organizationId: 'org', memberId: 'mem' };
	}
	async listEntryMarkers() {
		return this.present;
	}
	async findProjectByName() {
		this.findProjectCalls++;
		return 'proj-id';
	}
	async createProject() {
		return 'proj-id';
	}
	async findTaskByName() {
		this.findTaskCalls++;
		return 'task-id';
	}
	async createTask() {
		return 'task-id';
	}
	async createEntry(_org: string, _mem: string, entry: EntryInput) {
		if (this.failNextEntryWith) {
			const error = this.failNextEntryWith;
			this.failNextEntryWith = undefined;
			throw error;
		}
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
		const dest = new SolidtimeDestination(
			connector,
			new MappingStore(memMemento()),
			'https://app.solidtime.io'
		);
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
		const dest = new SolidtimeDestination(
			connector,
			new MappingStore(memMemento()),
			'https://app.solidtime.io'
		);
		await dest.prepare(block.start);
		const ref = await dest.deliver(block);
		assert.equal(ref, '');
		assert.equal(connector.entries.length, 0);
	});

	test('retitle updates the entry description with the preserved marker', async () => {
		const connector = new FakeConnector();
		const dest = new SolidtimeDestination(
			connector,
			new MappingStore(memMemento()),
			'https://app.solidtime.io'
		);
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
		const dest = new SolidtimeDestination(
			connector,
			new MappingStore(memMemento()),
			'https://app.solidtime.io'
		);
		await dest.prepare(block.start);
		await dest.retitle('', 'x', { markerId: 'seg-1', projectName: 'proj', startMs: 0, endMs: 1 });
		assert.equal(connector.updated.length, 0);
	});

	test('mappings are scoped per server/org — a cached id under one backend is not reused by another', async () => {
		const connector = new FakeConnector();
		const mappings = new MappingStore(memMemento());
		const destA = new SolidtimeDestination(connector, mappings, 'https://a.solidtime.io');
		const destB = new SolidtimeDestination(connector, mappings, 'https://b.solidtime.io');

		await destA.prepare(block.start);
		await destA.deliver(block);
		assert.equal(connector.findProjectCalls, 1);
		assert.equal(connector.findTaskCalls, 1);

		// Same workspaceKey/branch, but a different backend (apiUrl) — must not
		// reuse destA's cached project/task ids, so find is called again.
		await destB.prepare(block.start);
		await destB.deliver(block);
		assert.equal(connector.findProjectCalls, 2);
		assert.equal(connector.findTaskCalls, 2);
	});

	test('deliver evicts the cached mapping and rethrows when createEntry 404s/422s', async () => {
		const connector = new FakeConnector();
		const mappings = new MappingStore(memMemento());
		const dest = new SolidtimeDestination(connector, mappings, 'https://app.solidtime.io');
		await dest.prepare(block.start);

		// Prime the cache with a first successful delivery.
		await dest.deliver({ ...block, segmentIds: ['seg-0'] });
		assert.equal(connector.findProjectCalls, 1);

		connector.failNextEntryWith = new ConnectorError('unprocessable', 422, false);
		await assert.rejects(() => dest.deliver({ ...block, segmentIds: ['seg-2'] }), ConnectorError);

		// The stale mapping was cleared, so the next delivery re-resolves it.
		await dest.deliver({ ...block, segmentIds: ['seg-3'] });
		assert.equal(connector.findProjectCalls, 2);
		assert.equal(connector.findTaskCalls, 2);
	});
});
