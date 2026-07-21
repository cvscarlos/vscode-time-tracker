import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('activation', () => {
	test('registers the showOutput command', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('cvsTimeTracker.showOutput'));
	});
});
