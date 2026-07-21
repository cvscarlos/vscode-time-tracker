import { CommitInfo } from '../tracker/context/gitCommits';

export interface DeliveredEntry {
	entryId: string;
	branch: string;
	endMs: number;
	markerId: string;
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

	recordDelivered(entry: Omit<DeliveredEntry, 'titled'>): Thenable<void> {
		const entries = this.readEntries().filter((e) => e.entryId !== entry.entryId);
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

	markTitled(entryId: string): Thenable<void> {
		const entries = this.readEntries().map((e) =>
			e.entryId === entryId ? { ...e, titled: true } : e
		);
		return this.memento.update(ENTRIES_KEY, entries);
	}

	prune(nowMs: number, maxAgeMs: number): Thenable<void> {
		const cutoffMs = nowMs - maxAgeMs;
		const entries = this.readEntries().filter((e) => !e.titled || e.endMs >= cutoffMs);
		const commits = this.readCommits().filter((c) => c.timeMs >= cutoffMs);
		return Promise.all([
			this.memento.update(ENTRIES_KEY, entries),
			this.memento.update(COMMITS_KEY, commits),
		]).then(() => {});
	}

	private readEntries(): DeliveredEntry[] {
		return this.memento.get<DeliveredEntry[]>(ENTRIES_KEY) ?? [];
	}

	private readCommits(): CommitInfo[] {
		return this.memento.get<CommitInfo[]>(COMMITS_KEY) ?? [];
	}
}

/**
 * Among commits on `branch`, the earliest one at or after `entryEndMs` — the
 * commit that "closed" the entry's work — or `undefined` if none has landed yet.
 */
export function coveringCommit(
	entryEndMs: number,
	branch: string,
	commits: CommitInfo[]
): CommitInfo | undefined {
	let best: CommitInfo | undefined;
	for (const commit of commits) {
		if (commit.branch !== branch || commit.timeMs < entryEndMs) {
			continue;
		}
		if (!best || commit.timeMs < best.timeMs) {
			best = commit;
		}
	}
	return best;
}
