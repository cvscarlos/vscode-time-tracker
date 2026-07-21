import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { FileOutboxStore } from './fileOutboxStore';
import { LocalSegment, OpenRecord } from '../types';

const clock = () => new Date('2026-07-21T10:00:00Z');

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'nt-outbox-'));
}

function seg(id: string, ms: number): LocalSegment {
	return {
		id,
		instanceId: 'inst',
		start: '2026-07-21T09:00:00.000Z',
		end: '2026-07-21T09:30:00.000Z',
		activeMilliseconds: ms,
		workspaceKey: 'ws',
		projectName: 'proj',
		branch: 'main',
		syncState: 'pending',
	};
}

function open(id: string): OpenRecord {
	return {
		type: 'open',
		id,
		start: '2026-07-21T10:00:00.000Z',
		instanceId: 'other-window',
		context: { workspaceKey: 'ws', projectName: 'proj', branch: 'main' },
	};
}

suite('FileOutboxStore', () => {
	test('append then recover round-trips a closed segment', () => {
		const store = new FileOutboxStore(tempDir(), 'inst', clock);
		store.append({ type: 'close', segment: seg('a', 1000) });
		const recovered = store.recover();
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0].id, 'a');
	});

	test('recover reads across MULTIPLE window files (centralized)', () => {
		const dir = tempDir();
		new FileOutboxStore(dir, 'win1', clock).append({ type: 'close', segment: seg('a', 1000) });
		new FileOutboxStore(dir, 'win2', clock).append({ type: 'close', segment: seg('b', 2000) });
		const ids = new FileOutboxStore(dir, 'win3', clock)
			.recover()
			.map((s) => s.id)
			// eslint-disable-next-line unicorn/no-array-sort -- freshly derived array from map(), safe to mutate in place
			.sort();
		assert.deepEqual(ids, ['a', 'b']);
	});

	test('a dangling open with a STALE checkpoint is recovered at the last checkpoint', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'other-window', clock);
		// Clock is 10:00:00Z; checkpoint at 09:55 is 5 min old (>= 2 min) so the
		// open is stale (crashed window) and recoverable.
		store.append({ ...open('c'), start: '2026-07-21T09:50:00.000Z' });
		store.append({ type: 'checkpoint', id: 'c', lastActivity: '2026-07-21T09:55:00.000Z' });
		const reopened = new FileOutboxStore(dir, 'fresh', clock).recover();
		assert.equal(reopened.length, 1);
		assert.equal(reopened[0].id, 'c');
		assert.equal(reopened[0].end, '2026-07-21T09:55:00.000Z');
		assert.equal(reopened[0].activeMilliseconds, 300_000);
	});

	test('a FRESH dangling open (checkpoint within the last 120s) is NOT recovered', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'other-window', clock);
		// Clock is 10:00:00Z; checkpoint at 09:59:30 is only 30s old, so this open
		// belongs to a live window still writing checkpoints and must be skipped.
		store.append(open('c'));
		store.append({ type: 'checkpoint', id: 'c', lastActivity: '2026-07-21T09:59:30.000Z' });
		const reopened = new FileOutboxStore(dir, 'fresh', clock).recover();
		assert.equal(reopened.length, 0);
	});

	test('a dangling open with no checkpoint is dropped', () => {
		const store = new FileOutboxStore(tempDir(), 'inst', clock);
		store.append(open('d'));
		assert.equal(store.recover().length, 0);
	});

	test('a reconstructed dangling open below minActiveMs is NOT recovered', () => {
		const dir = tempDir();
		const writer = new FileOutboxStore(dir, 'other-window', clock);
		// Stale checkpoint (5 min old vs the 10:00 clock) but only 5s of active
		// time — below a 20s minimum, so it must be dropped, not resurrected.
		writer.append({ ...open('c'), start: '2026-07-21T09:55:00.000Z' });
		writer.append({ type: 'checkpoint', id: 'c', lastActivity: '2026-07-21T09:55:05.000Z' });
		const reopened = new FileOutboxStore(dir, 'fresh', clock, 20_000).recover();
		assert.equal(reopened.length, 0);
	});

	test('a reconstructed dangling open at/above minActiveMs is recovered', () => {
		const dir = tempDir();
		const writer = new FileOutboxStore(dir, 'other-window', clock);
		// Stale checkpoint with 30s of active time — at/above the 20s minimum.
		writer.append({ ...open('c'), start: '2026-07-21T09:55:00.000Z' });
		writer.append({ type: 'checkpoint', id: 'c', lastActivity: '2026-07-21T09:55:30.000Z' });
		const reopened = new FileOutboxStore(dir, 'fresh', clock, 20_000).recover();
		assert.equal(reopened.length, 1);
		assert.equal(reopened[0].id, 'c');
		assert.equal(reopened[0].activeMilliseconds, 30_000);
	});

	test('a closed segment below minActiveMs still passes through (it met the minimum on close)', () => {
		const dir = tempDir();
		new FileOutboxStore(dir, 'inst', clock).append({ type: 'close', segment: seg('a', 5000) });
		const recovered = new FileOutboxStore(dir, 'fresh', clock, 20_000).recover();
		assert.deepEqual(
			recovered.map((s) => s.id),
			['a']
		);
	});

	test("compact keeps a delivered tombstone while another window's file still holds the id", () => {
		const dir = tempDir();
		const winB = new FileOutboxStore(dir, 'winB', clock);
		winB.append({ type: 'close', segment: seg('shared', 1000) });
		// Window A delivers a segment owned by window B's file. A cannot rewrite
		// B's file during compact, so the tombstone must be retained to keep the
		// segment suppressed — otherwise recover() re-surfaces it forever.
		const winA = new FileOutboxStore(dir, 'winA', clock);
		winA.markDelivered('shared');
		winA.compact();
		assert.ok(!winA.listUndelivered().some((s) => s.id === 'shared'));
		assert.ok(fs.existsSync(path.join(dir, 'delivered', 'shared')));
		// Repeated cycles must not re-surface it either.
		winA.compact();
		assert.ok(!winA.listUndelivered().some((s) => s.id === 'shared'));
		assert.ok(fs.existsSync(path.join(dir, 'delivered', 'shared')));
	});

	test('claim grants a segment to exactly one caller', () => {
		const dir = tempDir();
		const a = new FileOutboxStore(dir, 'win1', clock);
		const b = new FileOutboxStore(dir, 'win2', clock);
		assert.equal(a.claim('x'), true);
		assert.equal(b.claim('x'), false);
	});

	test('markDelivered removes a segment from listUndelivered', () => {
		const store = new FileOutboxStore(tempDir(), 'inst', clock);
		store.append({ type: 'close', segment: seg('a', 1000) });
		assert.equal(store.listUndelivered().length, 1);
		store.markDelivered('a');
		assert.equal(store.listUndelivered().length, 0);
	});

	test('compact drops delivered segments from the journal', () => {
		const store = new FileOutboxStore(tempDir(), 'inst', clock);
		store.append({ type: 'close', segment: seg('a', 1000) });
		store.append({ type: 'close', segment: seg('b', 2000) });
		store.markDelivered('a');
		store.compact();
		const ids = store.recover().map((s) => s.id);
		assert.deepEqual(ids, ['b']);
	});

	test('compact only rewrites this instance files, leaving other windows untouched', () => {
		const dir = tempDir();
		const win1 = new FileOutboxStore(dir, 'win1', clock);
		const win2 = new FileOutboxStore(dir, 'win2', clock);
		win1.append({ type: 'close', segment: seg('a', 1000) });
		win2.append({ type: 'close', segment: seg('b', 2000) });
		win1.markDelivered('a');
		win1.compact();
		// win1's delivered segment is gone; win2's file was never rewritten and
		// its segment is still recoverable.
		const ids = new FileOutboxStore(dir, 'fresh', clock).recover().map((s) => s.id);
		assert.deepEqual(ids, ['b']);
		assert.ok(fs.existsSync(path.join(dir, 'win2-2026-07-21.jsonl')));
	});

	test('compact tolerates a torn trailing line without throwing', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'inst', clock);
		store.append({ type: 'close', segment: seg('a', 1000) });
		const journalFile = path.join(dir, 'inst-2026-07-21.jsonl');
		fs.appendFileSync(journalFile, '{ not valid json');
		assert.doesNotThrow(() => store.compact());
		const ids = store.recover().map((s) => s.id);
		assert.deepEqual(ids, ['a']);
	});
});
