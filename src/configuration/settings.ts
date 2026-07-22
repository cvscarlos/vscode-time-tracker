import * as vscode from 'vscode';

export interface SolidtimeConfig {
	apiUrl: string;
	organizationId: string | undefined;
}

export function getSolidtimeConfig(): SolidtimeConfig {
	const config = vscode.workspace.getConfiguration('ntTimeTracker');
	const raw = config.get<string>('solidtime.apiUrl', 'https://app.solidtime.io');
	const apiUrl = raw.replace(/\/api(\/v1)?\/?$/, '').replace(/\/+$/, '');
	const orgRaw = config.get<string>('solidtime.organizationId', '').trim();
	return { apiUrl, organizationId: orgRaw === '' ? undefined : orgRaw };
}

export interface TimetaggerConfig {
	apiUrl: string;
}

export function getTimetaggerConfig(): TimetaggerConfig {
	const config = vscode.workspace.getConfiguration('ntTimeTracker');
	return { apiUrl: config.get<string>('timetagger.apiUrl', 'https://timetagger.app') };
}
