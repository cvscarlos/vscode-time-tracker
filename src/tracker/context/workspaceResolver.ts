import * as vscode from 'vscode';
import { TrackingContext } from '../types';
import { getGitInfo } from './gitProvider';

export function deriveProjectName(repositoryKey: string | undefined, folderName: string): string {
	if (repositoryKey) {
		const parts = repositoryKey.split('/');
		return parts.at(-1) ?? folderName;
	}
	return folderName;
}

export function resolveContext(): TrackingContext | undefined {
	const folder = activeFolder();
	if (!folder) {
		return undefined;
	}
	const git = getGitInfo(folder.uri.fsPath);
	const workspaceKey = git.repositoryKey ?? folder.uri.toString();
	return {
		workspaceKey,
		projectName: deriveProjectName(git.repositoryKey, folder.name),
		repositoryKey: git.repositoryKey,
		branch: git.branch,
	};
}

function activeFolder(): vscode.WorkspaceFolder | undefined {
	const active = vscode.window.activeTextEditor?.document.uri;
	if (active) {
		const folder = vscode.workspace.getWorkspaceFolder(active);
		if (folder) {
			return folder;
		}
	}
	return vscode.workspace.workspaceFolders?.[0];
}
