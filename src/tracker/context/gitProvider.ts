import * as vscode from 'vscode';

export interface GitInfo {
	repositoryKey?: string;
	branch?: string;
}

interface GitRepositoryState {
	HEAD?: { name?: string; commit?: string };
	remotes: { fetchUrl?: string; pushUrl?: string }[];
}
interface GitRepository {
	rootUri: vscode.Uri;
	state: GitRepositoryState;
}
interface GitApi {
	repositories: GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
}

export function getGitInfo(folderFsPath: string): GitInfo {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	if (!extension?.isActive) {
		return {};
	}
	const api = extension.exports.getAPI(1);
	const repository =
		api.getRepository(vscode.Uri.file(folderFsPath)) ??
		api.repositories.find((r) => folderFsPath.startsWith(r.rootUri.fsPath));
	if (!repository) {
		return {};
	}
	const head = repository.state.HEAD;
	const branch = head?.name ?? (head?.commit ? `detached/${head.commit.slice(0, 8)}` : undefined);
	const url = repository.state.remotes[0]?.fetchUrl ?? repository.state.remotes[0]?.pushUrl;
	return { branch, repositoryKey: normalizeRemote(url) };
}

export function normalizeRemote(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	const match = url.match(/(?:@|:\/\/)([^/:]+)[/:]([^/]+)\/(.+?)(?:\.git)?$/);
	if (!match) {
		return undefined;
	}
	return `${match[1]}/${match[2]}/${match[3]}`;
}
