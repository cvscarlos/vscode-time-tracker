import type { LocalSegment } from '../../src/tracker/types';
import type { RuleMatch } from './rules.ts';

/** Time a left tab keeps counting; returning within it continues the same segment. */
export const GRACE_MS = 15_000;
/** A heartbeat gap this long means the machine slept; the segment ends at the last heartbeat. */
export const SLEEP_GAP_MS = 90_000;

export interface ChromeSegment extends LocalSegment {
	host: string;
	rule: string;
}

/** Plain JSON, persisted as-is so tracking survives the MV3 worker being suspended. */
export interface TrackerState {
	open?: { id: string; start: number; match: RuleMatch; leftAt?: number };
	lastSeen?: number;
}

export type TrackerStatus = 'tracking' | 'grace' | 'off';

interface TrackerDeps {
	newId: () => string;
	onClose: (segment: ChromeSegment) => void;
}

export class TabTracker {
	private readonly state: TrackerState;
	private readonly deps: TrackerDeps;

	constructor(state: TrackerState, deps: TrackerDeps) {
		this.state = state;
		this.deps = deps;
	}

	private settle(now: number): void {
		const { open, lastSeen } = this.state;
		if (open && lastSeen !== undefined && now - lastSeen > SLEEP_GAP_MS) {
			this.close(Math.min(lastSeen, (open.leftAt ?? lastSeen) + GRACE_MS));
		} else if (open?.leftAt !== undefined && now - open.leftAt >= GRACE_MS) {
			this.close(open.leftAt + GRACE_MS);
		}
	}

	private openSegment(match: RuleMatch, now: number): void {
		this.state.open = { id: this.deps.newId(), start: now, match };
	}

	private close(end: number): void {
		const { open } = this.state;
		this.state.open = undefined;
		if (!open || end <= open.start) {
			return;
		}
		this.deps.onClose({
			id: open.id,
			instanceId: 'chrome',
			start: new Date(open.start).toISOString(),
			end: new Date(end).toISOString(),
			activeMilliseconds: end - open.start,
			idleMilliseconds: 0,
			workspaceKey: `chrome:${open.match.project}`,
			projectName: open.match.project,
			branch: 'Chrome',
			syncState: 'pending',
			host: open.match.host,
			rule: open.match.rule,
		});
	}

	/** `match` is the rule-matched active tab of the focused window, or undefined (none, unfocused, locked). */
	observe(match: RuleMatch | undefined, now: number): void {
		this.settle(now);
		const { open } = this.state;
		if (open && match && isSameTarget(open.match, match)) {
			open.leftAt = undefined;
		} else if (open && match) {
			this.close(open.leftAt === undefined ? now : Math.min(now, open.leftAt + GRACE_MS));
			this.openSegment(match, now);
		} else if (open) {
			open.leftAt ??= now;
		} else if (match) {
			this.openSegment(match, now);
		}
		this.state.lastSeen = now;
	}

	heartbeat(now: number): void {
		this.settle(now);
		this.state.lastSeen = now;
	}

	status(now: number): TrackerStatus {
		const { open } = this.state;
		if (!open) {
			return 'off';
		}
		if (open.leftAt === undefined) {
			return 'tracking';
		}
		return now - open.leftAt < GRACE_MS ? 'grace' : 'off';
	}

	snapshot(): TrackerState {
		return this.state;
	}
}

function isSameTarget(a: RuleMatch, b: RuleMatch): boolean {
	return a.project === b.project && a.host === b.host;
}
