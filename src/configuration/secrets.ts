import * as vscode from 'vscode';

export const TOKEN_KEY = 'cvsTimeTracker.solidtime.apiToken';

export function getToken(context: vscode.ExtensionContext): Thenable<string | undefined> {
	return context.secrets.get(TOKEN_KEY);
}

export function setToken(context: vscode.ExtensionContext, token: string): Thenable<void> {
	return context.secrets.store(TOKEN_KEY, token);
}

export function clearToken(context: vscode.ExtensionContext): Thenable<void> {
	return context.secrets.delete(TOKEN_KEY);
}
