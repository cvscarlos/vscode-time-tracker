import * as vscode from 'vscode';

export function watchFocus(onFocus: (isFocused: boolean, now: number) => void): vscode.Disposable {
	let focused = vscode.window.state.focused;
	const report = (isFocused: boolean) => {
		focused = isFocused;
		onFocus(isFocused, Date.now());
	};
	report(focused);

	return vscode.Disposable.from(
		// The window state event also fires for `active` changes; only a real focus
		// change may reset the look-away timer.
		vscode.window.onDidChangeWindowState((state) => {
			if (state.focused !== focused) {
				report(state.focused);
			}
		}),
		// After a window reload VS Code can report the window unfocused and send no
		// event until focus moves again. A keyboard/mouse selection change can only
		// come from the user in this window (agent edits arrive as Command or
		// undefined), so it corrects that stale state.
		vscode.window.onDidChangeTextEditorSelection((event) => {
			if (
				!focused &&
				(event.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
					event.kind === vscode.TextEditorSelectionChangeKind.Mouse)
			) {
				report(true);
			}
		})
	);
}
