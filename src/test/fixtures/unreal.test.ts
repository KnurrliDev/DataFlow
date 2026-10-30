import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findEngine, findUnrealProject, launcherInstalls, readRegistry, unrealDbPath } from '../../cdb/unreal';
import type { DataFlowApi } from '../../extension';
import { waitFor } from './helpers';

// An Unreal project with no compile database at the start. The command "Make Unreal Compile Database" lets
// UnrealBuildTool write the database into Intermediate/DataFlow, the engine starts with it, and it parses the Unreal code.
// scripts/prepare-fixtures.mjs makes the project from test/fixtures/unreal. With no Unreal Engine 5, the test is skipped.
suite('Unreal Engine project', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	let api: DataFlowApi;
	const state = () => JSON.stringify({ engine: api.store.state.engine, databases: api.store.state.databases.map((d) => [d.source, d.path]) });

	suiteSetup(async function () {
		this.timeout(60000);
		api = await vscode.extensions.getExtension<DataFlowApi>('KnurrliDev.dataflow')!.activate();
	});

	test('UnrealBuildTool makes the compile database, and the engine parses the Unreal code with no error', async function () {
		this.timeout(600000);
		const project = findUnrealProject(root());
		assert.ok(project, 'the fixture has a .uproject file');
		if (!await findEngine(project, { registry: readRegistry, launcherInstalls })) {
			this.skip();
		}
		const actor = path.join(root(), 'Source', 'BatteryPlant', 'BatteryActor.cpp');
		await vscode.window.showTextDocument(vscode.Uri.file(actor));
		await waitFor(() => api.store.state.engine === 'stopped' && api.store.state.databases.length === 0, 30000, state);

		await vscode.commands.executeCommand('dataflow.unreal.makeCompileDatabase');
		await waitFor(() => api.store.state.engine === 'ready' && api.store.state.databases.length === 1, 300000, state);
		const db = api.store.state.databases[0];
		assert.strictEqual(db.path.toLowerCase(), unrealDbPath(root()).toLowerCase(), state());
		assert.strictEqual(db.source, 'unreal');
		// the commands use the copies of the response files, because a normal build writes the files of UnrealBuildTool again
		const copies = path.join(root(), 'Intermediate', 'DataFlow', 'rsp').split(path.sep).join('/').toLowerCase();
		const commands = (JSON.parse(readFileSync(db.path, 'utf8')) as { command: string }[]).map((e) => e.command);
		assert.ok(commands.length > 0 && commands.every((c) => c.toLowerCase().includes(` @"${copies}/`)), commands.join('\n'));

		// the functions of the actor come from a parse with no error: the generated headers and the macros of Unreal work
		const result = await api.mcpHost.functions(actor) as { functions: { name: string }[]; parseErrors?: string[] };
		assert.strictEqual(result.parseErrors, undefined, JSON.stringify(result.parseErrors));
		assert.deepStrictEqual(result.functions.map((f) => f.name), [
			'ABatteryActor::ABatteryActor', 'ABatteryActor::Tick', 'ABatteryActor::PlanCharge', 'ABatteryActor::CheapestPrice',
		]);
	});
});
