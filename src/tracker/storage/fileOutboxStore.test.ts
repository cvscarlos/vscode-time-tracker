import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { FileOutboxStore } from './fileOutboxStore';
import { JournalRecord, LocalSegment, OpenRecord } from '../types';

const clock = () => new Date('2026-07-21T10:00:00Z');
const yesterday = () => new Date('2026-07-20T10:00:00Z');

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'nt-outbox-'));
}

function closeRecord(id: string): JournalRecord {
	return {
		type: 'close',
		segment: {
			id,
			instanceId: 'inst',
			start: new Date(0).toISOString(),
			end: new Date(60_000).toISOString(),
			activeMilliseconds: 60_000,
			workspaceKey: 'ws',
			projectName: 'proj',
			branch: 'main',
			syncState: 'pending',
		},
	};
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
			.sort((a, b) => a.localeCompare(b));
		assert.deepEqual(ids, ['a', 'b']);
	});

	test('a dangling open with a STALE checkpoint is recovered at the last checkpoint', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'other-window', clock);
		// Clock is 10:00:00Z; the checkpoint was written at 09:55, 5 min ago
		// (>= 2 min), so the open is stale (crashed window) and recoverable.
		store.append({ ...open('c'), start: '2026-07-21T09:50:00.000Z' });
		store.append({
			type: 'checkpoint',
			id: 'c',
			lastActivity: '2026-07-21T09:55:00.000Z',
			at: '2026-07-21T09:55:00.000Z',
		});
		const reopened = new FileOutboxStore(dir, 'fresh', clock).recover();
		assert.equal(reopened.length, 1);
		assert.equal(reopened[0].id, 'c');
		assert.equal(reopened[0].end, '2026-07-21T09:55:00.000Z');
		assert.equal(reopened[0].activeMilliseconds, 300_000);
	});

	test('a FRESH dangling open (checkpoint written within the last 120s) is NOT recovered', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'other-window', clock);
		// Clock is 10:00:00Z; the checkpoint was written at 09:59:30, only 30s
		// ago, so this open belongs to a live window still writing checkpoints
		// and must be skipped.
		store.append(open('c'));
		store.append({
			type: 'checkpoint',
			id: 'c',
			lastActivity: '2026-07-21T09:59:30.000Z',
			at: '2026-07-21T09:59:30.000Z',
		});
		const reopened = new FileOutboxStore(dir, 'fresh', clock).recover();
		assert.equal(reopened.length, 0);
	});

	test('staleness and the recovered end key off the checkpoint write time (at), not lastActivity', () => {
		const liveDir = tempDir();
		const liveStore = new FileOutboxStore(liveDir, 'other-window', clock);
		// Focused-but-reading window: no edits, so lastActivity is stale (20 min
		// old), but the checkpoint write itself (at) is fresh — the window is
		// still alive and must not be misread as crashed/truncated.
		liveStore.append({ ...open('c'), start: '2026-07-21T09:40:00.000Z' });
		liveStore.append({
			type: 'checkpoint',
			id: 'c',
			lastActivity: '2026-07-21T09:40:00.000Z',
			at: '2026-07-21T09:59:30.000Z',
		});
		assert.equal(new FileOutboxStore(liveDir, 'fresh', clock).recover().length, 0);

		const crashedDir = tempDir();
		const crashedStore = new FileOutboxStore(crashedDir, 'other-window', clock);
		// Crashed window: the checkpoint write itself is stale, so it recovers up
		// to that write time — crediting the reading right up to the crash.
		crashedStore.append({ ...open('d'), start: '2026-07-21T09:40:00.000Z' });
		crashedStore.append({
			type: 'checkpoint',
			id: 'd',
			lastActivity: '2026-07-21T09:40:00.000Z',
			at: '2026-07-21T09:55:00.000Z',
		});
		const recovered = new FileOutboxStore(crashedDir, 'fresh', clock).recover();
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0].end, '2026-07-21T09:55:00.000Z');
	});

	test('a dangling open with no checkpoint is dropped', () => {
		const store = new FileOutboxStore(tempDir(), 'inst', clock);
		store.append(open('d'));
		assert.equal(store.recover().length, 0);
	});

	test('a reconstructed dangling open below minActiveMs is NOT recovered', () => {
		const dir = tempDir();
		const writer = new FileOutboxStore(dir, 'other-window', clock);
		// Stale checkpoint write (5 min old vs the 10:00 clock) but only 5s of
		// active time — below a 20s minimum, so it must be dropped, not resurrected.
		writer.append({ ...open('c'), start: '2026-07-21T09:55:00.000Z' });
		writer.append({
			type: 'checkpoint',
			id: 'c',
			lastActivity: '2026-07-21T09:55:05.000Z',
			at: '2026-07-21T09:55:05.000Z',
		});
		const reopened = new FileOutboxStore(dir, 'fresh', clock, 20_000).recover();
		assert.equal(reopened.length, 0);
	});

	test('a reconstructed dangling open at/above minActiveMs is recovered', () => {
		const dir = tempDir();
		const writer = new FileOutboxStore(dir, 'other-window', clock);
		// Stale checkpoint write with 30s of active time — at/above the 20s minimum.
		writer.append({ ...open('c'), start: '2026-07-21T09:55:00.000Z' });
		writer.append({
			type: 'checkpoint',
			id: 'c',
			lastActivity: '2026-07-21T09:55:30.000Z',
			at: '2026-07-21T09:55:30.000Z',
		});
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
		winA.markDelivered('shared', 'solidtime');
		winA.compact(['solidtime']);
		assert.ok(winA.listUndelivered(['solidtime']).every((s) => s.id !== 'shared'));
		assert.ok(fs.existsSync(path.join(dir, 'delivered', 'shared.solidtime')));
		// Repeated cycles must not re-surface it either.
		winA.compact(['solidtime']);
		assert.ok(winA.listUndelivered(['solidtime']).every((s) => s.id !== 'shared'));
		assert.ok(fs.existsSync(path.join(dir, 'delivered', 'shared.solidtime')));
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
		assert.equal(store.listUndelivered(['solidtime']).length, 1);
		store.markDelivered('a', 'solidtime');
		assert.equal(store.listUndelivered(['solidtime']).length, 0);
	});

	test('compact drops delivered segments from the journal', () => {
		const store = new FileOutboxStore(tempDir(), 'inst', clock);
		store.append({ type: 'close', segment: seg('a', 1000) });
		store.append({ type: 'close', segment: seg('b', 2000) });
		store.markDelivered('a', 'solidtime');
		store.compact(['solidtime']);
		const ids = store.recover().map((s) => s.id);
		assert.deepEqual(ids, ['b']);
	});

	test('compact only rewrites this instance files, leaving other windows untouched', () => {
		const dir = tempDir();
		const win1 = new FileOutboxStore(dir, 'win1', clock);
		const win2 = new FileOutboxStore(dir, 'win2', clock);
		win1.append({ type: 'close', segment: seg('a', 1000) });
		win2.append({ type: 'close', segment: seg('b', 2000) });
		win1.markDelivered('a', 'solidtime');
		win1.compact(['solidtime']);
		// win1's delivered segment is gone; win2's file was never rewritten and
		// its segment is still recoverable.
		const ids = new FileOutboxStore(dir, 'fresh', clock).recover().map((s) => s.id);
		assert.deepEqual(ids, ['b']);
		assert.ok(fs.existsSync(path.join(dir, 'win2-2026-07-21.jsonl')));
	});

	test('compact rewrites a different instance PRIOR-DATE file (safe: it can never receive new appends), but leaves its TODAY file alone', () => {
		const dir = tempDir();
		const closedWindow = new FileOutboxStore(dir, 'closed-window', yesterday);
		closedWindow.append({ type: 'close', segment: seg('prior', 1000) });
		const otherLiveWindow = new FileOutboxStore(dir, 'other-live-window', clock); // today
		otherLiveWindow.append({ type: 'close', segment: seg('today', 1000) });

		const fresh = new FileOutboxStore(dir, 'fresh', clock);
		fresh.markDelivered('prior', 'solidtime');
		fresh.markDelivered('today', 'solidtime');
		fresh.compact(['solidtime']);

		// The prior-date file is safe for ANY window to compact (it can never
		// receive new appends), so its fully-delivered segment is dropped.
		assert.ok(!fs.existsSync(path.join(dir, 'closed-window-2026-07-20.jsonl')));
		// The other window's TODAY file is left untouched, even though its
		// segment is also fully delivered — it could still be appended to.
		assert.ok(fs.existsSync(path.join(dir, 'other-live-window-2026-07-21.jsonl')));
		assert.deepEqual(
			fresh.recover().map((s) => s.id),
			['today']
		);
	});

	test('compact tolerates a torn trailing line without throwing', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'inst', clock);
		store.append({ type: 'close', segment: seg('a', 1000) });
		const journalFile = path.join(dir, 'inst-2026-07-21.jsonl');
		fs.appendFileSync(journalFile, '{ not valid json');
		assert.doesNotThrow(() => store.compact(['solidtime']));
		const ids = store.recover().map((s) => s.id);
		assert.deepEqual(ids, ['a']);
	});

	test('a segment is undelivered until delivered to every enabled destination', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'inst', () => new Date(1000));
		store.append(closeRecord('seg-1'));

		assert.equal(store.listUndelivered(['solidtime', 'timetagger']).length, 1);

		store.markDelivered('seg-1', 'solidtime');
		assert.equal(store.isDelivered('seg-1', 'solidtime'), true);
		assert.equal(store.isDelivered('seg-1', 'timetagger'), false);
		// still pending: timetagger has not received it
		assert.equal(store.listUndelivered(['solidtime', 'timetagger']).length, 1);

		store.markDelivered('seg-1', 'timetagger');
		assert.equal(store.listUndelivered(['solidtime', 'timetagger']).length, 0);
	});

	test('compact purges a segment only once delivered to all enabled destinations', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'inst', () => new Date(1000));
		store.append(closeRecord('seg-1'));

		store.markDelivered('seg-1', 'timetagger');
		store.compact(['solidtime', 'timetagger']);
		assert.equal(store.recover().length, 1); // not fully delivered — retained

		store.markDelivered('seg-1', 'solidtime');
		store.compact(['solidtime', 'timetagger']);
		assert.equal(store.recover().length, 0); // now purged
	});

	test('listUndelivered stays deterministic across windows even after one claims the segment', () => {
		// Both windows must aggregate the SAME undelivered set so they derive the
		// same block and the same segmentIds[0] marker — otherwise window B would
		// re-aggregate a different (smaller) block and re-deliver part of it under
		// a new marker. listUndelivered must not strip a segment just because
		// another window holds its claim.
		const dir = tempDir();
		const a = new FileOutboxStore(dir, 'winA', clock);
		const b = new FileOutboxStore(dir, 'winB', clock);
		a.append({ type: 'close', segment: seg('shared', 1000) });
		assert.equal(a.claim('shared'), true);
		const stillListed = b.listUndelivered(['solidtime']).map((s) => s.id);
		assert.deepEqual(stillListed, ['shared']);
	});

	test('a bare (pre-TimeTagger) tombstone is read as a solidtime delivery', () => {
		const dir = tempDir();
		const store = new FileOutboxStore(dir, 'inst', () => new Date(1000));
		store.append(closeRecord('seg-1'));
		// simulate an old tombstone written before per-destination support
		fs.writeFileSync(path.join(dir, 'delivered', 'seg-1'), '');

		assert.equal(store.isDelivered('seg-1', 'solidtime'), true);
		assert.equal(store.listUndelivered(['solidtime']).length, 0);
	});
});
