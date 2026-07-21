import * as vscode from 'vscode';

let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('cvs Time Tracker');
	context.subscriptions.push(output);
	output.appendLine('cvs Time Tracker activated');

	context.subscriptions.push(
		vscode.commands.registerCommand('cvsTimeTracker.showOutput', () => output?.show())
	);
}

export function deactivate(): void {
	output?.appendLine('cvs Time Tracker deactivated');
}
