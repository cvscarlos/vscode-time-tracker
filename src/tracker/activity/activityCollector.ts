import * as vscode from 'vscode';

export function watchActivity(
	onActivity: (now: number) => void,
	debounceMs = 1000,
	pollMs = 5000
): vscode.Disposable {
	let last = 0;
	const fire = () => {
		const now = Date.now();
		if (now - last < debounceMs) {
			return;
		}

		last = now;
		onActivity(now);
	};

	const disposables: vscode.Disposable[] = [
		vscode.workspace.onDidChangeTextDocument(fire),
		vscode.workspace.onDidSaveTextDocument(fire),
		vscode.window.onDidChangeTextEditorSelection(fire),
		vscode.window.onDidChangeActiveTextEditor(fire),
		vscode.tasks.onDidStartTask(fire),
		vscode.debug.onDidChangeActiveDebugSession(fire),
		// Terminal work counts too. VS Code exposes no per-keystroke (or "terminal
		// focused") event, but these cover switching into or opening a terminal,
		// first interacting with it, and running commands — so most terminal use
		// keeps tracking alive even with no editor edits.
		vscode.window.onDidChangeActiveTerminal(fire),
		vscode.window.onDidOpenTerminal(fire),
		vscode.window.onDidChangeTerminalState(fire),
		vscode.window.onDidStartTerminalShellExecution(fire),
		vscode.window.onDidEndTerminalShellExecution(fire),
		// Any mouse/keyboard input in the window, including views that raise no
		// extension events (e.g. the embedded browser). VS Code turns `active` off a
		// few seconds after input stops, so polling it only sees real interaction.
		vscode.window.onDidChangeWindowState((state) => {
			if (state.active) {
				fire();
			}
		}),
	];
	const poll = setInterval(() => {
		if (vscode.window.state.active) {
			fire();
		}
	}, pollMs);
	disposables.push({ dispose: () => clearInterval(poll) });

	return vscode.Disposable.from(...disposables);
}
