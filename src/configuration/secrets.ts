import * as vscode from 'vscode';

const TOKEN_KEY = 'ntTimeTracker.solidtime.apiToken';

export function getToken(context: vscode.ExtensionContext): Thenable<string | undefined> {
	return context.secrets.get(TOKEN_KEY);
}

export function setToken(context: vscode.ExtensionContext, token: string): Thenable<void> {
	return context.secrets.store(TOKEN_KEY, token);
}
