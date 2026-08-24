import * as assert from 'node:assert';
import { SyncEngine } from './syncEngine';
import { DeliveryBlock, TimeDestination } from './destination';
import { ConnectorError } from './connector';
import { Store } from '../tracker/storage/store';
import { LocalSegment, JournalRecord } from '../tracker/types';

function seg(id: string, startMs: number, endMs: number): LocalSegment {
	return {
		id,
		instanceId: 'inst',
		start: new Date(startMs).toISOString(),
		end: new Date(endMs).toISOString(),
		activeMilliseconds: endMs - startMs,
		workspaceKey: 'ws',
		projectName: 'proj',
		branch: 'main',
		syncState: 'pending',
	};
}

class MemStore implements Store {
	private delivered = new Set<string>(); // `${segId}:${destId}`
	constructor(private segments: LocalSegment[]) {}
	append(_r: JournalRecord): void {}
	recover(): LocalSegment[] {
		return this.segments;
	}
	listUndelivered(enabledIds: string[]): LocalSegment[] {
		return this.segments.filter(
			(s) => !(enabledIds.length > 0 && enabledIds.every((id) => this.isDelivered(s.id, id)))
		);
	}
	claim(): boolean {
		return true;
	}
	isDelivered(segId: string, destId: string): boolean {
		return this.delivered.has(`${segId}:${destId}`);
	}
	markDelivered(segId: string, destId: string): void {
		this.delivered.add(`${segId}:${destId}`);
	}
	compact(enabledIds: string[]): void {
		this.segments = this.listUndelivered(enabledIds);
	}
}

class FakeDest implements TimeDestination {
	prepared = false;
	delivered: string[] = [];
	attempts: string[] = [];
	constructor(
		readonly id: string,
		readonly label: string,
		private readonly behavior: { prepareThrows?: Error; deliverThrows?: Error } = {}
	) {}
	async prepare(): Promise<void> {
		if (this.behavior.prepareThrows) {
			throw this.behavior.prepareThrows;
		}
		this.prepared = true;
	}
	async deliver(block: DeliveryBlock): Promise<string> {
		this.attempts.push(block.segmentIds[0]);
		if (this.behavior.deliverThrows) {
			throw this.behavior.deliverThrows;
		}
		this.delivered.push(block.segmentIds[0]);
		return `${this.id}-ref`;
	}
	async retitle(): Promise<void> {}
}

// Old enough that aggregation settles it (now - end >= settleMs) and it rounds to >= 1 minute.
const OLD = seg('seg-1', 0, 60_000);
const NOW = 10 * 60_000;
const opts = {
	now: () => NOW,
	settleMs: 60_000,
	mergeGapMs: 120_000,
	log: () => {},
	onStatus: () => {},
};

suite('SyncEngine dispatcher', () => {
	test('delivers a ready block to every enabled destination', async () => {
		const store = new MemStore([OLD]);
		const a = new FakeDest('solidtime', 'solidtime');
		const b = new FakeDest('timetagger', 'TimeTagger');
		await new SyncEngine({ store, destinations: [a, b], ...opts }).runOnce();
		assert.deepEqual(a.delivered, ['seg-1']);
		assert.deepEqual(b.delivered, ['seg-1']);
		assert.equal(store.listUndelivered(['solidtime', 'timetagger']).length, 0);
	});

	test('a destination already holding the block is skipped', async () => {
		const store = new MemStore([OLD]);
		store.markDelivered('seg-1', 'solidtime');
		const a = new FakeDest('solidtime', 'solidtime');
		const b = new FakeDest('timetagger', 'TimeTagger');
		await new SyncEngine({ store, destinations: [a, b], ...opts }).runOnce();
		assert.deepEqual(a.delivered, []); // already delivered — not re-sent
		assert.deepEqual(b.delivered, ['seg-1']);
	});

	test('one backend failing does not block the other, and the block is retained', async () => {
		const store = new MemStore([OLD]);
		const down = new FakeDest('solidtime', 'solidtime', {
			deliverThrows: new ConnectorError('503', 503, true),
		});
		const up = new FakeDest('timetagger', 'TimeTagger');
		await new SyncEngine({ store, destinations: [down, up], ...opts }).runOnce();
		assert.deepEqual(up.delivered, ['seg-1']); // healthy backend still got it
		assert.equal(store.isDelivered('seg-1', 'timetagger'), true);
		assert.equal(store.isDelivered('seg-1', 'solidtime'), false);
		assert.equal(store.listUndelivered(['solidtime', 'timetagger']).length, 1); // retained for retry
	});

	test('a prepare failure isolates that destination while the other proceeds', async () => {
		const store = new MemStore([OLD]);
		const broken = new FakeDest('solidtime', 'solidtime', {
			prepareThrows: new ConnectorError('401', 401, false),
		});
		const up = new FakeDest('timetagger', 'TimeTagger');
		await new SyncEngine({ store, destinations: [broken, up], ...opts }).runOnce();
		assert.deepEqual(up.delivered, ['seg-1']);
		assert.equal(store.isDelivered('seg-1', 'solidtime'), false);
	});

	test('a settled sub-minute segment is discarded instead of staying pending forever', async () => {
		// ~29s active, settled (well past settleMs) but rounds to 0 duration — can
		// never grow into a deliverable block.
		const tooShort = seg('short', 0, 29_000);
		const store = new MemStore([tooShort]);
		const dest = new FakeDest('solidtime', 'solidtime');
		await new SyncEngine({ store, destinations: [dest], ...opts }).runOnce();
		assert.deepEqual(dest.delivered, []); // never became a deliverable block
		assert.equal(store.listUndelivered(['solidtime']).length, 0); // discarded, not rescanned forever
	});

	test('a non-retryable delivery error (401) marks the run errored and disables that destination for the rest of the run', async () => {
		// Two isolated blocks (gap > mergeGapMs) so the second block proves the
		// broken destination is not retried after the first failure.
		const first = seg('seg-1', 0, 60_000);
		const second = seg('seg-2', 300_000, 360_000);
		const store = new MemStore([first, second]);
		const broken = new FakeDest('solidtime', 'solidtime', {
			deliverThrows: new ConnectorError('unauthorized', 401, false),
		});
		const up = new FakeDest('timetagger', 'TimeTagger');
		let lastHasError: boolean | undefined;
		await new SyncEngine({
			store,
			destinations: [broken, up],
			now: opts.now,
			settleMs: opts.settleMs,
			mergeGapMs: opts.mergeGapMs,
			log: opts.log,
			onStatus: (_pending, hasError) => {
				lastHasError = hasError;
			},
		}).runOnce();
		assert.equal(lastHasError, true);
		assert.deepEqual(broken.attempts, ['seg-1']); // not retried for the second block
		assert.deepEqual(up.delivered, ['seg-1', 'seg-2']); // healthy destination still delivered both
	});
});
