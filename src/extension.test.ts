import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { FileOutboxStore } from './tracker/storage/fileOutboxStore';
import { LocalSegment } from './tracker/types';

// 10:10 so the dangling open's 10:05 checkpoint below is comfortably stale
// (> 2 min old) and gets reconstructed by recover().
const clock = () => new Date('2026-07-21T10:10:00Z');

function seg(id: string): LocalSegment {
	return {
		id,
		instanceId: 'inst',
		start: '2026-07-21T09:00:00.000Z',
		end: '2026-07-21T09:30:00.000Z',
		activeMilliseconds: 1_800_000,
		idleMilliseconds: 0,
		workspaceKey: 'ws',
		projectName: 'proj',
		branch: 'main',
		syncState: 'pending',
	};
}

suite('activation', () => {
	test('registers commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('ntTimeTracker.showOutput'));
		assert.ok(commands.includes('ntTimeTracker.pause'));
		assert.ok(commands.includes('ntTimeTracker.resume'));
		assert.ok(commands.includes('ntTimeTracker.discardIdle'));
		assert.ok(commands.includes('ntTimeTracker.recolorGrayProjects'));
		assert.ok(commands.includes('ntTimeTracker.setSolidtimeToken'));
		assert.ok(commands.includes('ntTimeTracker.deleteSolidtimeToken'));
		assert.ok(commands.includes('ntTimeTracker.setTimetaggerToken'));
		assert.ok(commands.includes('ntTimeTracker.deleteTimetaggerToken'));
	});
});

suite('outbox integration', () => {
	test('a fresh instance recovers segments written by other window files', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-int-'));
		new FileOutboxStore(dir, 'win1', clock).append({ type: 'close', segment: seg('a') });
		new FileOutboxStore(dir, 'win2', clock).append({
			type: 'open',
			id: 'b',
			start: '2026-07-21T10:00:00.000Z',
			instanceId: 'win2',
			context: { workspaceKey: 'ws', projectName: 'proj', branch: 'main' },
		});
		new FileOutboxStore(dir, 'win2', clock).append({
			type: 'checkpoint',
			id: 'b',
			lastActivity: '2026-07-21T10:05:00.000Z',
			at: '2026-07-21T10:05:00.000Z',
		});
		const ids = new FileOutboxStore(dir, 'fresh', clock)
			.recover()
			.map((s) => s.id)
			// eslint-disable-next-line unicorn/no-array-sort -- freshly derived array from map(), safe to mutate in place
			.sort((a, b) => a.localeCompare(b));
		assert.deepEqual(ids, ['a', 'b']);
	});
});
