import * as assert from 'node:assert';
import { TitleStore, coveringCommit } from './titleStore';

function memMemento() {
	const map = new Map<string, unknown>();
	return {
		store: map,
		get: <T>(k: string) => map.get(k) as T | undefined,
		update: (k: string, v: unknown) => {
			map.set(k, v);
			return Promise.resolve();
		},
	};
}

const base = {
	markerId: 'seg-1',
	projectName: 'proj',
	branch: 'main',
	startMs: 0,
	endMs: 60_000,
};

suite('TitleStore per destination', () => {
	test('records and titles are tracked independently per destination', async () => {
		const m = memMemento();
		const store = new TitleStore(m);
		await store.recordDelivered({ destination: 'solidtime', ref: 'entry-1', ...base });
		await store.recordDelivered({ destination: 'timetagger', ref: 'seg-1', ...base });
		assert.equal(store.untitled().length, 2);

		await store.markTitled('solidtime', 'entry-1');
		const untitled = store.untitled();
		assert.equal(untitled.length, 1);
		assert.equal(untitled[0].destination, 'timetagger');
	});

	test('an empty ref is not recorded (already present on the backend)', async () => {
		const store = new TitleStore(memMemento());
		await store.recordDelivered({ destination: 'solidtime', ref: '', ...base });
		assert.equal(store.untitled().length, 0);
	});

	test('coveringCommit picks the earliest commit at or after the entry end on the branch', () => {
		const commits = [
			{ branch: 'main', title: 'a', timeMs: 30_000, hash: 'h1' },
			{ branch: 'main', title: 'b', timeMs: 90_000, hash: 'h2' },
			{ branch: 'main', title: 'c', timeMs: 120_000, hash: 'h3' },
		];
		assert.equal(coveringCommit(60_000, 'main', commits)?.hash, 'h2');
	});
});
