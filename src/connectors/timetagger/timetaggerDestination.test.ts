import * as assert from 'node:assert';
import { toTag, TimetaggerDestination } from './timetaggerDestination';
import { TimetaggerClient, TimetaggerRecord } from './timetaggerClient';
import { DeliveryBlock } from '../destination';

class FakeClient extends TimetaggerClient {
	puts: TimetaggerRecord[][] = [];
	constructor() {
		super('https://timetagger.app', 'tok');
	}
	async putRecords(records: TimetaggerRecord[]): Promise<void> {
		this.puts.push(records);
	}
}

const block: DeliveryBlock = {
	segmentIds: ['seg-1', 'seg-2'],
	start: new Date(120_000).toISOString(), // 120s
	end: new Date(180_000).toISOString(), // 180s
	workspaceKey: 'ws',
	projectName: 'my project',
	branch: 'feature/x',
	focusMinutes: 1,
	idleMinutes: 0,
};

suite('toTag', () => {
	test('replaces whitespace with dashes and strips a leading hash', () => {
		assert.equal(toTag('  my project '), 'my-project');
		assert.equal(toTag('#already'), 'already');
	});
	test('keeps slashes and dashes', () => {
		assert.equal(toTag('feature/x-1'), 'feature/x-1');
	});
});

suite('TimetaggerDestination', () => {
	test('deliver PUTs one record keyed by the first segment id, times in seconds, tags in ds', async () => {
		const client = new FakeClient();
		const dest = new TimetaggerDestination(client, () => 300_000);
		const ref = await dest.deliver(block);
		assert.equal(ref, 'seg-1');
		assert.equal(client.puts.length, 1);
		const rec = client.puts[0][0];
		assert.equal(rec.key, 'seg-1');
		assert.equal(rec.t1, 120);
		assert.equal(rec.t2, 180);
		assert.equal(rec.mt, 300);
		assert.equal(rec.st, 0);
		assert.equal(rec.ds, 'feature/x #my-project #feature/x');
	});

	test('deliver without a branch uses only the project tag and the project as title', async () => {
		const client = new FakeClient();
		const dest = new TimetaggerDestination(client, () => 0);
		await dest.deliver({ ...block, branch: undefined });
		assert.equal(client.puts[0][0].ds, 'my project #my-project');
	});

	test('deliver appends the focus/idle breakdown suffix before the tags when idle >= 1 min', async () => {
		const client = new FakeClient();
		const dest = new TimetaggerDestination(client, () => 300_000);
		await dest.deliver({ ...block, focusMinutes: 14, idleMinutes: 3 });
		assert.equal(client.puts[0][0].ds, 'feature/x (14m focus, 3m idle) #my-project #feature/x');
	});

	test('deliver omits the suffix when idleMinutes is 0', async () => {
		const client = new FakeClient();
		const dest = new TimetaggerDestination(client, () => 300_000);
		await dest.deliver(block);
		assert.equal(client.puts[0][0].ds, 'feature/x #my-project #feature/x');
	});

	test('retitle re-PUTs the same key with the covering-commit title and bumped mt', async () => {
		const client = new FakeClient();
		const dest = new TimetaggerDestination(client, () => 999_000);
		await dest.retitle('seg-1', 'fix: blur tolerance', {
			markerId: 'seg-1',
			projectName: 'my project',
			branch: 'feature/x',
			startMs: 120_000,
			endMs: 180_000,
			focusMinutes: 1,
			idleMinutes: 0,
		});
		const rec = client.puts[0][0];
		assert.equal(rec.key, 'seg-1');
		assert.equal(rec.mt, 999);
		assert.equal(rec.t1, 120);
		assert.equal(rec.t2, 180);
		assert.equal(rec.ds, 'fix: blur tolerance #my-project #feature/x');
	});

	test('retitle appends the focus/idle breakdown suffix from ctx when idle >= 1 min', async () => {
		const client = new FakeClient();
		const dest = new TimetaggerDestination(client, () => 999_000);
		await dest.retitle('seg-1', 'fix: blur tolerance', {
			markerId: 'seg-1',
			projectName: 'my project',
			branch: 'feature/x',
			startMs: 120_000,
			endMs: 180_000,
			focusMinutes: 14,
			idleMinutes: 3,
		});
		const rec = client.puts[0][0];
		assert.equal(rec.ds, 'fix: blur tolerance (14m focus, 3m idle) #my-project #feature/x');
	});
});
