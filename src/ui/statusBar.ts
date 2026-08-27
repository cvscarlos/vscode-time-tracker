import * as vscode from 'vscode';

type StateKind =
	'tracking' | 'tracking-idle' | 'grace' | 'idle' | 'unfocused' | 'paused' | 'disabled';

const ICONS: Record<StateKind, string> = {
	tracking: '$(pulse) tracking',
	'tracking-idle': '$(pulse) tracking (idle)',
	grace: '$(watch) tracking (grace)',
	idle: '$(clock) idle',
	unfocused: '$(debug-pause) unfocused',
	paused: '$(circle-slash) paused',
	disabled: '$(circle-slash) off',
};

export class StatusBar {
	// Persistent: always shows the current tracking state; clicking opens the log.
	private readonly statusItem: vscode.StatusBarItem;
	// Action: shown ONLY when there is something to act on (idle time to discard),
	// so the status message is never overloaded with a click-action.
	private readonly actionItem: vscode.StatusBarItem;
	private kind: StateKind = 'idle';
	private pending = 0;
	private syncError = false;

	constructor() {
		this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3);
		this.statusItem.command = 'ntTimeTracker.showOutput';
		this.statusItem.tooltip = 'Time Tracker nt — click for the log';
		this.statusItem.show();

		this.actionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
		this.actionItem.command = 'ntTimeTracker.discardIdle';
		this.actionItem.tooltip = 'Discard this idle time (your active work is kept)';
		// hidden until there is idle time to discard

		this.render();
	}

	private render(): void {
		const parts = [ICONS[this.kind]];
		if (this.pending > 0) {
			parts.push(`$(cloud-upload) ${this.pending}`);
		}
		if (this.syncError) {
			parts.push('$(warning)');
		}
		this.statusItem.text = parts.join(' · ');
	}

	setState(kind: StateKind, idleMinutes = 0): void {
		this.kind = kind;
		if (kind === 'tracking-idle') {
			this.actionItem.text =
				idleMinutes > 0 ? `$(discard) discard ${idleMinutes}m idle` : '$(discard) discard idle';
			this.actionItem.show();
		} else {
			this.actionItem.hide();
		}
		this.render();
	}

	setPending(count: number): void {
		this.pending = count;
		this.render();
	}

	setSyncError(isFailing: boolean): void {
		this.syncError = isFailing;
		this.render();
	}

	dispose(): void {
		this.statusItem.dispose();
		this.actionItem.dispose();
	}
}
