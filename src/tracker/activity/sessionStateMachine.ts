import { CheckpointRecord, LocalSegment, OpenRecord, TrackingContext } from '../types';

export interface SegmentSink {
	onOpen(record: OpenRecord): void;
	onCheckpoint(record: CheckpointRecord): void;
	onClose(segment: LocalSegment): void;
}

export interface StateMachineOptions {
	instanceId: string;
	idleTimeoutMs: number;
	focusLossGraceMs: number;
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
	private enabled = true;
	private paused = false;
	private focused = false;
	private context: TrackingContext | undefined;
	private open: OpenSegment | undefined;
	private blurAt: number | undefined;

	constructor(private readonly options: StateMachineOptions) {}

	setContext(context: TrackingContext | undefined): void {
		if (sameContext(this.context, context)) {
			return;
		}
		this.finalize(this.open ? this.open.lastActivity : 0);
		this.context = context;
	}

	onFocus(focused: boolean, now: number): void {
		this.focused = focused;
		this.blurAt = focused ? undefined : now;
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
		if (this.blurAt !== undefined && now - this.blurAt >= this.options.focusLossGraceMs) {
			this.finalize(this.blurAt);
			this.blurAt = undefined;
			return;
		}
		if (!this.open) {
			return;
		}
		if (now - this.open.lastActivity >= this.options.idleTimeoutMs) {
			this.finalize(this.open.lastActivity);
			return;
		}
		if (now - this.open.lastCheckpointAt >= this.options.checkpointIntervalMs) {
			this.open.lastCheckpointAt = now;
			this.options.sink.onCheckpoint({
				type: 'checkpoint',
				id: this.open.id,
				lastActivity: iso(this.open.lastActivity),
			});
		}
	}

	pause(now: number): void {
		this.finalize(this.open ? this.open.lastActivity : now);
		this.paused = true;
	}

	resume(_now: number): void {
		this.paused = false;
	}

	setEnabled(enabled: boolean, now: number): void {
		if (!enabled) {
			this.finalize(this.open ? this.open.lastActivity : now);
		}
		this.enabled = enabled;
	}

	shutdown(now: number): void {
		const end = this.blurAt ?? now;
		this.finalize(end);
	}

	private canTrack(): boolean {
		return this.enabled && !this.paused && this.focused && this.context !== undefined;
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
		const segment: LocalSegment = {
			id: open.id,
			instanceId: this.options.instanceId,
			start: iso(open.start),
			end: iso(boundedEnd),
			activeMilliseconds,
			workspaceKey: open.context.workspaceKey,
			projectName: open.context.projectName,
			repositoryKey: open.context.repositoryKey,
			branch: open.context.branch,
			syncState: 'pending',
		};
		this.options.sink.onClose(segment);
	}
}

function sameContext(a: TrackingContext | undefined, b: TrackingContext | undefined): boolean {
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
