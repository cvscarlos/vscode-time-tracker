import * as assert from 'node:assert';
import { coveringCommit, DeliveredEntry, TitleStore } from './titleStore';
import { CommitInfo } from '../tracker/context/gitCommits';

interface MementoLike {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

function memento(): MementoLike {
	const map = new Map<string, unknown>();
	return {
		get<T>(key: string): T | undefined {
			return map.get(key) as T | undefined;
		},
		update(key: string, value: unknown): Thenable<void> {
			map.set(key, value);
			return Promise.resolve();
		},
	};
}

function commit(branch: string, timeMs: number, hash: string): CommitInfo {
	return { branch, title: `commit ${hash}`, timeMs, hash };
}

suite('coveringCommit', () => {
	const commits: CommitInfo[] = [
		commit('main', 100, 'a'),
		commit('main', 200, 'b'),
		commit('dev', 150, 'c'),
	];

	test('returns the earliest same-branch commit at/after the entry end', () => {
		const found = coveringCommit(120, 'main', commits);
		assert.equal(found?.hash, 'b');
	});

	test('returns undefined when no same-branch commit lands after the entry end', () => {
		const found = coveringCommit(250, 'main', commits);
		assert.equal(found, undefined);
	});
});

suite('TitleStore', () => {
	test('recordDelivered adds an untitled entry; markTitled removes it from untitled()', async () => {
		const store = new TitleStore(memento());
		await store.recordDelivered({ entryId: 'e1', branch: 'main', endMs: 100, markerId: 'm1' });

		const untitled = store.untitled();
		assert.equal(untitled.length, 1);
		assert.equal(untitled[0].entryId, 'e1');
		assert.equal(untitled[0].titled, false);

		await store.markTitled('e1');
		assert.equal(store.untitled().length, 0);
	});

	test('recordDelivered dedups by entryId instead of duplicating', async () => {
		const store = new TitleStore(memento());
		await store.recordDelivered({ entryId: 'e1', branch: 'main', endMs: 100, markerId: 'm1' });
		await store.recordDelivered({ entryId: 'e1', branch: 'main', endMs: 200, markerId: 'm2' });

		const untitled = store.untitled();
		assert.equal(untitled.length, 1);
		assert.equal(untitled[0].endMs, 200);
		assert.equal(untitled[0].markerId, 'm2');
	});

	test('addCommit dedups by hash', async () => {
		const store = new TitleStore(memento());
		await store.addCommit(commit('main', 100, 'a'));
		await store.addCommit(commit('main', 100, 'a'));

		assert.equal(store.commits().length, 1);
	});

	test('prune drops titled entries and commits older than maxAgeMs, keeps recent ones', async () => {
		const store = new TitleStore(memento());
		const now = Date.parse('2026-07-21T17:00:00.000Z');
		const day = 24 * 60 * 60 * 1000;
		const maxAgeMs = 48 * 60 * 60 * 1000;

		// Titled, old -> dropped
		await store.recordDelivered({
			entryId: 'old-titled',
			branch: 'main',
			endMs: now - 3 * day,
			markerId: 'm-old',
		});
		await store.markTitled('old-titled');

		// Untitled, old -> kept (still needs a title)
		await store.recordDelivered({
			entryId: 'old-untitled',
			branch: 'main',
			endMs: now - 3 * day,
			markerId: 'm-old-untitled',
		});

		// Titled, recent -> kept
		await store.recordDelivered({
			entryId: 'recent-titled',
			branch: 'main',
			endMs: now - 1 * day,
			markerId: 'm-recent',
		});
		await store.markTitled('recent-titled');

		await store.addCommit(commit('main', now - 3 * day, 'old-commit'));
		await store.addCommit(commit('main', now - 1 * day, 'recent-commit'));

		await store.prune(now, maxAgeMs);

		const stillUntitled = store.untitled().map((e: DeliveredEntry) => e.entryId);
		assert.ok(stillUntitled.includes('old-untitled'));
		assert.equal(store.commits().length, 1);
		assert.equal(store.commits()[0].hash, 'recent-commit');
	});
});
