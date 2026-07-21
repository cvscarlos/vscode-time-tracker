import * as vscode from 'vscode';

export interface GitInfo {
	repositoryKey?: string;
	branch?: string;
}

interface GitRepositoryState {
	HEAD?: { name?: string; commit?: string };
	remotes: { fetchUrl?: string; pushUrl?: string }[];
	onDidChange: vscode.Event<void>;
}
interface GitRepository {
	rootUri: vscode.Uri;
	state: GitRepositoryState;
}
interface GitApi {
	repositories: GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
	onDidOpenRepository: vscode.Event<GitRepository>;
}

const GIT_DEBOUNCE_MS = 500;

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

/**
 * Re-run context resolution when Git state changes: a branch switch, a repo
 * opening, or the Git extension activating after our own startup. Without this
 * the open segment keeps a stale/undefined branch. Bursts of state changes are
 * debounced into a single refresh.
 */
export function watchGitContext(onChange: () => void): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const debounced = () => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(onChange, GIT_DEBOUNCE_MS);
	};

	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	if (extension) {
		if (extension.isActive) {
			subscribeToGit(extension.exports.getAPI(1), disposables, debounced);
		} else {
			void extension.activate().then((exports) => {
				subscribeToGit(exports.getAPI(1), disposables, debounced);
			});
		}
	}

	return {
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
			}
			for (const disposable of disposables) {
				disposable.dispose();
			}
		},
	};
}

function subscribeToGit(api: GitApi, disposables: vscode.Disposable[], onChange: () => void): void {
	for (const repository of api.repositories) {
		disposables.push(repository.state.onDidChange(onChange));
	}
	disposables.push(
		api.onDidOpenRepository((repository) => {
			disposables.push(repository.state.onDidChange(onChange));
			onChange();
		})
	);
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
