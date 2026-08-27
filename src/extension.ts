import * as crypto from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { Backend, clearToken, getToken, setToken } from './configuration/secrets';
import { getSolidtimeConfig, getTimetaggerConfig } from './configuration/settings';
import {
	LEGACY_GRAY,
	randomProjectColor,
	SolidtimeConnector,
} from './connectors/solidtime/solidtimeConnector';
import { SolidtimeDestination } from './connectors/solidtime/solidtimeDestination';
import { TimetaggerClient } from './connectors/timetagger/timetaggerClient';
import { TimetaggerDestination } from './connectors/timetagger/timetaggerDestination';
import { TimeDestination } from './connectors/destination';
import { SyncEngine } from './connectors/syncEngine';
import { coveringCommit, TitleStore } from './connectors/titleStore';
import { MappingStore } from './connectors/mappingStore';
import { watchActivity } from './tracker/activity/activityCollector';
import { watchFocus } from './tracker/activity/focusController';
import { SegmentSink, SessionStateMachine } from './tracker/activity/sessionStateMachine';
import { backfillCommits, watchCommits } from './tracker/context/gitCommits';
import { watchGitContext } from './tracker/context/gitProvider';
import { resolveContext } from './tracker/context/workspaceResolver';
import { FileOutboxStore } from './tracker/storage/fileOutboxStore';
import { LocalSegment } from './tracker/types';
import { StatusBar } from './ui/statusBar';

const TICK_MS = 5000;
const CHECKPOINT_MS = 60_000;
// After this long without activity, a still-counting segment reads as
// "tracking (idle)" in the status bar — a heads-up before the idle cap stops it.
const IDLE_HINT_MS = 60_000;
const SYNC_MS = 3 * 60_000;
const SETTLE_MS = 5 * 60_000;
const MERGE_GAP_MS = 2 * 60_000;

let machine: SessionStateMachine | undefined;

async function promptForToken(
	context: vscode.ExtensionContext,
	backend: Backend,
	title: string,
	where: string
): Promise<void> {
	const existing = await getToken(context, backend);
	const token = await vscode.window.showInputBox({
		title,
		prompt: `Paste a personal API token from ${where}`,
		password: true,
		value: existing ? '' : undefined,
		placeHolder: existing ? '(a token is already set — type to replace)' : undefined,
	});
	if (token && token.trim() !== '') {
		await setToken(context, backend, token.trim());
		vscode.window.showInformationMessage(`${title.replace(' Token', '')} saved.`);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Time Tracker nt');
	context.subscriptions.push(output);

	const config = vscode.workspace.getConfiguration('ntTimeTracker');
	const outboxDir = path.join(context.globalStorageUri.fsPath, 'outbox');
	const instanceId = `${vscode.env.machineId}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
	const minimumSegmentMs = config.get<number>('tracking.minimumSegmentSeconds', 20) * 1000;
	// Recovered dangling-open segments below this active duration are dropped:
	// they never emitted a close and so never met the state machine's minimum.
	const store = new FileOutboxStore(outboxDir, instanceId, () => new Date(), minimumSegmentMs);

	const statusBar = new StatusBar();
	context.subscriptions.push({ dispose: () => statusBar.dispose() });

	// Count the outbox ONCE at activation, then track it in memory. Re-reading
	// every outbox file on every close is O(history) on the extension host.
	// Outbox growth between activations is bounded by pass-2 delivery/compaction.
	let pendingCount = store.listUndelivered([]).length;
	statusBar.setPending(pendingCount);

	const mappings = new MappingStore(context.globalState);
	const titleStore = new TitleStore(context.globalState);

	const buildDestinations = async (): Promise<TimeDestination[]> => {
		const destinations: TimeDestination[] = [];
		const solidtimeToken = await getToken(context, 'solidtime');
		if (solidtimeToken) {
			const cfg = getSolidtimeConfig();
			const connector = new SolidtimeConnector(cfg.apiUrl, solidtimeToken, cfg.organizationId);
			destinations.push(new SolidtimeDestination(connector, mappings, cfg.apiUrl));
		}
		const timetaggerToken = await getToken(context, 'timetagger');
		if (timetaggerToken) {
			const client = new TimetaggerClient(getTimetaggerConfig().apiUrl, timetaggerToken);
			destinations.push(new TimetaggerDestination(client));
		}
		return destinations;
	};

	const runTitling = async (destinations: TimeDestination[]) => {
		if (destinations.length === 0) {
			return;
		}
		const byId = new Map(destinations.map((d) => [d.id, d]));
		for (const d of destinations) {
			try {
				await d.prepare(new Date(0).toISOString());
			} catch (error) {
				byId.delete(d.id); // isolate: a failing backend must not block the others' titling
				output.appendLine(`${d.label} titling prepare failed: ${String(error)}`);
			}
		}
		const commits = titleStore.commits();
		for (const e of titleStore.untitled()) {
			const dest = byId.get(e.destination);
			if (!dest || !e.branch) {
				continue;
			}
			const c = coveringCommit(e.endMs, e.branch, e.workspaceKey, commits);
			if (!c) {
				continue;
			}
			try {
				await dest.retitle(e.ref, c.title, {
					markerId: e.markerId,
					projectName: e.projectName,
					branch: e.branch,
					startMs: e.startMs,
					endMs: e.endMs,
					focusMinutes: e.focusMinutes,
					idleMinutes: e.idleMinutes,
				});
				await titleStore.markTitled(e.destination, e.ref);
				output.appendLine(`${dest.label} titled ${e.ref} -> ${c.title}`);
			} catch (error) {
				output.appendLine(`${dest.label} titling failed: ${String(error)}`);
			}
		}
	};

	const runSync = async () => {
		const destinations = await buildDestinations();
		if (destinations.length === 0) {
			statusBar.setSyncError(false);
			return; // no token anywhere — track locally, deliver once a token is set
		}
		const engine = new SyncEngine({
			store,
			destinations,
			now: () => Date.now(),
			settleMs: SETTLE_MS,
			mergeGapMs: MERGE_GAP_MS,
			log: (m) => output.appendLine(m),
			onStatus: (pending, hasError) => {
				pendingCount = pending;
				statusBar.setPending(pending);
				statusBar.setSyncError(hasError);
			},
			onDelivered: (destinationId, ref, block) => {
				if (block.branch) {
					void titleStore.recordDelivered({
						destination: destinationId,
						ref,
						markerId: block.segmentIds[0],
						projectName: block.projectName,
						branch: block.branch,
						workspaceKey: block.workspaceKey,
						startMs: Date.parse(block.start),
						endMs: Date.parse(block.end),
						focusMinutes: block.focusMinutes,
						idleMinutes: block.idleMinutes,
					});
				}
			},
		});
		await engine.runOnce();
		await runTitling(destinations);
	};
	const syncTimer = setInterval(() => void runSync(), SYNC_MS);
	context.subscriptions.push({ dispose: () => clearInterval(syncTimer) });
	void runSync();

	context.subscriptions.push(
		watchCommits((c) => {
			void (async () => {
				await titleStore.addCommit(c);
				await runTitling(await buildDestinations());
			})();
		})
	);

	// Offline catch-up: pick up commits made while VS Code wasn't running, then
	// retitle anything they now cover. Fire-and-forget — activation must not wait.
	void (async () => {
		const backfilledCommits = await backfillCommits();
		for (const c of backfilledCommits) {
			await titleStore.addCommit(c);
		}
		await titleStore.prune(Date.now(), 48 * 60 * 60 * 1000);
		await runTitling(await buildDestinations());
	})();

	const sink: SegmentSink = {
		onOpen: (record) => store.append(record),
		onCheckpoint: (record) => store.append(record),
		onClose: (segment: LocalSegment) => {
			store.append({ type: 'close', segment });
			// pendingCount is reconciled to the authoritative count on each sync (onStatus).
			pendingCount += 1;
			statusBar.setPending(pendingCount);
			output.appendLine(`closed ${segment.projectName} ${segment.activeMilliseconds}ms`);
		},
	};

	// eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- module-level singleton set in activate(), read by deactivate()
	machine = new SessionStateMachine({
		instanceId,
		idleTimeoutMs: config.get<number>('tracking.idleTimeoutSeconds', 300) * 1000,
		focusLossToleranceMs: config.get<number>('tracking.focusLossToleranceSeconds', 30) * 1000,
		idleHintMs: IDLE_HINT_MS,
		minimumSegmentMs,
		checkpointIntervalMs: CHECKPOINT_MS,
		sink,
		generateId: () => crypto.randomUUID(),
	});
	machine.setEnabled(config.get<boolean>('enabled', true), Date.now());
	machine.setContext(resolveContext(), Date.now());

	const refreshContext = () => machine?.setContext(resolveContext(), Date.now());
	const syncStatus = () => {
		if (!machine) {
			return;
		}
		const now = Date.now();
		const idleMinutes = Math.round((machine.idleMillis(now) ?? 0) / 60_000);
		statusBar.setState(machine.currentStatus(now), idleMinutes);
	};
	context.subscriptions.push(
		watchFocus((isFocused, now) => {
			machine?.onFocus(isFocused, now);
			syncStatus();
		}),
		watchActivity((now) => {
			machine?.onActivity(now);
			syncStatus();
		}),
		vscode.window.onDidChangeActiveTextEditor(refreshContext),
		vscode.workspace.onDidChangeWorkspaceFolders(refreshContext),
		watchGitContext(refreshContext),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('ntTimeTracker.enabled')) {
				return;
			}
			machine?.setEnabled(
				vscode.workspace.getConfiguration('ntTimeTracker').get<boolean>('enabled', true),
				Date.now()
			);
			syncStatus();
		})
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
		vscode.commands.registerCommand('ntTimeTracker.discardIdle', async () => {
			const idleMs = machine?.idleMillis(Date.now());
			if (idleMs === undefined || idleMs < IDLE_HINT_MS) {
				await vscode.window.showInformationMessage(
					'Time Tracker nt: no idle time to discard right now.'
				);
				return;
			}
			const mins = Math.max(1, Math.round(idleMs / 60_000));
			const choice = await vscode.window.showInformationMessage(
				`You've been idle about ${mins} min. Discard that idle time? Your active work is kept.`,
				{ modal: true },
				'Discard idle',
				'Show log'
			);
			if (choice === 'Discard idle') {
				machine?.discardIdle();
				output.appendLine(`discarded ~${mins} min of idle time`);
				syncStatus();
			} else if (choice === 'Show log') {
				output.show();
			}
		}),
		vscode.commands.registerCommand('ntTimeTracker.setSolidtimeToken', () =>
			promptForToken(
				context,
				'solidtime',
				'SolidTime API Token',
				'SolidTime → Profile Settings → Create API Token'
			)
		),
		vscode.commands.registerCommand('ntTimeTracker.deleteSolidtimeToken', async () => {
			await clearToken(context, 'solidtime');
			vscode.window.showInformationMessage('SolidTime API token deleted.');
		}),
		vscode.commands.registerCommand('ntTimeTracker.setTimetaggerToken', () =>
			promptForToken(
				context,
				'timetagger',
				'TimeTagger API Token',
				'timetagger.app → Account → API token'
			)
		),
		vscode.commands.registerCommand('ntTimeTracker.deleteTimetaggerToken', async () => {
			await clearToken(context, 'timetagger');
			vscode.window.showInformationMessage('TimeTagger API token deleted.');
		}),
		vscode.commands.registerCommand('ntTimeTracker.syncNow', () => void runSync()),
		vscode.commands.registerCommand('ntTimeTracker.recolorGrayProjects', async () => {
			const token = await getToken(context, 'solidtime');
			if (!token) {
				await vscode.window.showInformationMessage(
					'Time Tracker nt: set your SolidTime token first.'
				);
				return;
			}
			const cfg = getSolidtimeConfig();
			const connector = new SolidtimeConnector(cfg.apiUrl, token, cfg.organizationId);
			try {
				const { organizationId } = await connector.resolveMember();
				const projects = await connector.listProjects(organizationId);
				const gray = projects.filter((p) => p.color === LEGACY_GRAY);
				if (gray.length === 0) {
					await vscode.window.showInformationMessage(
						'Time Tracker nt: no gray SolidTime projects to recolor.'
					);
					return;
				}
				const choice = await vscode.window.showInformationMessage(
					`Recolor ${gray.length} gray SolidTime project(s) with random colors? Projects you've already colored are left untouched.`,
					{ modal: true },
					'Recolor'
				);
				if (choice !== 'Recolor') {
					return;
				}
				let done = 0;
				for (const project of gray) {
					try {
						await connector.setProjectColor(organizationId, project, randomProjectColor());
						done++;
					} catch (error) {
						output.appendLine(`recolor failed for ${project.name}: ${String(error)}`);
					}
				}
				output.appendLine(`recolored ${done}/${gray.length} gray project(s)`);
				await vscode.window.showInformationMessage(
					`Time Tracker nt: recolored ${done} of ${gray.length} gray project(s).`
				);
			} catch (error) {
				output.appendLine(`recolor failed: ${String(error)}`);
				await vscode.window.showErrorMessage(`Time Tracker nt: recolor failed — ${String(error)}`);
			}
		})
	);

	const version = context.extension.packageJSON.version as string;
	output.appendLine(`Time Tracker nt v${version} activated (instance ${instanceId})`);
}

export function deactivate(): void {
	machine?.shutdown(Date.now());
}
