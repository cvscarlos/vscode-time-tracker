import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { buildSegmentStore } from './tracker/storage/recovery';
import { JournalRecord } from './tracker/types';

suite('activation', () => {
	test('registers the showOutput command', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('cvsTimeTracker.showOutput'));
	});

	test('registers commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('cvsTimeTracker.showOutput'));
		assert.ok(commands.includes('cvsTimeTracker.pause'));
	});
});

suite('recovery integration', () => {
	test('rebuilds totals from a journal with a crashed segment', () => {
		const records: JournalRecord[] = [
			{
				type: 'open',
				id: 'seg-crash',
				start: '2026-07-21T10:00:00.000Z',
				instanceId: 'inst',
				context: { workspaceKey: 'ws', projectName: 'proj', branch: 'main' },
			},
			{ type: 'checkpoint', id: 'seg-crash', lastActivity: '2026-07-21T10:05:00.000Z' },
		];
		const store = buildSegmentStore(records, 'inst');
		assert.equal(store.totalMillisecondsOn('2026-07-21'), 300_000);
	});
});
