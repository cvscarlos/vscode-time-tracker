import * as assert from 'node:assert';
import { DeliveredEntry, TitleStore, coveringCommit } from './titleStore';

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

	test('an old-shape entry (pre-destination globalState) is normalized on read', async () => {
		const m = memMemento();
		m.store.set('nttitles:entries', [
			{ entryId: 'entry-9', branch: 'main', endMs: 60_000, markerId: 'seg-9', titled: false },
		]);
		const store = new TitleStore(m);

		const untitled = store.untitled();
		assert.equal(untitled.length, 1);
		assert.equal(untitled[0].destination, 'solidtime');
		assert.equal(untitled[0].ref, 'entry-9');
		assert.equal(untitled[0].endMs, 60_000);
		assert.equal(untitled[0].markerId, 'seg-9');

		await store.markTitled('solidtime', 'entry-9');
		assert.equal(store.untitled().length, 0);
	});

	test('addCommit dedups by hash (latest wins)', async () => {
		const store = new TitleStore(memMemento());
		await store.addCommit({ branch: 'main', title: 'first', timeMs: 100, hash: 'a' });
		await store.addCommit({ branch: 'main', title: 'second', timeMs: 200, hash: 'a' });

		const commits = store.commits();
		assert.equal(commits.length, 1);
		assert.equal(commits[0].title, 'second');
	});

	test('prune drops titled entries and commits older than maxAgeMs, keeps recent ones', async () => {
		const m = memMemento();
		const store = new TitleStore(m);
		const now = Date.parse('2026-07-21T17:00:00.000Z');
		const day = 24 * 60 * 60 * 1000;
		const maxAgeMs = 48 * 60 * 60 * 1000;

		// Titled, old -> dropped (past the cutoff, no longer needs retaining)
		await store.recordDelivered({
			destination: 'solidtime',
			ref: 'old-titled',
			...base,
			endMs: now - 3 * day,
		});
		await store.markTitled('solidtime', 'old-titled');

		// Untitled, old -> kept regardless of age (still needs a title)
		await store.recordDelivered({
			destination: 'solidtime',
			ref: 'old-untitled',
			...base,
			endMs: now - 3 * day,
		});

		// Titled, recent -> kept (within the retention window)
		await store.recordDelivered({
			destination: 'solidtime',
			ref: 'recent-titled',
			...base,
			endMs: now - 1 * day,
		});
		await store.markTitled('solidtime', 'recent-titled');

		await store.addCommit({
			branch: 'main',
			title: 'old',
			timeMs: now - 3 * day,
			hash: 'old-commit',
		});
		await store.addCommit({
			branch: 'main',
			title: 'recent',
			timeMs: now - 1 * day,
			hash: 'recent-commit',
		});

		await store.prune(now, maxAgeMs);

		// untitled() masks every titled entry regardless of age, so assert on the
		// raw stored entries to actually exercise the `!titled || endMs >= cutoff` branch.
		const entries = m.store.get('nttitles:entries') as DeliveredEntry[];
		const refs = new Set(entries.map((e) => e.ref));
		assert.ok(!refs.has('old-titled'));
		assert.ok(refs.has('recent-titled'));
		assert.ok(refs.has('old-untitled'));
		assert.deepEqual(
			store.commits().map((c) => c.hash),
			['recent-commit']
		);
	});
});
