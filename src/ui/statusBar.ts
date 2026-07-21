import * as vscode from 'vscode';
import { SegmentStore } from '../tracker/storage/segmentStore';
import { TrackingContext } from '../tracker/types';

type StateKind = 'tracking' | 'idle' | 'unfocused' | 'paused' | 'disabled';

export class StatusBar {
	private readonly item: vscode.StatusBarItem;
	private kind: StateKind = 'idle';
	private context: TrackingContext | undefined;

	constructor(private readonly store: SegmentStore) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3);
		this.item.command = 'cvsTimeTracker.showOutput';
		this.item.show();
		this.refresh();
	}

	setState(kind: StateKind, context?: TrackingContext): void {
		this.kind = kind;
		this.context = context;
		this.refresh();
	}

	refresh(): void {
		const today = new Date().toISOString().slice(0, 10);
		const total = formatDuration(this.store.totalMillisecondsOn(today));
		this.item.text = this.renderText(total);
		this.item.tooltip = "Today's tracked time — click for the log";
	}

	dispose(): void {
		this.item.dispose();
	}

	private renderText(total: string): string {
		switch (this.kind) {
			case 'tracking': {
				if (!this.context) {
					return `$(clock) ${total}`;
				}
				const branch = this.context.branch ? ` · ${this.context.branch}` : '';
				return `$(clock) ${this.context.projectName}${branch} · ${total}`;
			}
			case 'unfocused': {
				return `$(debug-pause) ${total}`;
			}
			case 'paused': {
				return `$(circle-slash) paused · ${total}`;
			}
			case 'disabled': {
				return `$(circle-slash) disabled`;
			}
			default: {
				return `$(clock) ${total}`;
			}
		}
	}
}

function formatDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}:${String(minutes).padStart(2, '0')}`;
}
