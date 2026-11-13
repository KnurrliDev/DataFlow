import * as assert from 'assert';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DataFlowInternals } from '../../extension';
import { waitFor } from './helpers';

// A workspace folder with no compile database at the start, as before the first build of a project. A database that a
// build writes later starts the engine with no restart of the user, and a change of the database starts the engine
// again. scripts/prepare-fixtures.mjs makes the folder from the sources of the CMake fixture.
suite('A compile database that comes after the start', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const db = () => path.join(root(), 'build', 'msvc-debug', 'compile_commands.json');
	const writeDb = (file: string, names: string[]) => {
		const build = path.dirname(file);
		mkdirSync(build, { recursive: true });
		writeFileSync(file, JSON.stringify(names.map((name) => {
			const source = path.join(root(), 'src', name);
			return { directory: build, file: source, arguments: ['clang++', '-std=c++20', `-I${path.join(root(), 'include')}`, '-c', source] };
		}), null, 2));
	};
	let api: DataFlowInternals;
	const state = () => JSON.stringify({ engine: api.store.state.engine, databases: api.store.state.databases.map((d) => d.path) });

	suiteSetup(async function () {
		this.timeout(60000);
		api = await vscode.extensions.getExtension<DataFlowInternals>('KnurrliDev.dataflow')!.activate();
	});

	test('A new database starts the engine, and a change of the database starts it again', async function () {
		this.timeout(120000);
		await vscode.window.showTextDocument(vscode.Uri.file(path.join(root(), 'src', 'battery.cpp')));
		await waitFor(() => api.store.state.engine === 'stopped', 30000, state);
		assert.ok(api.store.state.databases.length === 0, state());

		// a build with a CMake preset writes the database into a new build folder
		writeDb(db(), ['battery.cpp']);
		await waitFor(() => api.store.state.engine === 'ready' && api.store.state.databases.length === 1, 60000, state);
		assert.strictEqual(api.store.state.databases[0].path.toLowerCase(), db().toLowerCase());

		// a change of the database stops the engine and starts it again
		const states: string[] = [];
		const listener = api.store.onDidChange(() => states.push(api.store.state.engine));
		try {
			writeDb(db(), ['battery.cpp', 'worker_pool.cpp']);
			await waitFor(() => states.includes('starting') && api.store.state.engine === 'ready', 60000, () => `${states.join(',')} ${state()}`);
		} finally {
			listener.dispose();
		}
	});

	test('A database in a new build folder next to the folder starts the engine', async function () {
		this.timeout(120000);
		// with no database, the engine stops. The watcher of the database keeps its folder open, so only the file goes
		rmSync(db(), { force: true });
		await waitFor(() => api.store.state.engine === 'stopped' && api.store.state.databases.length === 0, 60000, state);

		// Qt Creator makes its build folder next to the folder of the project, then writes the database into it
		const outside = path.join(path.dirname(root()), 'build-late-db-Desktop-Debug', 'compile_commands.json');
		writeDb(outside, ['battery.cpp']);
		await waitFor(() => api.store.state.engine === 'ready' && api.store.state.databases.length === 1, 60000, state);
		assert.strictEqual(api.store.state.databases[0].path.toLowerCase(), outside.toLowerCase());
	});
});
