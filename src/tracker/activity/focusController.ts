import * as vscode from 'vscode';

/**
 * Tracks VS Code's raw window focus separately from the effective focus we report.
 * After a window reload VS Code can report the window unfocused and send no event
 * until focus moves again, so user input in an editor may correct it (`onUserInput`).
 * The raw value must stay separate: the window state event also fires for `active`
 * changes, still carrying the stale `focused=false`, and comparing that against the
 * corrected value would flip us back to unfocused.
 */
export function focusTracker(isInitiallyFocused: boolean, report: (isFocused: boolean) => void) {
	let isRawFocused = isInitiallyFocused;
	let isEffectivelyFocused = isInitiallyFocused;
	const set = (isFocused: boolean) => {
		isEffectivelyFocused = isFocused;
		report(isFocused);
	};
	set(isInitiallyFocused);
	return {
		onWindowState(isFocused: boolean) {
			if (isFocused === isRawFocused) {
				return;
			}
			isRawFocused = isFocused;
			set(isFocused);
		},
		onUserInput() {
			if (!isEffectivelyFocused) {
				set(true);
			}
		},
	};
}

export function watchFocus(onFocus: (isFocused: boolean, now: number) => void): vscode.Disposable {
	const tracker = focusTracker(vscode.window.state.focused, (isFocused) =>
		onFocus(isFocused, Date.now())
	);

	return vscode.Disposable.from(
		vscode.window.onDidChangeWindowState((state) => tracker.onWindowState(state.focused)),
		// Keyboard/mouse selection changes come only from the user in this window;
		// agent edits arrive as Command or undefined.
		vscode.window.onDidChangeTextEditorSelection((event) => {
			if (
				event.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
				event.kind === vscode.TextEditorSelectionChangeKind.Mouse
			) {
				tracker.onUserInput();
			}
		})
	);
}
