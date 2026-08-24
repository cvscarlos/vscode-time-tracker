import { CommitInfo } from '../tracker/context/gitCommits';

export interface DeliveredEntry {
	destination: string;
	ref: string;
	markerId: string;
	projectName: string;
	branch?: string;
	workspaceKey: string;
	startMs: number;
	endMs: number;
	titled: boolean;
}

interface MementoLike {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

const ENTRIES_KEY = 'nttitles:entries';
const COMMITS_KEY = 'nttitles:commits';

/**
 * Persists delivered-but-not-yet-titled time entries and a rolling commit log,
 * so the extension can retitle an entry once its covering commit lands even
 * across VS Code restarts. Backed by two flat arrays in `globalState`.
 */
export class TitleStore {
	constructor(private readonly memento: MementoLike) {}

	private readEntries(): DeliveredEntry[] {
		const raw = this.memento.get<Array<Record<string, unknown>>>(ENTRIES_KEY) ?? [];
		return raw.map((e) => this.migrate(e));
	}

	private migrate(e: Record<string, unknown>): DeliveredEntry {
		// Old shape: { entryId, branch, endMs, markerId, titled } (solidtime only).
		if (typeof e.destination === 'string' && typeof e.ref === 'string') {
			return e as unknown as DeliveredEntry;
		}
		return {
			destination: 'solidtime',
			ref: String(e.entryId ?? ''),
			markerId: String(e.markerId ?? ''),
			projectName: '',
			branch: e.branch as string | undefined,
			workspaceKey: '',
			startMs: 0,
			endMs: Number(e.endMs ?? 0),
			titled: Boolean(e.titled),
		};
	}

	private readCommits(): CommitInfo[] {
		return this.memento.get<CommitInfo[]>(COMMITS_KEY) ?? [];
	}

	recordDelivered(entry: Omit<DeliveredEntry, 'titled'>): Thenable<void> {
		if (entry.ref === '') {
			return Promise.resolve();
		}
		const key = `${entry.destination}:${entry.ref}`;
		const entries = this.readEntries().filter((e) => `${e.destination}:${e.ref}` !== key);
		entries.push({ ...entry, titled: false });
		return this.memento.update(ENTRIES_KEY, entries);
	}

	addCommit(commit: CommitInfo): Thenable<void> {
		const commits = this.readCommits().filter((c) => c.hash !== commit.hash);
		commits.push(commit);
		return this.memento.update(COMMITS_KEY, commits);
	}

	untitled(): DeliveredEntry[] {
		return this.readEntries().filter((e) => !e.titled);
	}

	commits(): CommitInfo[] {
		return this.readCommits();
	}

	markTitled(destination: string, ref: string): Thenable<void> {
		const entries = this.readEntries().map((e) =>
			e.destination === destination && e.ref === ref ? { ...e, titled: true } : e
		);
		return this.memento.update(ENTRIES_KEY, entries);
	}

	async prune(nowMs: number, maxAgeMs: number): Promise<void> {
		const cutoffMs = nowMs - maxAgeMs;
		const entries = this.readEntries().filter((e) => !e.titled || e.endMs >= cutoffMs);
		const commits = this.readCommits().filter((c) => c.timeMs >= cutoffMs);
		await Promise.all([
			this.memento.update(ENTRIES_KEY, entries),
			this.memento.update(COMMITS_KEY, commits),
		]);
	}
}

/**
 * Among commits on `branch` in the same repository (`workspaceKey`), the
 * earliest one at or after `entryEndMs` — the commit that "closed" the
 * entry's work — or `undefined` if none has landed yet. Scoping by
 * `workspaceKey` keeps two repositories on the same branch name (e.g. both on
 * `main`) from retitling each other's entries.
 */
export function coveringCommit(
	entryEndMs: number,
	branch: string,
	workspaceKey: string,
	commits: CommitInfo[]
): CommitInfo | undefined {
	let best: CommitInfo | undefined;
	for (const commit of commits) {
		if (
			commit.branch !== branch ||
			commit.workspaceKey !== workspaceKey ||
			commit.timeMs < entryEndMs
		) {
			continue;
		}
		if (!best || commit.timeMs < best.timeMs) {
			best = commit;
		}
	}
	return best;
}
