import * as vscode from 'vscode';

export type Backend = 'solidtime' | 'timetagger';

const KEYS: Record<Backend, string> = {
	solidtime: 'ntTimeTracker.solidtime.apiToken',
	timetagger: 'ntTimeTracker.timetagger.apiToken',
};

export function getToken(
	context: vscode.ExtensionContext,
	backend: Backend
): Thenable<string | undefined> {
	return context.secrets.get(KEYS[backend]);
}

export function setToken(
	context: vscode.ExtensionContext,
	backend: Backend,
	token: string
): Thenable<void> {
	return context.secrets.store(KEYS[backend], token);
}

export function clearToken(context: vscode.ExtensionContext, backend: Backend): Thenable<void> {
	return context.secrets.delete(KEYS[backend]);
}
