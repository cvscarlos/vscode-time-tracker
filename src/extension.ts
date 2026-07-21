import * as crypto from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { watchActivity } from './tracker/activity/activityCollector';
import { watchFocus } from './tracker/activity/focusController';
import { SegmentSink, SessionStateMachine } from './tracker/activity/sessionStateMachine';
import { resolveContext } from './tracker/context/workspaceResolver';
import { JournalStore } from './tracker/storage/journalStore';
import { buildSegmentStore } from './tracker/storage/recovery';
import { SegmentStore } from './tracker/storage/segmentStore';
import { LocalSegment } from './tracker/types';
import { StatusBar } from './ui/statusBar';

const TICK_MS = 5000;

let machine: SessionStateMachine | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('cvs Time Tracker');
	context.subscriptions.push(output);

	const config = vscode.workspace.getConfiguration('cvsTimeTracker');
	const journalDir = path.join(context.globalStorageUri.fsPath, 'journals');
	const instanceId = `${vscode.env.machineId}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
	const journal = new JournalStore(journalDir, instanceId);

	const store: SegmentStore = buildSegmentStore(
		JournalStore.readInstanceFiles(journalDir, instanceId),
		instanceId
	);
	const statusBar = new StatusBar(store);
	context.subscriptions.push({ dispose: () => statusBar.dispose() });

	const sink: SegmentSink = {
		onOpen: (record) => journal.append(record),
		onCheckpoint: (record) => journal.append(record),
		onClose: (segment: LocalSegment) => {
			journal.append({ type: 'close', segment });
			store.add(segment);
			statusBar.refresh();
			output.appendLine(`closed ${segment.projectName} ${segment.activeMilliseconds}ms`);
		},
	};

	machine = new SessionStateMachine({
		instanceId,
		idleTimeoutMs: config.get<number>('tracking.idleTimeoutSeconds', 120) * 1000,
		focusLossGraceMs: config.get<number>('tracking.focusLossGraceMilliseconds', 250),
		minimumSegmentMs: config.get<number>('tracking.minimumSegmentSeconds', 20) * 1000,
		checkpointIntervalMs: 30_000,
		sink,
		generateId: () => crypto.randomUUID(),
	});
	machine.setEnabled(config.get<boolean>('enabled', true), Date.now());
	machine.setContext(resolveContext());

	const refreshContext = () => machine?.setContext(resolveContext());
	context.subscriptions.push(
		watchFocus((focused, now) => {
			machine?.onFocus(focused, now);
			statusBar.setState(focused ? 'idle' : 'unfocused', resolveContext());
		}),
		watchActivity((now) => {
			machine?.onActivity(now);
			statusBar.setState('tracking', resolveContext());
		}),
		vscode.window.onDidChangeActiveTextEditor(refreshContext),
		vscode.workspace.onDidChangeWorkspaceFolders(refreshContext)
	);

	const timer = setInterval(() => machine?.tick(Date.now()), TICK_MS);
	context.subscriptions.push(
		{ dispose: () => clearInterval(timer) },
		vscode.commands.registerCommand('cvsTimeTracker.showOutput', () => output.show()),
		vscode.commands.registerCommand('cvsTimeTracker.pause', () => {
			machine?.pause(Date.now());
			statusBar.setState('paused');
		}),
		vscode.commands.registerCommand('cvsTimeTracker.resume', () => {
			machine?.resume(Date.now());
			statusBar.setState('idle', resolveContext());
		})
	);

	output.appendLine(`cvs Time Tracker activated (instance ${instanceId})`);
}

export function deactivate(): void {
	machine?.shutdown(Date.now());
}
