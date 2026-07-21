import * as vscode from 'vscode';

export interface CommitInfo {
	branch: string;
	title: string;
	timeMs: number;
	hash: string;
}

interface GitCommit {
	hash: string;
	message: string;
	commitDate?: Date;
}

interface GitRepositoryState {
	HEAD?: { name?: string; commit?: string };
	onDidChange: vscode.Event<void>;
}
interface GitRepository {
	rootUri: vscode.Uri;
	state: GitRepositoryState;
	getCommit(ref: string): Promise<GitCommit>;
	log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
}
interface GitApi {
	repositories: GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
	onDidOpenRepository: vscode.Event<GitRepository>;
}

/**
 * Emit a `CommitInfo` whenever a repository's HEAD advances to a new commit on
 * a named branch. Used to retitle the in-progress time entry with the commit
 * message right as it lands. Guarded end-to-end so a missing/inactive Git
 * extension is a silent no-op rather than a startup failure.
 */
export function watchCommits(onCommit: (commit: CommitInfo) => void): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];
	let disposed = false;

	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	if (extension) {
		if (extension.isActive) {
			subscribeToRepositories(extension.exports.getAPI(1), disposables, onCommit);
		} else {
			void extension.activate().then((exports) => {
				if (disposed) {
					return;
				}
				subscribeToRepositories(exports.getAPI(1), disposables, onCommit);
			});
		}
	}

	return vscode.Disposable.from({
		dispose: () => {
			disposed = true;
			for (const disposable of disposables) {
				disposable.dispose();
			}
		},
	});
}

function subscribeToRepositories(
	api: GitApi,
	disposables: vscode.Disposable[],
	onCommit: (commit: CommitInfo) => void
): void {
	for (const repository of api.repositories) {
		disposables.push(watchRepository(repository, onCommit));
	}
	disposables.push(
		api.onDidOpenRepository((repository) => {
			disposables.push(watchRepository(repository, onCommit));
		})
	);
}

function watchRepository(
	repository: GitRepository,
	onCommit: (commit: CommitInfo) => void
): vscode.Disposable {
	let lastSeenCommit = repository.state.HEAD?.commit;
	return repository.state.onDidChange(() => {
		const head = repository.state.HEAD;
		const commit = head?.commit;
		const branch = head?.name;
		if (!commit || commit === lastSeenCommit || !branch) {
			return;
		}
		lastSeenCommit = commit;
		void repository
			.getCommit(commit)
			.then((gitCommit) => {
				onCommit({
					branch,
					title: firstLine(gitCommit.message),
					timeMs: (gitCommit.commitDate ?? new Date()).getTime(),
					hash: gitCommit.hash,
				});
			})
			.catch(() => {
				// Git extension can throw for transient states (e.g. mid-rebase); a
				// missed retitle here is harmless and self-corrects on the next commit.
			});
	});
}

/**
 * Catch up on commits made while the extension wasn't running, e.g. commits
 * from a terminal or another editor while VS Code was closed.
 */
export async function backfillCommits(maxPerRepo?: number): Promise<CommitInfo[]> {
	try {
		const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
		if (!extension) {
			return [];
		}
		const exports = extension.isActive ? extension.exports : await extension.activate();
		const api = exports.getAPI(1);

		const commits: CommitInfo[] = [];
		for (const repository of api.repositories) {
			const branch = repository.state.HEAD?.name;
			if (!branch) {
				continue;
			}
			const log = await repository.log({ maxEntries: maxPerRepo ?? 20 });
			for (const gitCommit of log) {
				commits.push({
					branch,
					title: firstLine(gitCommit.message),
					timeMs: (gitCommit.commitDate ?? new Date()).getTime(),
					hash: gitCommit.hash,
				});
			}
		}
		return commits;
	} catch {
		return [];
	}
}

function firstLine(message: string): string {
	return message.split('\n', 1)[0]?.trim() ?? '';
}
