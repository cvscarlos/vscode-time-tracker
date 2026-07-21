import * as crypto from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { getToken, setToken } from './configuration/secrets';
import { getSolidtimeConfig } from './configuration/settings';
import { MappingStore } from './connectors/mappingStore';
import { SolidtimeConnector } from './connectors/solidtime/solidtimeConnector';
import { SyncEngine } from './connectors/syncEngine';
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
const SYNC_MS = 3 * 60_000;

let machine: SessionStateMachine | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('nt Time Tracker');
	context.subscriptions.push(output);

	const config = vscode.workspace.getConfiguration('ntTimeTracker');
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

	const mappings = new MappingStore(context.globalState);
	const runSync = async () => {
		const token = await getToken(context);
		if (!token) {
			statusBar.setSyncError(false);
			return; // no token yet — track locally, deliver once a token is set
		}
		const cfg = getSolidtimeConfig();
		const connector = new SolidtimeConnector(cfg.apiUrl, token, cfg.organizationId);
		const engine = new SyncEngine({
			store,
			connector,
			mappings,
			projectNameFor: (s) => s.projectName,
			// eslint-disable-next-line unicorn/no-null -- SyncEngineDeps.taskNameFor contract uses null for "no task"
			taskNameFor: (s) => s.branch ?? null,
			log: (m) => output.appendLine(m),
			onStatus: (pending, error) => {
				statusBar.setPending(pending);
				statusBar.setSyncError(error);
			},
		});
		await engine.runOnce();
	};
	const syncTimer = setInterval(() => void runSync(), SYNC_MS);
	context.subscriptions.push({ dispose: () => clearInterval(syncTimer) });
	void runSync(); // attempt on activation

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
		vscode.commands.registerCommand('ntTimeTracker.showOutput', () => output.show()),
		vscode.commands.registerCommand('ntTimeTracker.pause', () => {
			machine?.pause(Date.now());
			syncStatus();
		}),
		vscode.commands.registerCommand('ntTimeTracker.resume', () => {
			machine?.resume(Date.now());
			syncStatus();
		}),
		vscode.commands.registerCommand('ntTimeTracker.setApiToken', async () => {
			const existing = await getToken(context);
			const token = await vscode.window.showInputBox({
				title: 'solidtime API Token',
				prompt: 'Paste a personal API token from solidtime → Profile Settings → Create API Token',
				password: true,
				value: existing ? '' : undefined,
				placeHolder: existing ? '(a token is already set — type to replace)' : undefined,
			});
			if (token && token.trim() !== '') {
				await setToken(context, token.trim());
				vscode.window.showInformationMessage('solidtime API token saved.');
			}
		}),
		vscode.commands.registerCommand('ntTimeTracker.syncNow', () => void runSync())
	);

	output.appendLine(`nt Time Tracker activated (instance ${instanceId})`);
}

export function deactivate(): void {
	machine?.shutdown(Date.now());
}
