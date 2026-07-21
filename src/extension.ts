import * as crypto from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { watchActivity } from './tracker/activity/activityCollector';
import { watchFocus } from './tracker/activity/focusController';
import { SegmentSink, SessionStateMachine } from './tracker/activity/sessionStateMachine';
import { watchGitContext } from './tracker/context/gitProvider';
import { resolveContext } from './tracker/context/workspaceResolver';
import { FileOutboxStore } from './tracker/storage/fileOutboxStore';
import { LocalSegment } from './tracker/types';
import { StatusBar } from './ui/statusBar';

const TICK_MS = 5000;
const CHECKPOINT_MS = 60_000;

let machine: SessionStateMachine | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('cvs Time Tracker');
	context.subscriptions.push(output);

	const config = vscode.workspace.getConfiguration('cvsTimeTracker');
	const outboxDir = path.join(context.globalStorageUri.fsPath, 'outbox');
	const instanceId = `${vscode.env.machineId}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
	const store = new FileOutboxStore(outboxDir, instanceId);

	const statusBar = new StatusBar();
	context.subscriptions.push({ dispose: () => statusBar.dispose() });

	// Count the outbox ONCE at activation, then track it in memory. Re-reading
	// every outbox file on every close is O(history) on the extension host.
	// Outbox growth between activations is bounded by pass-2 delivery/compaction.
	let pendingCount = store.listUndelivered().length;
	statusBar.setPending(pendingCount);

	const sink: SegmentSink = {
		onOpen: (record) => store.append(record),
		onCheckpoint: (record) => store.append(record),
		onClose: (segment: LocalSegment) => {
			store.append({ type: 'close', segment });
			// TODO(pass-2): delivery/purge will decrement pendingCount.
			pendingCount += 1;
			statusBar.setPending(pendingCount);
			output.appendLine(`closed ${segment.projectName} ${segment.activeMilliseconds}ms`);
		},
	};

	machine = new SessionStateMachine({
		instanceId,
		idleTimeoutMs: config.get<number>('tracking.idleTimeoutSeconds', 120) * 1000,
		focusLossGraceMs: config.get<number>('tracking.focusLossGraceMilliseconds', 250),
		minimumSegmentMs: config.get<number>('tracking.minimumSegmentSeconds', 20) * 1000,
		checkpointIntervalMs: CHECKPOINT_MS,
		sink,
		generateId: () => crypto.randomUUID(),
	});
	machine.setEnabled(config.get<boolean>('enabled', true), Date.now());
	machine.setContext(resolveContext());

	const refreshContext = () => machine?.setContext(resolveContext());
	const syncStatus = () => {
		if (machine) {
			statusBar.setState(machine.currentStatus());
		}
	};
	context.subscriptions.push(
		watchFocus((focused, now) => {
			machine?.onFocus(focused, now);
			syncStatus();
		}),
		watchActivity((now) => {
			machine?.onActivity(now);
			syncStatus();
		}),
		vscode.window.onDidChangeActiveTextEditor(refreshContext),
		vscode.workspace.onDidChangeWorkspaceFolders(refreshContext),
		watchGitContext(refreshContext)
	);

	const timer = setInterval(() => {
		machine?.tick(Date.now());
		syncStatus();
	}, TICK_MS);

	context.subscriptions.push(
		{ dispose: () => clearInterval(timer) },
		vscode.commands.registerCommand('cvsTimeTracker.showOutput', () => output.show()),
		vscode.commands.registerCommand('cvsTimeTracker.pause', () => {
			machine?.pause(Date.now());
			syncStatus();
		}),
		vscode.commands.registerCommand('cvsTimeTracker.resume', () => {
			machine?.resume(Date.now());
			syncStatus();
		})
	);

	output.appendLine(`cvs Time Tracker activated (instance ${instanceId})`);
}

export function deactivate(): void {
	machine?.shutdown(Date.now());
}
