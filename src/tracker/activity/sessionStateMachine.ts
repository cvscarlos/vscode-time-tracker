import { CheckpointRecord, LocalSegment, OpenRecord, TrackingContext } from '../types';

export interface SegmentSink {
	onOpen(record: OpenRecord): void;
	onCheckpoint(record: CheckpointRecord): void;
	onClose(segment: LocalSegment): void;
}

export interface StateMachineOptions {
	instanceId: string;
	idleTimeoutMs: number;
	focusLossToleranceMs: number;
	// After this long with no activity (but before idleTimeoutMs closes it), the
	// still-open segment is reported as 'tracking-idle' — a heads-up that we are
	// coasting on the idle credit, not actively tracking.
	idleHintMs: number;
	minimumSegmentMs: number;
	checkpointIntervalMs: number;
	sink: SegmentSink;
	generateId: () => string;
}

interface OpenSegment {
	id: string;
	start: number;
	lastActivity: number;
	context: TrackingContext;
	lastCheckpointAt: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class SessionStateMachine {
	private isEnabled = true;
	private paused = false;
	private focused = false;
	private context: TrackingContext | undefined;
	private open: OpenSegment | undefined;
	private blurAt: number | undefined;

	constructor(private readonly options: StateMachineOptions) {}

	private canTrack(): boolean {
		return this.isEnabled && !this.paused && this.focused && this.context !== undefined;
	}

	private openSegment(now: number): void {
		const id = this.options.generateId();
		this.open = {
			id,
			start: now,
			lastActivity: now,
			context: this.context!,
			lastCheckpointAt: now,
		};
		this.options.sink.onOpen({
			type: 'open',
			id,
			start: iso(now),
			instanceId: this.options.instanceId,
			context: this.context!,
		});
	}

	/**
	 * The ms to credit if the open segment closed right now: focus-only reading
	 * (no edits) is credited up to `now`, capped by the idle timeout past the
	 * last activity — mirrors the cap tick() already applies on idle-close.
	 * Only meaningful when `this.open` exists.
	 */
	private creditedEnd(now: number): number {
		return Math.min(now, this.open!.lastActivity + this.options.idleTimeoutMs);
	}

	private finalize(end: number): void {
		const open = this.open;
		if (!open) {
			return;
		}
		this.open = undefined;
		const boundedEnd = Math.max(end, open.start);
		const activeMilliseconds = boundedEnd - open.start;
		if (activeMilliseconds < this.options.minimumSegmentMs) {
			return;
		}
		const idleMilliseconds = Math.max(0, boundedEnd - Math.max(open.lastActivity, open.start));
		const segment: LocalSegment = {
			id: open.id,
			instanceId: this.options.instanceId,
			start: iso(open.start),
			end: iso(boundedEnd),
			activeMilliseconds,
			idleMilliseconds,
			workspaceKey: open.context.workspaceKey,
			projectName: open.context.projectName,
			repositoryKey: open.context.repositoryKey,
			branch: open.context.branch,
			syncState: 'pending',
		};
		this.options.sink.onClose(segment);
	}

	setContext(context: TrackingContext | undefined, now: number): void {
		if (isSameContext(this.context, context)) {
			return;
		}
		this.finalize(this.open ? this.creditedEnd(now) : 0);
		this.context = context;
		// Reopen immediately under the new context if still trackable, so
		// switching files/projects while focused doesn't wait for an editor event.
		if (this.canTrack()) {
			this.openSegment(now);
		}
	}

	onFocus(isFocused: boolean, now: number): void {
		this.focused = isFocused;
		this.blurAt = isFocused ? undefined : now;
		// Focus alone starts tracking — no edit required — so reading or reviewing
		// (e.g. an AI agent's terminal output) counts as work. The idle cap in
		// tick() still stops a focused-but-inactive window after idleTimeoutMs.
		if (isFocused && !this.open && this.canTrack()) {
			this.openSegment(now);
		}
	}

	onActivity(now: number): void {
		if (!this.canTrack()) {
			return;
		}
		if (this.open) {
			this.open.lastActivity = now;
			return;
		}
		this.openSegment(now);
	}

	tick(now: number): void {
		if (this.blurAt !== undefined && now - this.blurAt >= this.options.focusLossToleranceMs) {
			this.finalize(this.blurAt);
			this.blurAt = undefined;
			return;
		}
		if (!this.open) {
			return;
		}
		if (now - this.open.lastActivity >= this.options.idleTimeoutMs) {
			// Credit up to the idle cap past the last activity, then stop: a focused
			// reading/analysis session (no editor events) still counts, but only up
			// to idleTimeoutMs — an abandoned-but-focused window can't bank forever.
			this.finalize(this.open.lastActivity + this.options.idleTimeoutMs);
			return;
		}
		if (now - this.open.lastCheckpointAt >= this.options.checkpointIntervalMs) {
			this.open.lastCheckpointAt = now;
			this.options.sink.onCheckpoint({
				type: 'checkpoint',
				id: this.open.id,
				lastActivity: iso(this.open.lastActivity),
				at: iso(now),
			});
		}
	}

	pause(now: number): void {
		this.finalize(this.open ? this.creditedEnd(now) : now);
		this.paused = true;
	}

	resume(now: number): void {
		this.paused = false;
		// Resuming while still focused restarts tracking immediately, without
		// waiting for the next editor event.
		if (!this.open && this.canTrack()) {
			this.openSegment(now);
		}
	}

	setEnabled(isEnabled: boolean, now: number): void {
		if (!isEnabled) {
			this.finalize(this.open ? this.creditedEnd(now) : now);
		}
		this.isEnabled = isEnabled;
	}

	shutdown(now: number): void {
		const end = this.blurAt ?? now;
		this.finalize(end);
	}

	currentStatus(
		now: number
	): 'tracking' | 'tracking-idle' | 'grace' | 'idle' | 'unfocused' | 'paused' | 'disabled' {
		if (!this.isEnabled) {
			return 'disabled';
		}
		if (this.paused) {
			return 'paused';
		}
		if (this.blurAt !== undefined && this.open) {
			// Focus was lost but we are still within the look-away tolerance: the
			// segment is held open, so we are still counting for now.
			return 'grace';
		}
		if (this.open) {
			// Still counting toward the idle cap, but quiet for a while — surface it
			// so the user knows they have gone idle and tracking will stop soon.
			return now - this.open.lastActivity >= this.options.idleHintMs ? 'tracking-idle' : 'tracking';
		}
		if (!this.focused) {
			return 'unfocused';
		}
		return 'idle';
	}

	/** Milliseconds since the open segment's last activity, or undefined if none is open. */
	idleMillis(now: number): number | undefined {
		return this.open ? now - this.open.lastActivity : undefined;
	}

	/**
	 * Trim the current segment back to its last activity, dropping the idle grace
	 * accrued since — used when the idle time was unintentional. The active portion
	 * is still delivered; the idle tail is discarded. No-op if nothing is open.
	 */
	discardIdle(): void {
		if (this.open) {
			this.finalize(this.open.lastActivity);
		}
	}
}

function isSameContext(a: TrackingContext | undefined, b: TrackingContext | undefined): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.workspaceKey === b.workspaceKey &&
		a.projectName === b.projectName &&
		a.repositoryKey === b.repositoryKey &&
		a.branch === b.branch
	);
}
