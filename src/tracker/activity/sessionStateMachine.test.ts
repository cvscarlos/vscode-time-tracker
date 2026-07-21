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
		focusLossGraceMs: 250,
		minimumSegmentMs: 20_000,
		checkpointIntervalMs: 30_000,
		sink,
		generateId: () => `seg-${++n}`,
	});
}

suite('SessionStateMachine', () => {
	test('focus + activity opens a segment; blur past grace closes at blur time', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 1000);
		m.onActivity(2000);
		assert.equal(sink.opens.length, 1);
		assert.equal(sink.opens[0].start, iso(2000));
		m.onFocus(false, 60_000);
		m.tick(60_300);
		assert.equal(sink.closes.length, 1);
		assert.equal(sink.closes[0].end, iso(60_000));
		assert.equal(sink.closes[0].activeMilliseconds, 58_000);
		assert.equal(sink.closes[0].branch, 'main');
	});

	test('blur then refocus within grace does not close', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(1000);
		m.onFocus(false, 60_000);
		m.onFocus(true, 60_100);
		m.tick(60_400);
		assert.equal(sink.closes.length, 0);
	});

	test('idle closes the segment at last activity', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		m.onActivity(1000);
		m.onActivity(25_000);
		m.tick(25_000 + 120_001);
		assert.equal(sink.closes.length, 1);
		assert.equal(sink.closes[0].end, iso(25_000));
		assert.equal(sink.closes[0].activeMilliseconds, 24_000);
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
		m.tick(5300);
		assert.equal(sink.closes.length, 0);
	});

	test('currentStatus reflects the real machine state', () => {
		const sink = new RecordingSink();
		const m = make(sink);
		m.setContext(ctx);
		m.onFocus(true, 0);
		assert.equal(m.currentStatus(), 'idle');
		m.onActivity(1000);
		assert.equal(m.currentStatus(), 'tracking');
		m.pause(2000);
		assert.equal(m.currentStatus(), 'paused');
		m.resume(3000);
		assert.equal(m.currentStatus(), 'idle');
		m.onFocus(false, 4000);
		m.tick(4300);
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
