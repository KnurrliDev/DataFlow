import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DataFlowApi } from '../../extension';
import type { RippleModel } from '../../review/ripple';
import { activateDataFlow, waitFor } from './helpers';

// Acceptance scenario 4 on the review fixture: a git copy of the CMake fixture. The branch review changes the
// threshold in solve_power_plan() from 1e-5 to 1e-4. The base is the branch main. These tests check the model of the
// ripple. side-ripple.test.ts checks the story of the side view.
suite('P5 acceptance scenario 4: Change Ripple', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const source = () => path.join(root(), 'src', 'battery.cpp');
	const main = () => path.join(root(), 'src', 'main.cpp');
	const lineOf = (file: string, text: string) => readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;
	const isFile = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const reachedLines = (model: RippleModel, file: string) => new Set(model.changes.flatMap((c) =>
		c.bodies.filter((b) => isFile(b.file, file)).flatMap((b) => b.body.steps.flatMap((s) => s.lines))));

	let api: DataFlowApi;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(source());
	});

	const review = async (): Promise<RippleModel> => {
		const model = await vscode.commands.executeCommand<RippleModel | undefined>('dataflow.reviewChanges');
		assert.ok(model, JSON.stringify(api.store.state.review));
		return model!;
	};

	test('The new threshold reaches the result, the async call, the value of the future and the commands', async function () {
		this.timeout(60000);
		const model = await review();
		assert.deepStrictEqual(model.errors, []);
		const [change] = model.changes;
		assert.strictEqual(change.fn.name, 'solve_power_plan');
		assert.deepStrictEqual(change.lines, [lineOf(source(), 'if (cost < 1e-4)')]);

		const reached = reachedLines(model, source());
		for (const text of ['res = cost;', 'return res;', 'executor.async(', 'auto converged = ', 'if (converged)', 'requests = make_requests']) {
			assert.ok(reached.has(lineOf(source(), text)), `${text}: ${[...reached].join(', ')}`);
		}
		const asyncStep = change.bodies.flatMap((b) => b.body.steps).find((s) => s.kind === 'async');
		assert.strictEqual(asyncStep?.line, lineOf(source(), 'executor.async('));

		// the test build of VS Code has no call hierarchy provider, so the side view tells the user
		assert.ok(model.isCallHierarchyMissing);
		const state = api.store.state.review!;
		assert.match(state.notice ?? '', /call hierarchy/);
		assert.match(state.base ?? '', /^main \(merge base [0-9a-f]{7}\)$/);
	});

	test('With a call hierarchy provider, the ripple gets to the caller of process() in main.cpp', async function () {
		this.timeout(60000);
		// a provider for the test: process() has one caller in main.cpp. The engine finds the callers in the same file
		const itemOf = (uri: vscode.Uri, name: string, line: number) => new vscode.CallHierarchyItem(
			vscode.SymbolKind.Function, name, '', uri, new vscode.Range(line, 0, line, 1), new vscode.Range(line, 0, line, 1));
		const provider = vscode.languages.registerCallHierarchyProvider({ language: 'cpp' }, {
			prepareCallHierarchy: (doc, pos) => itemOf(doc.uri, doc.getText(doc.getWordRangeAtPosition(pos)), pos.line),
			provideCallHierarchyIncomingCalls: (item) => {
				if (item.name !== 'process') {
					return [];
				}
				const line = lineOf(main(), 'process(executor') - 1;
				const col = readFileSync(main(), 'utf8').split(/\r?\n/)[line].indexOf('process(');
				return [new vscode.CallHierarchyIncomingCall(itemOf(vscode.Uri.file(main()), 'main', line), [new vscode.Range(line, col, line, col + 7)])];
			},
			provideCallHierarchyOutgoingCalls: () => [],
		});
		try {
			const model = await review();
			assert.ok(!model.isCallHierarchyMissing);
			const reached = reachedLines(model, main());
			for (const text of ['auto requests = ', 'if (requests)', 'sent += requests->count', 'return sent']) {
				assert.ok(reached.has(lineOf(main(), text)), `${text}: ${[...reached].join(', ')}`);
			}
			assert.strictEqual(model.changes[0].bodies.find((b) => isFile(b.file, main()))?.depth, 2);
			assert.strictEqual(api.store.state.review!.notice, undefined);
		} finally {
			provider.dispose();
		}
	});

	test('A target branch of the user replaces the automatic target, also in the next review', async function () {
		this.timeout(60000);
		try {
			// HEAD gives only the changes that are not committed. The branch review has none
			await vscode.commands.executeCommand('dataflow.ripple.selectTarget', 'HEAD');
			const state = api.store.state.review!;
			assert.deepStrictEqual([state.target, state.message], ['HEAD', 'No C or C++ file changed against the target branch.']);
			assert.match(state.base ?? '', /^HEAD \(merge base [0-9a-f]{7}\)$/);
			await review();
			assert.strictEqual(api.store.state.review!.target, 'HEAD');
		} finally {
			// Automatic again
			await vscode.commands.executeCommand('dataflow.ripple.selectTarget', '');
		}
		assert.deepStrictEqual([api.store.state.review!.target, api.store.state.review!.message], ['main', undefined]);
	});

	test('A file with changes that are not saved gets the diff of the text of its editor', async function () {
		this.timeout(60000);
		// the engine slices the text of the editor. A new line at the top moves the changed line down by one
		const threshold = lineOf(source(), 'if (cost < 1e-4)');
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(source()));
		await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// a line that is not saved\n'));
		try {
			const model = await review();
			assert.deepStrictEqual(model.errors, []);
			assert.deepStrictEqual(model.changes.find((c) => c.fn.name === 'solve_power_plan')?.lines, [threshold + 1]);
			const other = model.other.find((o) => isFile(o.file, source()));
			assert.ok(other && [...other.outside, ...other.quiet].includes(1), JSON.stringify(model.other));
		} finally {
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
		assert.ok(!editor.document.isDirty);
	});

	test('A save of a file of the repository updates the review, and the side view keeps its mode', async function () {
		this.timeout(90000);
		const threshold = lineOf(source(), 'if (cost < 1e-4)');
		await review();
		const changeLine = () => api.store.state.rippleLayer?.model.changes.find((c) => c.fn.name === 'solve_power_plan')?.lines[0];
		assert.strictEqual(changeLine(), threshold);
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(source()));
		api.store.update({ sideMode: 'file' });
		await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// a saved line\n'));
		try {
			await editor.document.save();
			await waitFor(() => changeLine() === threshold + 1, 60000, () => `line ${changeLine()}, ${JSON.stringify(api.store.state.review)}`);
			assert.deepStrictEqual([api.store.state.review?.message, api.store.state.sideMode], [undefined, 'file']);
		} finally {
			await editor.edit((b) => b.delete(new vscode.Range(0, 0, 1, 0)));
			await editor.document.save();
		}
		await waitFor(() => changeLine() === threshold, 60000, () => `line ${changeLine()}`);
	});

	test('A restart of the engine runs the review again', async function () {
		this.timeout(120000);
		await review();
		await vscode.commands.executeCommand('dataflow.restartEngine');
		const state = () => JSON.stringify({ engine: api.store.state.engine, review: api.store.state.review }).slice(0, 400);
		await waitFor(() => api.store.state.engine === 'ready' && api.store.state.review?.isRunning === false && !!api.store.state.rippleLayer,
			60000, state);
		assert.deepStrictEqual([api.store.state.review!.message, api.store.state.sideMode], [undefined, 'story']);
	});

	test('Clear Review removes the ripple', async () => {
		await vscode.commands.executeCommand('dataflow.clearReview');
		assert.strictEqual(api.store.state.review, undefined);
		assert.strictEqual(api.store.state.rippleLayer, undefined);
		assert.strictEqual(api.side.ripple, null);
	});
});
