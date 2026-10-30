import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ProjectInfo } from '../../cdb/manager';
import type { DataFlowApi } from '../../extension';
import { waitFor } from './helpers';

// A project that is not open in VS Code. The window has no folder. DataFlow uses the compile database of the project,
// and VS Code opens only its files, so the extensions that start for a folder do not start.
suite('A project that is not open in VS Code', () => {
	const repo = path.resolve(__dirname, '..', '..', '..');
	const cmakeRoot = path.join(repo, 'test', 'fixtures', 'battery');
	const reviewRoot = path.join(repo, 'build', 'fixtures', 'battery-review');
	const isFile = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const write = (file: string, text: string) => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	let api: DataFlowApi;

	const state = () => JSON.stringify({ engine: api.store.state.engine, project: api.store.state.project, databases: api.store.state.databases });
	const useProject = async (folder: string): Promise<ProjectInfo> => {
		const project = await vscode.commands.executeCommand<ProjectInfo | undefined>('dataflow.project.use', folder);
		assert.ok(project, `no project in ${folder}`);
		await waitFor(() => api.store.state.engine === 'ready' && api.store.state.project?.root === project.root
			&& api.store.state.databases.length > 0, 60000, state);
		return project;
	};

	suiteSetup(async function () {
		this.timeout(60000);
		api = await vscode.extensions.getExtension<DataFlowApi>('local-dev.dataflow')!.activate();
		// the state of the window can keep the project of an earlier test run
		await vscode.commands.executeCommand('dataflow.closeProject');
	});
	suiteTeardown(async () => {
		await vscode.commands.executeCommand('dataflow.closeProject');
	});

	test('DataFlow uses the compile database of the project, and the window keeps no folder', async function () {
		this.timeout(120000);
		assert.strictEqual(vscode.workspace.workspaceFolders, undefined);
		const project = await useProject(cmakeRoot);
		assert.deepStrictEqual([project.name, project.root], ['battery', cmakeRoot]);
		assert.ok(isFile(api.store.state.databases[0].path, path.join(cmakeRoot, 'build', 'compile_commands.json')), state());

		// a file of the project opens beside the side view. The side view shows the function at the cursor
		await api.side.openFile(path.join(cmakeRoot, 'src', 'battery.cpp'));
		const editor = vscode.window.activeTextEditor!;
		editor.selection = new vscode.Selection(45, 9, 45, 9);
		await waitFor(() => api.side.isOpen && api.side.frameState.fn === 'electricity::power_ctrl::initial_power', 60000,
			() => JSON.stringify(api.side.frameState));
		assert.strictEqual(api.side.frameState.project, 'battery');

		// the DataFlow view in the activity bar shows the project and its compile database
		await vscode.commands.executeCommand('workbench.view.extension.dataflow');
		const items = api.home.getChildren();
		assert.strictEqual(items.find((i) => i.id === 'closeProject')?.description, 'battery');
		assert.strictEqual(items.find((i) => i.id === 'database')?.description, path.join('build', 'compile_commands.json'));

		// Flow Lens works on the file: acceptance scenario 1
		editor.selection = new vscode.Selection(40, 11, 40, 11);
		await vscode.commands.executeCommand('dataflow.traceVariable');
		await waitFor(() => api.side.flow?.name === 'bestFit', 30000, () => JSON.stringify(api.side.flow?.name ?? null));
		assert.deepStrictEqual(api.side.flow!.findings, [{ line: 46, text: 'optional not checked here' }]);
		assert.strictEqual(vscode.workspace.workspaceFolders, undefined);
	});

	test('The settings file of the project gives the settings of Logic Map', async function () {
		this.timeout(120000);
		// .vscode/settings.json of the fixture sets fire_transition as the event function. VS Code does not read the file,
		// because the window has no folder
		await useProject(cmakeRoot);
		const file = path.join(cmakeRoot, 'src', 'battery.cpp');
		await api.side.openFile(file);
		const line = readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('process(tf::Executor'));
		vscode.window.activeTextEditor!.selection = new vscode.Selection(line, 4, line, 4);
		if (!api.store.state.lenses.logic) {
			api.side.receive({ type: 'toggleLens', lens: 'logic' });
		}
		try {
			await waitFor(() => api.side.logic?.fn.endsWith('process') === true, 60000, () => JSON.stringify(api.side.logic?.fn ?? null));
			// the choices of acceptance scenario 2, part 1 give two events
			const keyOf = (prefix: string) => api.side.logic!.steps.find((s) => s.kind === 'decision' && s.key!.startsWith(prefix))?.key;
			for (const [prefix, value] of [['chain:home_battery_ctl.state', 'HOMEPOWER_METER_READING'], ['if:data.size() > 0', 'yes'],
				['if:home_battery_ctl.operational_mode == POWER_AUTO && ', 'yes']]) {
				const key = keyOf(prefix);
				assert.ok(key, `no decision ${prefix}`);
				api.side.receive({ type: 'setChoice', key, value });
			}
			assert.deepStrictEqual(api.side.logic!.events.map((e) => e.label), ['_measured', '_timeout']);
		} finally {
			api.side.receive({ type: 'resetChoices' });
			api.side.receive({ type: 'toggleLens', lens: 'logic' });
		}
	});

	test('A review of the project uses the git repository of the project', async function () {
		this.timeout(120000);
		await useProject(reviewRoot);
		await api.side.openFile(path.join(reviewRoot, 'src', 'battery.cpp'));
		await vscode.commands.executeCommand('dataflow.reviewChanges');
		await waitFor(() => !!api.side.story && !api.side.story.isRunning && (api.side.story.changes.length > 0 || !!api.side.story.message), 60000,
			() => JSON.stringify(api.side.story)?.slice(0, 300));
		const story = api.side.story!;
		assert.strictEqual(story.message, undefined);
		// the base origin/main does not exist, so the review uses main of the repository of the project
		const mergeBase = execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: reviewRoot, encoding: 'utf8' }).trim();
		assert.strictEqual(story.base, `main (merge base ${mergeBase.slice(0, 7)})`);
		assert.strictEqual(story.changes[0].label, 'solve_power_plan()');
		assert.strictEqual(vscode.workspace.workspaceFolders, undefined);
	});

	test('From the root folder of a project, DataFlow finds the build folders of Qt Creator', async function () {
		this.timeout(120000);
		const tmp = mkdtempSync(path.join(os.tmpdir(), 'dataflow-layouts-'));
		const db = readFileSync(path.join(cmakeRoot, 'build', 'compile_commands.json'), 'utf8');
		try {
			// a layout of Qt Creator: builds/<project>-<kit>-<configuration> in the project
			write(path.join(tmp, 'a', 'App.pro'), 'TEMPLATE = app\n');
			const a = path.join(tmp, 'a', 'builds', 'App-Desktop_Qt_6_11_2_MSVC2022_64bit-Debug', '.qtc_clangd', 'compile_commands.json');
			write(a, db);
			// a build folder outside of the project, from the project file of Qt Creator
			write(path.join(tmp, 'b', 'App.pro'), 'TEMPLATE = app\n');
			write(path.join(tmp, 'b', '.qtcreator', 'App.pro.user'), '<value type="QString" key="ProjectExplorer.BuildConfiguration.BuildDirectory">'
				+ '%{ActiveProject:NativePath}/../b-builds/%{Project:Name}-%{Kit:FileSystemName}-%{BuildConfig:Name}</value>');
			const b = path.join(tmp, 'b-builds', 'App-Desktop-Debug', '.qtc_clangd', 'compile_commands.json');
			write(b, db);
			// the old default of Qt Creator: next to the project, with the name of the .pro file
			write(path.join(tmp, 'c', 'Tool.pro'), 'TEMPLATE = app\n');
			const c = path.join(tmp, 'build-Tool-Desktop-Release', 'compile_commands.json');
			write(c, db);

			for (const [folder, expected] of [['a', a], ['b', b], ['c', c]]) {
				const project = await useProject(path.join(tmp, folder));
				assert.ok(isFile(project.db.path, expected), `${folder}: ${project.db.path}`);
				assert.ok(isFile(api.store.state.databases[0].path, expected), state());
			}
		} finally {
			await vscode.commands.executeCommand('dataflow.closeProject');
			await waitFor(() => api.store.state.project === undefined, 30000, state);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('An .inc file of the project opens as C++, and the side view shows it', async function () {
		this.timeout(120000);
		const tmp = mkdtempSync(path.join(os.tmpdir(), 'dataflow-unity-'));
		const unity = path.join(tmp, 'src', 'unity.cpp');
		const part = path.join(tmp, 'src', 'part.inc');
		try {
			// a unity build: the compile database has only the .cpp file, and the .cpp file includes the .inc file. The .inc
			// file uses kFactor of a header that the .cpp file includes before it
			write(path.join(tmp, 'CMakeLists.txt'), 'project(Unity CXX)\n');
			write(path.join(tmp, 'src', 'limits.h'), 'constexpr int kFactor = 3;\n');
			write(part, 'int scale(int value) {\n\tconst int factor = kFactor;\n\treturn value * factor;\n}\n');
			write(unity, '#include "limits.h"\n#include "part.inc"\n\nint main() { return scale(2); }\n');
			write(path.join(tmp, 'build', 'compile_commands.json'), JSON.stringify([
				{ directory: path.join(tmp, 'build'), file: unity, arguments: ['clang++', '-std=c++20', '-c', unity] },
			]));

			// with no compile database, the .inc file stays plain text
			const doc = await vscode.workspace.openTextDocument(part);
			await vscode.window.showTextDocument(doc);
			assert.strictEqual(doc.languageId, 'plaintext');

			// the project gives the compile database. The language changes in the open editor, and the side view shows
			// the function at the cursor with no move of the cursor. Alone, the .inc file has an error, so the engine parses
			// it again after the first line of unity.cpp
			await useProject(tmp);
			await waitFor(() => doc.languageId === 'cpp' && isFile(api.side.frameState.file ?? '', part) && api.side.frameState.fn === 'scale'
				&& api.side.frameState.errorCount === 0, 60000, () => JSON.stringify({ language: doc.languageId, frame: api.side.frameState }));

			// the user sets the language back to plain text. DataFlow does not change it again
			await vscode.languages.setTextDocumentLanguage(doc, 'plaintext');
			await new Promise((resolve) => setTimeout(resolve, 1000));
			assert.strictEqual(doc.languageId, 'plaintext');
			assert.strictEqual(vscode.workspace.workspaceFolders, undefined);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await vscode.commands.executeCommand('dataflow.closeProject');
			await waitFor(() => api.store.state.project === undefined, 30000, state);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('With no main and no master, Change Ripple uses the default branch of the remote', async function () {
		this.timeout(120000);
		// scripts/prepare-fixtures.mjs makes the repository: as in a clone, the remote origin has the default branch dev,
		// and the work is on the branch feature. The git extension keeps a repository open, so a test cannot delete it
		const remoteRoot = path.join(repo, 'build', 'fixtures', 'remote-default');
		const file = path.join(remoteRoot, 'src', 'calc.cpp');
		try {
			await useProject(remoteRoot);
			await api.side.openFile(file);
			await vscode.commands.executeCommand('dataflow.reviewChanges');
			await waitFor(() => !!api.side.story && !api.side.story.isRunning, 60000, () => JSON.stringify(api.side.story)?.slice(0, 300));
			const story = api.side.story!;
			assert.strictEqual(story.message, undefined);
			assert.strictEqual(story.target, 'origin/dev');
			const mergeBase = execFileSync('git', ['merge-base', 'HEAD', 'origin/dev'], { cwd: remoteRoot, encoding: 'utf8' }).trim();
			assert.strictEqual(story.base, `origin/dev (merge base ${mergeBase.slice(0, 7)})`);
			assert.strictEqual(story.changes[0].label, 'add()');

			// the branch that VS Code noted as the start of the branch comes before the default branch of the remote. The
			// git extension of the window can have a file of .git open for a moment. Then git cannot write the file, and a
			// try some time later works
			const git = async (...args: string[]) => {
				for (let attempt = 0; ; attempt++) {
					try {
						return execFileSync('git', args, { cwd: remoteRoot, encoding: 'utf8', stdio: 'pipe' });
					} catch (error) {
						if (attempt >= 5) {
							throw error;
						}
						await new Promise((resolve) => setTimeout(resolve, 300));
					}
				}
			};
			const review = async () => {
				await vscode.commands.executeCommand('dataflow.reviewChanges');
				await waitFor(() => !!api.side.story && !api.side.story.isRunning, 60000, () => JSON.stringify(api.side.story)?.slice(0, 300));
				return api.side.story!.target;
			};
			await git('config', 'branch.feature.vscode-merge-base', 'dev');
			assert.strictEqual(await review(), 'dev');

			// a target of the user belongs to the active branch. A different branch gets its own target
			await vscode.commands.executeCommand('dataflow.ripple.selectTarget', 'HEAD');
			assert.strictEqual(await review(), 'HEAD');
			await git('checkout', '-q', '-b', 'other');
			assert.strictEqual(await review(), 'origin/dev');
			await git('checkout', '-q', 'feature');
			assert.strictEqual(await review(), 'HEAD');
		} finally {
			try { execFileSync('git', ['config', '--unset', 'branch.feature.vscode-merge-base'], { cwd: remoteRoot, stdio: 'ignore' }); } catch { /* no entry */ }
			try { execFileSync('git', ['checkout', '-q', 'feature'], { cwd: remoteRoot, stdio: 'ignore' }); } catch { /* on feature */ }
			try { execFileSync('git', ['branch', '-q', '-D', 'other'], { cwd: remoteRoot, stdio: 'ignore' }); } catch { /* no branch */ }
			await vscode.commands.executeCommand('dataflow.ripple.selectTarget', '');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await vscode.commands.executeCommand('dataflow.clearReview');
			await vscode.commands.executeCommand('dataflow.closeProject');
			await waitFor(() => api.store.state.project === undefined, 30000, state);
		}
	});

	test('Close Project removes the compile database of the project', async function () {
		this.timeout(30000);
		await vscode.commands.executeCommand('dataflow.closeProject');
		await waitFor(() => api.store.state.project === undefined && api.store.state.databases.length === 0, 30000, state);
		assert.strictEqual(api.side.frameState.project, undefined);
		assert.deepStrictEqual(api.home.getChildren().filter((i) => ['closeProject', 'database'].includes(i.id)).map((i) => i.description),
			['none']);
		assert.strictEqual(api.store.state.review, undefined);
	});
});
