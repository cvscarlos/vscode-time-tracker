import { MappingStore } from '../../src/connectors/mappingStore';
import { SolidtimeConnector } from '../../src/connectors/solidtime/solidtimeConnector';
import { SolidtimeDestination } from '../../src/connectors/solidtime/solidtimeDestination';
import { SyncEngine } from '../../src/connectors/syncEngine';
import { describeSites } from './describe.ts';
import { matchUrl, parseRules, type RuleMatch, type Rules } from './rules.ts';
import { ChromeOutboxStore, StorageCache } from './storage.ts';
import { GRACE_MS, TabTracker, type TrackerState, type TrackerStatus } from './tracker.ts';

// Same delivery cadence as the VS Code extension.
const SETTLE_MS = 5 * 60_000;
const MERGE_GAP_MS = 2 * 60_000;
const DEFAULT_API_URL = 'https://app.solidtime.io';
const STATE_KEY = 'tracker:state';
const RULES_KEY = 'settings:rules';

interface Runtime {
	cache: StorageCache;
	store: ChromeOutboxStore;
	tracker: TabTracker;
	rules: Rules;
}

function readRules(raw: unknown): Rules {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return [];
	}
	try {
		return parseRules(raw);
	} catch (error) {
		console.warn(`Ignoring invalid rules: ${(error as Error).message}`);
		return [];
	}
}

// The MV3 worker is suspended between events, so every event rebuilds this
// from storage first.
async function init(): Promise<Runtime> {
	const cache = await StorageCache.load(chrome.storage.local);
	const store = new ChromeOutboxStore(cache);
	const tracker = new TabTracker(cache.get<TrackerState>(STATE_KEY) ?? {}, {
		newId: () => crypto.randomUUID(),
		onClose: (segment) => {
			store.append({ type: 'close', segment });
		},
	});
	return { cache, store, tracker, rules: readRules(cache.get(RULES_KEY)) };
}

const ready = init();

/** The rule-matched active tab of the focused Chrome window, if any. */
async function currentMatch(rules: Rules): Promise<RuleMatch | undefined> {
	if ((await chrome.idle.queryState(60)) === 'locked') {
		return undefined;
	}
	const windows = await chrome.windows.getAll({
		populate: true,
		windowTypes: ['normal', 'devtools'],
	});
	const focused = windows.find((w) => w.focused);
	if (!focused) {
		return undefined;
	}
	// Debugging a page in an undocked DevTools window still counts as that page.
	const normal =
		focused.type === 'normal'
			? focused
			: await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
	return matchUrl(normal.tabs?.find((tab) => tab.active)?.url, rules);
}

const ICONS: Record<TrackerStatus, Record<string, string>> = {
	tracking: { 16: 'icons/tracking-16.png', 32: 'icons/tracking-32.png' },
	grace: { 16: 'icons/grace-16.png', 32: 'icons/grace-32.png' },
	off: { 16: 'icons/off-16.png', 32: 'icons/off-32.png' },
};

async function showStatus(runtime: Runtime, now: number): Promise<void> {
	const status = runtime.tracker.status(now);
	const open = runtime.tracker.snapshot().open;
	await chrome.action.setIcon({ path: ICONS[status] });
	await chrome.action.setTitle({
		title:
			status === 'off' || !open
				? 'Time Tracker nt: not tracking'
				: `Time Tracker nt: tracking ${open.match.project} (${open.match.host})`,
	});
	// Turn the icon off on time even if no other event wakes the worker.
	if (status === 'grace' && open?.leftAt !== undefined) {
		await chrome.alarms.create('grace', { when: open.leftAt + GRACE_MS });
	}
}

async function step(isHeartbeat: boolean): Promise<void> {
	const runtime = await ready;
	const match = await currentMatch(runtime.rules);
	const now = Date.now();
	if (isHeartbeat) {
		runtime.tracker.heartbeat(now);
	}
	runtime.tracker.observe(match, now);
	await runtime.cache.update(STATE_KEY, runtime.tracker.snapshot());
	await showStatus(runtime, now);
}

// Events arrive concurrently; observing them out of order would credit the wrong tab.
const serial = { tail: Promise.resolve() };
function refresh(isHeartbeat = false): void {
	serial.tail = runAfter(serial.tail, isHeartbeat);
}

async function runAfter(previous: Promise<void>, isHeartbeat: boolean): Promise<void> {
	await previous;
	try {
		await step(isHeartbeat);
	} catch (error) {
		console.error(error);
	}
}

// One run at a time: a slow backlog can outlast the 3-minute alarm, and two runs would
// create the same entry twice before either records it as delivered.
const syncing = { isRunning: false };

async function sync(): Promise<void> {
	if (syncing.isRunning) {
		return;
	}
	syncing.isRunning = true;
	try {
		const runtime = await ready;
		const settings = await chrome.storage.local.get([
			'settings:apiUrl',
			'settings:organizationId',
			'settings:token',
		]);
		const token = settings['settings:token'];
		if (typeof token !== 'string' || token === '') {
			return; // No token: keep tracking locally.
		}
		const apiUrl = (settings['settings:apiUrl'] as string | undefined) || DEFAULT_API_URL;
		const organizationId = (settings['settings:organizationId'] as string | undefined) || undefined;
		const destination = new SolidtimeDestination(
			new SolidtimeConnector(apiUrl, token, organizationId),
			new MappingStore(runtime.cache),
			apiUrl,
			{
				markerPrefix: 'chr',
				describe: (block) => describeSites(runtime.store.segmentsByIds(block.segmentIds)),
			}
		);
		const engine = new SyncEngine({
			store: runtime.store,
			destinations: [destination],
			now: () => Date.now(),
			settleMs: SETTLE_MS,
			mergeGapMs: MERGE_GAP_MS,
			log: (message) => console.log(message),
			onStatus: (_pending, hasError) => {
				void chrome.storage.local.set({
					'status:error': hasError
						? 'Last sync failed. Open the service worker console for details.'
						: '',
				});
			},
		});
		try {
			await engine.runOnce();
		} catch (error) {
			console.error(error);
		}
		await runtime.cache.flushed();
	} finally {
		syncing.isRunning = false;
	}
}

function scheduleAlarms(): void {
	void chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
	void chrome.alarms.create('sync', { periodInMinutes: 3 });
	refresh();
}

chrome.runtime.onInstalled.addListener(scheduleAlarms);
chrome.runtime.onStartup.addListener(scheduleAlarms);
chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
	if (changeInfo.url && tab.active) {
		refresh();
	}
});
chrome.windows.onFocusChanged.addListener(() => refresh());
chrome.idle.onStateChanged.addListener(() => refresh());
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === 'sync') {
		void sync();
	} else {
		refresh(alarm.name === 'heartbeat');
	}
});
chrome.storage.onChanged.addListener(async (changes, area) => {
	const change = changes[RULES_KEY];
	if (area !== 'local' || !change) {
		return;
	}
	const runtime = await ready;
	runtime.rules = readRules(change.newValue);
	refresh();
});
