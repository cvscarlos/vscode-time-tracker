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
	private readonly item: vscode.StatusBarItem;
	private kind: StateKind = 'idle';
	private pending = 0;
	private syncError = false;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3);
		this.item.command = 'ntTimeTracker.showOutput';
		this.item.show();
		this.render();
	}

	setState(kind: StateKind): void {
		this.kind = kind;
		// While idle-but-still-counting, a click discards the idle time; otherwise
		// it opens the log.
		this.item.command =
			kind === 'tracking-idle' ? 'ntTimeTracker.discardIdle' : 'ntTimeTracker.showOutput';
		this.render();
	}

	setPending(count: number): void {
		this.pending = count;
		this.render();
	}

	setSyncError(failing: boolean): void {
		this.syncError = failing;
		this.render();
	}

	dispose(): void {
		this.item.dispose();
	}

	private render(): void {
		const parts = [ICONS[this.kind]];
		if (this.pending > 0) {
			parts.push(`$(cloud-upload) ${this.pending}`);
		}
		if (this.syncError) {
			parts.push('$(warning)');
		}
		this.item.text = parts.join(' · ');
		this.item.tooltip =
			this.kind === 'tracking-idle'
				? "You've gone idle — click to discard this idle time (your active work is kept)"
				: 'Time Tracker nt — click for the log';
	}
}
