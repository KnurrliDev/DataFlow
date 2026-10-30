import * as assert from 'assert';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateDataFlow, openAt, waitFor } from './helpers';

// The P1 exit check on the qmake fixture. The extension must find build-qmake/Makefile.Release,
// make a compile database from it, and parse with the MSVC flags of qmake.
suite('P1 exit check: qmake fixture', () => {
	test('The side view shows the function under the cursor', async function () {
		this.timeout(120000);
		const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
		if (!existsSync(path.join(root, 'build-qmake', 'Makefile.Release'))) {
			// scripts/prepare-fixtures.mjs found no qmake on this computer
			this.skip();
		}
		const file = path.join(root, 'battery_qt.cpp');
		const api = await activateDataFlow(file);
		const state = () => JSON.stringify({ frame: api.side.frameState, databases: api.store.state.databases, errors: api.store.state.errorCount });
		const db = api.store.state.databases[0];
		assert.strictEqual(db?.source, 'qmake', state());
		assert.ok(db.makefile?.endsWith(path.join('build-qmake', 'Makefile.Release')), state());

		await openAt(file, 21, 5);
		await vscode.commands.executeCommand('dataflow.openSideView');
		await waitFor(() => api.side.frameState.fn?.endsWith('describe') === true, 60000, state);
		assert.strictEqual(api.store.state.errorCount, 0, state());

		// The second source file of the .pro file, through the same database
		const other = path.join(root, '..', 'battery', 'src', 'battery.cpp');
		await openAt(other, 46, 10);
		await waitFor(() => api.side.frameState.fn === 'electricity::power_ctrl::initial_power', 60000, state);
	});
});
