import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateDataFlow, openAt, waitFor } from './helpers';

// The P1 exit check on the CMake fixture: the side view shows the function under the cursor.
// The extension must find build/compile_commands.json by itself.
suite('P1 exit check: CMake fixture', () => {
	test('The side view shows the function under the cursor', async function () {
		this.timeout(120000);
		const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
		const file = path.join(root, 'src', 'battery.cpp');
		const api = await activateDataFlow(file);
		const state = () => JSON.stringify({ frame: api.side.frameState, fn: api.store.state.fn?.qualifiedName, errors: api.store.state.errorCount });
		assert.ok(api.store.state.databases.some((db) => db.path === path.join(root, 'build', 'compile_commands.json')), state());

		await openAt(file, 46, 10);
		await vscode.commands.executeCommand('dataflow.openSideView');
		await waitFor(() => api.side.frameState.fn === 'electricity::power_ctrl::initial_power', 60000, state);
		assert.strictEqual(api.store.state.errorCount, 0, state());

		await openAt(file, 70, 5);
		await waitFor(() => api.side.frameState.fn === 'electricity::power_ctrl::solve_power_plan', 15000, state);
	});
});
