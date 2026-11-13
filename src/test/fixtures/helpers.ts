import * as vscode from 'vscode';
import type { DataFlowInternals } from '../../extension';

// Waits until the condition is true. If the time ends first, the error contains the text of _describe.
export async function waitFor(condition: () => boolean, timeoutMs: number, describe: () => string): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > end) {
			throw new Error(`Timeout after ${timeoutMs} ms. ${describe()}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

// Opens a file, activates DataFlow, and waits for the engine.
export async function activateDataFlow(file: string): Promise<DataFlowInternals> {
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
	const ext = vscode.extensions.getExtension<DataFlowInternals>('KnurrliDev.dataflow');
	if (!ext) {
		throw new Error('VS Code did not find the DataFlow extension.');
	}
	const api = await ext.activate();
	await waitFor(() => api.store.state.engine === 'ready', 60000, () => JSON.stringify(api.store.state));
	return api;
}

// Opens a file and puts the cursor at a line and a column. Both start at 1.
export async function openAt(file: string, line: number, col: number): Promise<void> {
	const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
	const pos = new vscode.Position(line - 1, col - 1);
	editor.selection = new vscode.Selection(pos, pos);
}
