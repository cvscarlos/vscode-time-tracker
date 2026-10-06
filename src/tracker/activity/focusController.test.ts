import * as assert from 'node:assert';
import { focusTracker } from './focusController';

suite('focusTracker', () => {
	test('a stale unfocused window corrected by user input stays focused through active-only events', () => {
		const reports: boolean[] = [];
		const tracker = focusTracker(false, (isFocused) => {
			reports.push(isFocused);
		});

		tracker.onUserInput();
		tracker.onWindowState(false); // `active` flip, still carrying the stale focused=false
		tracker.onWindowState(true);
		tracker.onWindowState(false); // real blur

		assert.deepEqual(reports, [false, true, true, false]);
	});
});
