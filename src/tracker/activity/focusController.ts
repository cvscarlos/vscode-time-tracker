import * as vscode from 'vscode';

export function watchFocus(onFocus: (focused: boolean, now: number) => void): vscode.Disposable {
	onFocus(vscode.window.state.focused, Date.now());
	return vscode.window.onDidChangeWindowState((state) => onFocus(state.focused, Date.now()));
}
