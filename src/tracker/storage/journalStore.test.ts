import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { JournalRecord, LocalSegment } from '../types';
import { JournalStore } from './journalStore';

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-journal-'));
}

const segment: LocalSegment = {
	id: 'seg-1',
	instanceId: 'inst',
	start: '2026-07-21T09:00:00.000Z',
	end: '2026-07-21T09:30:00.000Z',
	activeMilliseconds: 1_800_000,
	workspaceKey: 'ws',
	projectName: 'proj',
	branch: 'main',
	syncState: 'pending',
};

suite('JournalStore', () => {
	test('append then readAll round-trips records in order', () => {
		const dir = tempDir();
		const store = new JournalStore(dir, 'inst', () => new Date('2026-07-21T10:00:00Z'));
		const open: JournalRecord = {
			type: 'open',
			id: 'seg-1',
			start: segment.start,
			instanceId: 'inst',
			context: { workspaceKey: 'ws', projectName: 'proj', branch: 'main' },
		};
		store.append(open);
		store.append({ type: 'close', segment });
		const records = store.readAll();
		assert.equal(records.length, 2);
		assert.equal(records[0].type, 'open');
		assert.equal(records[1].type, 'close');
	});

	test('a malformed trailing line is skipped', () => {
		const dir = tempDir();
		const store = new JournalStore(dir, 'inst', () => new Date('2026-07-21T10:00:00Z'));
		store.append({ type: 'checkpoint', id: 'seg-1', lastActivity: segment.start });
		const file = fs.readdirSync(dir).find((f) => f.startsWith('inst-'))!;
		fs.appendFileSync(path.join(dir, file), '{ not valid json');
		const records = store.readAll();
		assert.equal(records.length, 1);
		assert.equal(records[0].type, 'checkpoint');
	});
});
