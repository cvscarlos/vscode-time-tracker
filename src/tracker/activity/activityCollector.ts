import * as vscode from 'vscode';

export function watchActivity(
	onActivity: (now: number) => void,
	debounceMs = 1000
): vscode.Disposable {
	let last = 0;
	const fire = () => {
		const now = Date.now();
		if (now - last >= debounceMs) {
			last = now;
			onActivity(now);
		}
	};

	const disposables: vscode.Disposable[] = [
		vscode.workspace.onDidChangeTextDocument(fire),
		vscode.workspace.onDidSaveTextDocument(fire),
		vscode.window.onDidChangeTextEditorSelection(fire),
		vscode.window.onDidChangeActiveTextEditor(fire),
		vscode.tasks.onDidStartTask(fire),
		vscode.debug.onDidChangeActiveDebugSession(fire),
	];

	const terminalApi = vscode.window as unknown as {
		onDidStartTerminalShellExecution?: (listener: () => void) => vscode.Disposable;
	};
	if (typeof terminalApi.onDidStartTerminalShellExecution === 'function') {
		disposables.push(terminalApi.onDidStartTerminalShellExecution(fire));
	} else {
		disposables.push(vscode.window.onDidChangeActiveTerminal(fire));
	}

	return vscode.Disposable.from(...disposables);
}
