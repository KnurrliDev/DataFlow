import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DataFlowApi } from '../../extension';
import type { SideCard, SideStory } from '../../side/protocol';
import { activateDataFlow, waitFor } from './helpers';

// Phase S5 of the side view: acceptance scenario 4 in the story of the side view. The review fixture is a git copy of
// the CMake fixture. The branch review changes the threshold in solve_power_plan() from 1e-5 to 1e-4.
suite('S5: Change Ripple in the side view', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const source = () => path.join(root(), 'src', 'battery.cpp');
	const main = () => path.join(root(), 'src', 'main.cpp');
	const lineOf = (file: string, text: string) => readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;
	const isFile = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const stepLines = (card: SideCard | undefined) => card?.rows.filter((r) => r.wave >= 0).map((r) => r.line) ?? [];

	let api: DataFlowApi;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(source());
	});
	suiteTeardown(async () => {
		await vscode.commands.executeCommand('dataflow.clearReview');
	});

	// Reviews the changes and waits for the story with the tokens of the engine
	const review = async (): Promise<SideStory> => {
		const before = api.side.story?.seq ?? 0;
		await vscode.commands.executeCommand('dataflow.reviewChanges');
		await waitFor(() => !!api.side.story && api.side.story.seq > before && !api.side.story.isRunning && api.side.story.changes.length > 0,
			60000, () => JSON.stringify(api.side.story ?? api.store.state.review)?.slice(0, 500));
		return api.side.story!;
	};

	test('A review shows the story: the diff, the facts and the cards of the ripple', async function () {
		this.timeout(90000);
		const story = await review();
		assert.ok(api.side.isOpen);
		assert.strictEqual(api.store.state.sideMode, 'story');
		assert.match(story.base ?? '', /^main \(merge base [0-9a-f]{7}\)$/);
		assert.match(story.notice ?? '', /call hierarchy/);

		const [change] = story.changes;
		const changed = lineOf(source(), 'if (cost < 1e-4)');
		assert.strictEqual(change.label, 'solve_power_plan()');
		// the diff: the old line and the new line, with the changed digit
		const removed = change.diff.find((r) => r.kind === 'removed')!;
		const added = change.diff.find((r) => r.kind === 'added')!;
		assert.strictEqual(removed.text.trim(), 'if (cost < 1e-5) {');
		assert.strictEqual(added.line, changed);
		assert.strictEqual(added.text.slice(...added.changed!), '4');
		assert.strictEqual(removed.text.slice(...removed.changed!), '5');
		assert.ok(added.spans.length > 0 && removed.spans.length > 0);
		assert.ok(change.diff.some((r) => r.kind === 'context'));
		assert.deepStrictEqual(change.stats.slice(0, 3), ['1 line changed', '2 functions', '1 async boundary']);

		// the cards of scenario 4: the change, the return to the lambda, the async call and the lines that read its value
		const [solve, lambda, process] = change.cards;
		assert.deepStrictEqual(change.cards.map((c) => c.label), ['solve_power_plan()', 'lambda in process()', 'process()']);
		assert.deepStrictEqual(stepLines(solve), [changed, lineOf(source(), 'res = cost;'), lineOf(source(), 'return res;')]);
		assert.strictEqual(solve.rows.find((r) => r.line === changed)?.note, 'changed');
		assert.ok(solve.rows.every((r) => r.fold !== undefined || r.text.length > 0));
		assert.strictEqual(lambda.link?.kind, 'return');
		assert.match(lambda.link!.text, /^solve_power_plan\(\) returns to the lambda in process\(\), line \d+$/);
		assert.deepStrictEqual(stepLines(lambda), [lineOf(source(), 'executor.async(')]);
		assert.strictEqual(process.link?.kind, 'async');
		assert.match(process.link!.text, /^async call: tf::Executor::async\. The value comes back through home_battery_ctl\.charging_future\.$/);
		assert.ok(process.isEstimated);
		for (const text of ['auto converged = ', 'if (converged)', 'requests = make_requests']) {
			assert.ok(stepLines(process).includes(lineOf(source(), text)), `${text}: ${stepLines(process).join(', ')}`);
		}
		assert.ok(process.exits.some((e) => e.text === 'return requests'), JSON.stringify(process.exits));
		// the rows have the tokens of the engine
		assert.ok(process.rows.filter((r) => r.wave >= 0).every((r) => r.spans.length > 0));
	});

	test('A click on a card shows its line in the file view and in the text editor, with the ripple of the file', async function () {
		this.timeout(60000);
		const line = lineOf(source(), 'auto converged = ');
		api.side.receive({ type: 'openPlace', file: source(), line });
		await waitFor(() => api.store.state.sideMode === 'file' && vscode.window.visibleTextEditors.some((e) =>
			isFile(e.document.uri.fsPath, source()) && e.selection.active.line === line - 1), 10000,
		() => `mode ${api.store.state.sideMode}, ${vscode.window.visibleTextEditors.map((e) => `${e.document.uri.fsPath}:${e.selection.active.line}`)}`);
		assert.ok(isFile(api.side.file ?? '', source()));
		const ripple = api.side.ripple!;
		assert.ok(ripple.lines.some((l) => l.isChange && l.line === lineOf(source(), 'if (cost < 1e-4)')));
		assert.ok(ripple.lines.some((l) => l.isEstimated && l.line === line));
		assert.ok(ripple.hints.some((h) => h.text.startsWith('async: tf::Executor::async')), JSON.stringify(ripple.hints));

		// the button of the bar goes back to the story, and the button of the story goes to the file view
		api.side.receive({ type: 'showStory' });
		assert.strictEqual(api.store.state.sideMode, 'story');
		api.side.receive({ type: 'showFileView' });
		assert.strictEqual(api.store.state.sideMode, 'file');
	});

	test('With a call hierarchy provider, the story shows the caller in main.cpp', async function () {
		this.timeout(90000);
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
			const story = await review();
			assert.strictEqual(api.store.state.sideMode, 'story');
			assert.strictEqual(story.notice, undefined);
			const card = story.changes[0].cards.find((c) => isFile(c.file, main()));
			assert.ok(card, JSON.stringify(story.changes[0].cards.map((c) => [c.label, c.file])));
			assert.strictEqual(card.label, 'main()');
			assert.strictEqual(card.depth, 2);
			assert.strictEqual(card.link?.kind, 'return');
			assert.match(card.link!.text, /^process\(\) returns to main\(\), main\.cpp:\d+$/);
			for (const text of ['auto requests = ', 'if (requests)', 'sent += requests->count', 'return sent']) {
				assert.ok(stepLines(card).includes(lineOf(main(), text)), `${text}: ${stepLines(card).join(', ')}`);
			}
			assert.ok(card.rows.filter((r) => r.wave >= 0).every((r) => r.spans.length > 0));
		} finally {
			provider.dispose();
		}
	});

	test('Clear removes the story and goes back to the file view', async () => {
		await vscode.commands.executeCommand('dataflow.clearReview');
		await waitFor(() => api.side.story === null, 5000, () => JSON.stringify(api.side.story)?.slice(0, 200));
		assert.strictEqual(api.store.state.sideMode, 'file');
		assert.strictEqual(api.side.ripple, null);
	});
});
