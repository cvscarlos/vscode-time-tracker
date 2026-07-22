import * as assert from 'node:assert';
import { SessionStateMachine, SegmentSink } from './sessionStateMachine';
import { CheckpointRecord, LocalSegment, OpenRecord, TrackingContext } from '../types';

const iso = (ms: number) => new Date(ms).toISOString();
const ctx: TrackingContext = { workspaceKey: 'ws', projectName: 'proj', branch: 'main' };
const ctx2: TrackingContext = { workspaceKey: 'ws2', projectName: 'proj2', branch: 'dev' };

class RecordingSink implements SegmentSink {
	opens: OpenRecord[] = [];
	checkpoints: CheckpointRecord[] = [];
	closes: LocalSegment[] = [];
	onOpen(r: OpenRecord): void {
		this.opens.push(r);
	}
	onCheckpoint(r: CheckpointRecord): void {
		this.checkpoints.push(r);
	}
	onClose(s: LocalSegment): void {
		this.closes.push(s);
	}
}

function make(sink: SegmentSink): SessionStateMachine {
	let n = 0;
	return new SessionStateMachine({
		instanceId: 'inst',
		idleTimeoutMs: 120_000,
		focusLossToleranceMs: 25_000,
		minimumSegmentMs: 20_000,
		checkpointIntervalMs: 30_000,
		sink,
		generateId: () => `seg-${++n}`,
	});
}

suite('SessionStateMachine', () => {
	test('focus alone opens a segment; blur beyond tolerance closes at blur time', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 1000);
		// Focus starts tracking with no activity required.
		assert.equal(sink.opens.length, 1);
		assert.equal(sink.opens[0].start, iso(1000));
		m.onActivity(2000); // updates last activity; does not open a second segment
		assert.equal(sink.opens.length, 1);
		m.onFocus(false, 60_000);
		m.tick(60_000 + 25_000 + 1);
		assert.equal(sink.closes.length, 1);
		assert.equal(sink.closes[0].end, iso(60_000));
		assert.equal(sink.closes[0].activeMilliseconds, 59_000); // 60_000 - 1000 (focus start)
		assert.equal(sink.closes[0].branch, 'main');
	});

	test('focus without a project context does not start tracking (stays idle)', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.onFocus(true, 0); // no context set
		assert.equal(sink.opens.length, 0);
		assert.equal(m.currentStatus(), 'idle');
	});

	test('blur then refocus within tolerance does not close', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(1000);
		m.onFocus(false, 60_000);
		m.onFocus(true, 70_000);
		m.tick(71_000);
		assert.equal(sink.closes.length, 0);
	});

	test('an idle window closes crediting up to the idle cap past the last activity', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(25_000);
		m.tick(25_000 + 120_001);
		assert.equal(sink.closes.length, 1);
		// Ends at last activity + idle cap (25_000 + 120_000), not at last activity.
		assert.equal(sink.closes[0].end, iso(145_000));
		assert.equal(sink.closes[0].activeMilliseconds, 145_000);
	});

	test('a focused but inactive window still counts up to the idle cap, then resumes on activity', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0); // reading/reviewing: focused, zero editor activity
		assert.equal(sink.opens.length, 1);
		m.tick(120_001); // 120s (test cap) of no activity
		assert.equal(sink.closes.length, 1);
		assert.equal(sink.closes[0].end, iso(120_000)); // credited up to the cap
		assert.equal(sink.closes[0].activeMilliseconds, 120_000);
		m.onActivity(130_000); // activity resumes tracking with a fresh segment
		assert.equal(sink.opens.length, 2);
		assert.equal(sink.opens[1].start, iso(130_000));
	});

	test('activity just before the idle timeout keeps the segment open', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(30_000);
		m.tick(30_000 + 119_000);
		assert.equal(sink.closes.length, 0);
	});

	test('context change closes the current segment and reopens under the new context', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(1000);
		m.onActivity(25_000);
		m.setContext(ctx2);
		assert.equal(sink.closes.length, 1);
		assert.equal(sink.closes[0].projectName, 'proj');
		m.onActivity(26_000);
		assert.equal(sink.opens.length, 2);
		assert.equal(sink.opens[1].context.projectName, 'proj2');
	});

	test('sub-minimum segment is dropped, not closed', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(1000);
		m.onFocus(false, 5000);
		// tick past the blur tolerance so the segment finalizes: active time is
		// 5000 - 0 = 5000ms (focus start to blur) < the 20s minimum, so it is
		// dropped (no close emitted).
		m.tick(5000 + 25_000 + 1);
		assert.equal(sink.closes.length, 0);
	});

	test('currentStatus reflects the real machine state', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		assert.equal(m.currentStatus(), 'unfocused'); // not focused, no segment yet
		m.onFocus(true, 0);
		assert.equal(m.currentStatus(), 'tracking'); // focus alone starts tracking
		m.pause(2000);
		assert.equal(m.currentStatus(), 'paused');
		m.resume(3000);
		assert.equal(m.currentStatus(), 'idle'); // focused, but pause closed the segment
		m.onActivity(3500);
		assert.equal(m.currentStatus(), 'tracking'); // activity reopens
		m.onFocus(false, 4000);
		assert.equal(m.currentStatus(), 'grace'); // within the look-away tolerance
		m.tick(4000 + 25_000 + 1);
		assert.equal(m.currentStatus(), 'unfocused');
	});

	test('currentStatus shows grace during the look-away tolerance, then unfocused once closed', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(1000);
		assert.equal(m.currentStatus(), 'tracking');
		m.onFocus(false, 30_000);
		assert.equal(m.currentStatus(), 'grace');
		m.tick(30_000 + 25_000 + 1);
		assert.equal(sink.closes.length, 1);
		assert.equal(m.currentStatus(), 'unfocused');
	});

	test('a checkpoint is emitted after the checkpoint interval', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(1000);
		m.tick(31_100);
		assert.equal(sink.checkpoints.length, 1);
		assert.equal(sink.checkpoints[0].lastActivity, iso(1000));
	});
});
