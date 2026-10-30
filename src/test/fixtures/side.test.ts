import * as assert from 'assert';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DataFlowApi } from '../../extension';
import { LEXICAL_KEYS, semanticStyleIndex, SEMANTIC_TYPES } from '../../side/model';
import { activateDataFlow, waitFor } from './helpers';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Phase S1 of the side view on the CMake fixture: the code view, the scroll sync and the time of a render
suite('S1: side view', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const file = () => path.join(root(), 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(file(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;
	const firstLine = (editor: vscode.TextEditor) => editor.visibleRanges[0].start.line + 1;

	let api: DataFlowApi;
	let editor: vscode.TextEditor;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		await vscode.commands.executeCommand('dataflow.openSideView');
		await waitFor(() => api.side.file === file() && api.side.tokenVersion !== undefined, 60000,
			() => `file ${api.side.file}, tokens ${api.side.tokenVersion}`);
	});

	test('The side view shows the text of the file with the kinds of the engine', () => {
		const rows = api.side.rows;
		assert.strictEqual(rows.length, editor.document.lineCount);
		// the style index of the first span with this text on the first line that contains the line text
		const styleOf = (lineText: string, name: string) => {
			const row = rows[lineOf(lineText) - 1];
			for (let i = 0; i < row.spans.length; i += 3) {
				if (row.text.slice(row.spans[i], row.spans[i + 1]) === name) {
					return row.spans[i + 2];
				}
			}
			return -1;
		};
		const semantic = (type: string, bits = 0) => semanticStyleIndex(SEMANTIC_TYPES.indexOf(type as never), bits);
		assert.strictEqual(rows[0].text, editor.document.lineAt(0).text);
		assert.strictEqual(styleOf('std::optional<charge::Preset> best_preset(', 'best_preset'), semantic('function', 0b0001));
		assert.strictEqual(styleOf('std::optional<charge::Preset> best_preset(', 'optional'), semantic('class', 0b1000));
		assert.strictEqual(styleOf('// the kw of the active plan', '// the kw of the active plan'), LEXICAL_KEYS.indexOf('comment'));
		assert.strictEqual(styleOf('FINISHED(', 'FINISHED'), semantic('macro'));
		assert.strictEqual(styleOf('static std::map', 'last_read'), semantic('variable', 0b0101));
	});

	test('The side view gets the colors of the color theme', () => {
		const functionStyle = api.side.styleTable[semanticStyleIndex(SEMANTIC_TYPES.indexOf('function'), 0)];
		assert.match(functionStyle.color ?? '', /^#/, JSON.stringify(functionStyle));
	});

	test('With no extension that gives semantic tokens, the side view gets only the colors of the grammar', async () => {
		// the test build of VS Code has no C/C++ extension. The grammar gives no scope to a variable, so a variable has
		// the color of the text, as in the text editor
		const variable = semanticStyleIndex(SEMANTIC_TYPES.indexOf('variable'), 0);
		await waitFor(() => api.side.styleTable[variable]?.color === undefined, 10000, () => JSON.stringify(api.side.styleTable[variable]));
	});

	test('An edit in one line shows at once in the side view, before the engine parses it', async function () {
		this.timeout(30000);
		const line = lineOf('static std::map');
		const before = api.side.rows[line - 1];
		const name = before.text.indexOf('last_read');
		const span = (row: typeof before) => {
			for (let i = 0; i < row.spans.length; i += 3) {
				if (row.text.slice(row.spans[i], row.spans[i + 1]).startsWith('last_read')) {
					return row.spans.slice(i, i + 3);
				}
			}
			return undefined;
		};
		// the engine gets the text 250 ms after the last key, so the row has the new text before a parse
		await editor.edit((b) => b.insert(new vscode.Position(line - 1, name), 'old_'));
		try {
			const row = api.side.rows[line - 1];
			assert.strictEqual(row.text, editor.document.lineAt(line - 1).text);
			assert.deepStrictEqual(span(row), [name + 4, name + 4 + 'last_read'.length, span(before)![2]]);
		} finally {
			await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
		assert.ok(!editor.document.isDirty);
		await waitFor(() => api.side.rows[line - 1].text === before.text, 10000, () => api.side.rows[line - 1].text);
	});

	test('The side view scrolls with the text editor', async () => {
		// the editor keeps some lines above a revealed line, for example for the sticky scroll
		const before = firstLine(editor);
		const target = lineOf('std::optional<Requests> process(');
		editor.revealRange(new vscode.Range(target - 1, 0, target - 1, 0), vscode.TextEditorRevealType.AtTop);
		await waitFor(() => firstLine(editor) !== before && api.side.lastScrollTo === firstLine(editor), 5000,
			() => `editor ${firstLine(editor)}, side view ${api.side.lastScrollTo}`);
	});

	test('The text editor scrolls with the side view, and the echo does not come back', async () => {
		await sleep(400); // after the guard against echoes of the last test
		const sent = api.side.lastScrollTo;
		const target = lineOf('stable_readings(const MeterFeeds');
		api.side.receive({ type: 'scroll', line: target });
		await waitFor(() => firstLine(editor) === target, 5000, () => `editor ${firstLine(editor)}`);
		await sleep(400);
		assert.strictEqual(api.side.lastScrollTo, sent, 'the scroll of the editor went back to the side view');
	});

	test('A click on a line of the side view moves the cursor of the text editor', () => {
		const line = lineOf('return data;');
		api.side.receive({ type: 'select', line });
		assert.strictEqual(editor.selection.active.line, line - 1);
	});

	test('The side view renders the visible rows of a file of 2,000 lines in less than 100 ms', async function () {
		this.timeout(120000);
		// a file of 2,400 lines in the build folder of the fixture. git ignores this folder
		const big = path.join(root(), 'build', 'side-view-2400.cpp');
		const lines = ['#include <vector>', ''];
		for (let i = 0; lines.length < 2400; i++) {
			lines.push(`int sum_${i}(const std::vector<int> &values, int limit) {`, '  int sum = 0;', '  for (int v : values) {',
				'    if (v > limit) {', '      sum += v * 2;', '    } else {', '      sum -= v; // a value below the limit', '    }', '  }',
				'  return sum;', '}', '');
		}
		writeFileSync(big, lines.join('\n'));
		const count = api.side.renderTimes.length;
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(big), vscode.ViewColumn.One);
		await waitFor(() => api.side.file === big && api.side.tokenVersion !== undefined, 60000,
			() => `file ${api.side.file}, tokens ${api.side.tokenVersion}`);
		await waitFor(() => api.side.renderTimes.length >= count + 2, 10000, () => `renders ${api.side.renderTimes.slice(count)}`);
		const times = api.side.renderTimes.slice(count);
		console.log(`render times of the side view for ${api.side.rows.length} lines: ${times.map((t) => t.toFixed(1)).join(', ')} ms`);
		assert.ok(api.side.rows.length >= 2000);
		assert.ok(Math.max(...times) < 100, `render times ${times}`);
	});

	test('The side view dims the lines that a condition of the preprocessor skips', async function () {
		this.timeout(120000);
		// a file in the build folder of the fixture. git ignores this folder
		const conditions = path.join(root(), 'build', 'side-view-inactive.cpp');
		writeFileSync(conditions, ['#define FAST 1', 'int value() {', '#if 0', '  return 0;', '#endif', '#ifdef SLOW', '  return 1;',
			'#elif FAST', '  return 2;', '#else', '  return 3;', '#endif', '}', ''].join('\n'));
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(conditions), vscode.ViewColumn.One);
		await waitFor(() => api.side.file === conditions && api.side.inactiveRanges !== undefined, 60000,
			() => `file ${api.side.file}, ranges ${JSON.stringify(api.side.inactiveRanges)}`);
		assert.deepStrictEqual(api.side.inactiveRanges, [[4, 4], [7, 7], [11, 11]]);
		// the code view of the webview has a row for each line of the file, and it dims the three inactive rows
		await waitFor(() => api.side.lastInactiveRows === 3, 10000, () => `inactive rows ${api.side.lastInactiveRows}`);
	});
});

// Phase S2 on the CMake fixture: acceptance scenario 1 with Flow Lens in the side view
suite('S2: Flow Lens in the side view', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(file(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;

	let api: DataFlowApi;
	let editor: vscode.TextEditor;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
	});

	test('Acceptance scenario 1: the side view marks the unchecked access to bestFit on line 46', async function () {
		this.timeout(60000);
		const line = lineOf('auto bestFit = best_preset(');
		const pos = new vscode.Position(line - 1, editor.document.lineAt(line - 1).text.indexOf('bestFit'));
		editor.selection = new vscode.Selection(pos, pos);
		await vscode.commands.executeCommand('dataflow.traceVariable');
		await waitFor(() => api.side.isOpen && api.side.flow?.name === 'bestFit', 30000, () => JSON.stringify(api.side.flow?.name ?? null));

		const flow = api.side.flow!;
		assert.deepStrictEqual(flow.findings, [{ line: 46, text: 'optional not checked here' }]);
		const finding = flow.marks.findIndex((m) => m.finding);
		assert.strictEqual(flow.marks[finding].line, 46);
		assert.deepStrictEqual(flow.marks[finding].from.map((i) => flow.marks[i].line), [line]);
		assert.deepStrictEqual(flow.lanes.map((l) => [l.from, l.to]), [[line, 46]]);
		assert.ok(flow.lanes[0].segments.some((s) => s.to === 46 && s.isProblem), JSON.stringify(flow.lanes[0].segments));

	});

	test('A click on a variable in the side view traces it and moves the cursor', async function () {
		this.timeout(30000);
		const line = lineOf('std::vector<StartPlan> startPlans;');
		const col = editor.document.lineAt(line - 1).text.indexOf('startPlans');
		api.side.receive({ type: 'trace', line, col });
		await waitFor(() => api.side.flow?.name === 'startPlans', 15000, () => JSON.stringify(api.side.flow?.name ?? null));
		assert.strictEqual(editor.selection.active.line, line - 1);
		assert.strictEqual(api.side.flow!.counts.mayWrite, 5);
		assert.ok(api.side.flow!.marks.filter((m) => m.role === 'mayWrite').every((m) => m.from.length > 0));
	});

	test('With the cursor on no variable, the trace stays and no line is dimmed', async function () {
		this.timeout(30000);
		// the test before traces startPlans and puts the cursor on its declaration. The line after it is empty
		const line = lineOf('std::vector<StartPlan> startPlans;');
		assert.strictEqual(api.side.flow?.isSelected, true);
		assert.strictEqual(editor.document.lineAt(line).text.trim(), '');
		editor.selection = new vscode.Selection(line, 0, line, 0);
		await waitFor(() => api.side.flow?.isSelected === false, 10000, () => JSON.stringify(api.side.flow?.isSelected ?? null));
		assert.strictEqual(api.side.flow!.name, 'startPlans');

		// on the variable again, the lines with no reference are dimmed again
		const col = editor.document.lineAt(line - 1).text.indexOf('startPlans');
		editor.selection = new vscode.Selection(line - 1, col, line - 1, col);
		await waitFor(() => api.side.flow?.isSelected === true, 10000, () => JSON.stringify(api.side.flow?.isSelected ?? null));
	});

	test('A click on a data member traces it in the source file and in its header, with the thread of each access', async function () {
		this.timeout(60000);
		// charge.is_dirty: solve_power_plan() writes it on line 76. The lambda of executor.async on line 95 calls
		// solve_power_plan(), so the write runs on a different thread. process() reads it on line 94 on the caller thread
		const header = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'include', 'battery', 'types.hpp');
		const declLine = readFileSync(header, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('bool is_dirty')) + 1;
		const line = lineOf('charge.is_dirty = false;');
		api.side.receive({ type: 'trace', line, col: editor.document.lineAt(line - 1).text.indexOf('is_dirty') });
		await waitFor(() => api.side.flow?.member?.qualifiedClass === 'charge::State', 30000, () => JSON.stringify(api.side.flow?.name ?? null));
		const flow = api.side.flow!;
		assert.strictEqual(flow.name, 'is_dirty');
		assert.deepStrictEqual(flow.tags?.map((t) => [t.line, t.kind, path.basename(t.file), t.target]), [[line, 'decl', 'types.hpp', declLine]]);
		assert.deepStrictEqual(flow.member!.verdict && [flow.member!.verdict.kind, flow.member!.verdict.places.map((p) => p.line)], ['race', [76, 94]]);
		const refs = flow.member!.groups.find((g) => g.isShown)!.refs;
		assert.strictEqual(refs.find((r) => r.line === 76)?.thread, 'tf::Executor::async');
		assert.strictEqual(refs.find((r) => r.line === 94)?.thread, undefined);

		// a click on the tag opens the header at the declaration. The side view shows the header, and the trace stays
		// selected, because the cursor is on the declaration
		const tag = flow.tags![0];
		api.side.receive({ type: 'openPlace', file: tag.file, line: tag.target, col: tag.col });
		await waitFor(() => !!api.side.flow && path.basename(api.side.flow.file) === 'types.hpp', 15000, () => JSON.stringify(api.side.flow?.file ?? null));
		const inHeader = api.side.flow!;
		assert.ok(inHeader.marks.some((m) => m.line === declLine && m.role === 'def'), JSON.stringify(inHeader.marks));
		assert.ok(inHeader.tags?.some((t) => t.kind === 'file' && path.basename(t.file) === 'battery.cpp'), JSON.stringify(inHeader.tags));
		await sleep(800);
		assert.strictEqual(api.store.state.trace?.member?.model.member.name, 'is_dirty');
		assert.strictEqual(api.side.flow?.isSelected, true);
		editor = await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
	});

	test('The lens switch of the side view turns Flow Lens off and on', async () => {
		api.side.receive({ type: 'toggleLens', lens: 'flow' });
		await waitFor(() => !api.store.state.lenses.flow && api.side.flow === null, 5000, () => JSON.stringify(api.store.state.lenses));
		api.side.receive({ type: 'toggleLens', lens: 'flow' });
		await waitFor(() => api.store.state.lenses.flow, 5000, () => JSON.stringify(api.store.state.lenses));
	});

	// a file in the build folder of the fixture, with a trace of v. git ignores this folder. Line 4 is longer than the
	// side view
	const openLongLines = async (): Promise<vscode.TextEditor> => {
		const long = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'build', 'side-view-long-line.cpp');
		const sum = Array.from({ length: 40 }, (_, i) => `*v * ${i}`).join(' + ');
		writeFileSync(long, ['#include <optional>', 'int read(std::optional<int> v) {', '  int a = *v;', `  int b = ${sum};`,
			'  return a + b;', '}', ''].join('\n'));
		const longEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(long), vscode.ViewColumn.One);
		await vscode.commands.executeCommand('dataflow.openSideView');
		await waitFor(() => api.side.file === long && api.side.tokenVersion !== undefined, 60000,
			() => `file ${api.side.file}, tokens ${api.side.tokenVersion}`);
		api.side.receive({ type: 'trace', line: 2, col: longEditor.document.lineAt(1).text.indexOf('v)') });
		await waitFor(() => api.side.flow?.name === 'v' && api.side.flow.findings.some((f) => f.line === 4), 30000,
			() => JSON.stringify(api.side.flow?.findings ?? null));
		return longEditor;
	};

	test('On a long line, the hint at the end of the row is a dot, so it does not cover the code', async function () {
		this.timeout(120000);
		await openLongLines();
		assert.deepStrictEqual([...new Set(api.side.flow!.findings.map((f) => f.line))], [3, 4]);
		await waitFor(() => api.side.lastShortEnds.lines.includes(4), 10000, () => JSON.stringify(api.side.lastShortEnds));

		// with no side bar, the side view is wider. Then the full hint of the short line 3 fits after its code
		const narrow = api.side.lastShortEnds.width;
		await vscode.commands.executeCommand('workbench.action.closeSidebar');
		try {
			await waitFor(() => api.side.lastShortEnds.width > narrow, 10000, () => JSON.stringify(api.side.lastShortEnds));
			await waitFor(() => !api.side.lastShortEnds.lines.includes(3), 5000, () => JSON.stringify(api.side.lastShortEnds));
			assert.deepStrictEqual(api.side.lastShortEnds.lines, [4]);
		} finally {
			await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
		}
	});

	test('The command "Show Card at Cursor" shows the card of the reference or of the dot at the cursor', async function () {
		this.timeout(120000);
		const longEditor = await openLongLines();
		await waitFor(() => api.side.lastShortEnds.lines.includes(4), 10000, () => JSON.stringify(api.side.lastShortEnds));
		// a move of the cursor closes the card. The extension gets the move after the new selection
		const showCardAt = async (line: number, col: number, isOnVariable: boolean) => {
			const before = api.side.lastCard;
			const moved = new Promise<void>((resolve) => {
				const listener = vscode.window.onDidChangeTextEditorSelection(() => {
					listener.dispose();
					resolve();
				});
			});
			longEditor.selection = new vscode.Selection(line - 1, col, line - 1, col);
			await moved;
			await waitFor(() => api.side.flow?.isSelected === isOnVariable, 10000, () => JSON.stringify(api.side.flow?.isSelected ?? null));
			await vscode.commands.executeCommand('dataflow.showCard');
			await waitFor(() => api.side.lastCard !== before, 5000, () => JSON.stringify(api.side.lastCard));
			return api.side.lastCard;
		};
		// the cursor on the v of line 3: the card of the reference. At the start of line 4: the card of the dot. Line 5
		// has no card
		assert.deepStrictEqual(await showCardAt(3, longEditor.document.lineAt(2).text.indexOf('v'), true), { kind: 'flow', line: 3 });
		assert.deepStrictEqual(await showCardAt(4, 0, false), { kind: 'ends', line: 4 });
		assert.deepStrictEqual(await showCardAt(5, 0, false), { kind: null, line: 5 });
	});
});


// Phase S3 on the CMake fixture: acceptance scenario 2 with Logic Map in the side view. Logic Map shows one path: each
// decision has the choice of the user or the default option, which runs the most lines. The fixture folder sets
// fire_transition as the event function and get_if as the nullable function.
suite('S3: Logic Map in the side view', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(file(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;

	let api: DataFlowApi;
	// the decision steps of the path. A decision that the path does not get to has no step
	const decisions = () => api.side.logic!.steps.filter((s) => s.kind === 'decision');
	const keyOf = (prefix: string) => {
		const step = decisions().find((s) => s.key!.startsWith(prefix));
		assert.ok(step, `no step for ${prefix} in ${decisions().map((s) => s.key).join(', ')}`);
		return step.key!;
	};
	const choose = (key: string, value: string) => api.side.receive({ type: 'setChoice', key, value });

	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		const pos = new vscode.Position(lineOf('process(tf::Executor') - 1, 4);
		editor.selection = new vscode.Selection(pos, pos);
		if (!api.store.state.lenses.logic) {
			api.side.receive({ type: 'toggleLens', lens: 'logic' });
		}
		await waitFor(() => api.side.isOpen && api.side.logic?.fn.endsWith('process') === true, 60000,
			() => JSON.stringify(api.side.logic?.fn ?? null));
	});

	test('With no choices, the path is one path: past the early return, with an option for each decision', () => {
		api.side.receive({ type: 'resetChoices' });
		const logic = api.side.logic!;
		assert.deepStrictEqual([logic.hasCfg, logic.hasChoices], [true, false]);
		assert.ok(decisions().every((s) => s.options!.includes(s.value!) && s.value !== 'any' && s.isSet === false), JSON.stringify(decisions()));
		// the default option of the check of the tariff_plans is "no": the early return runs fewer lines
		assert.strictEqual(decisions().find((s) => s.key!.startsWith('if:tariff_plans.active.size() == 0'))?.value, 'no');
		assert.ok(!logic.steps.some((s) => s.kind === 'return' && s.line === lineOf('return std::nullopt;')), JSON.stringify(logic.steps));
		// one value of the state machine: the lines of the other states cannot run
		assert.strictEqual(logic.steps.filter((s) => s.key?.startsWith('chain:home_battery_ctl.state')).length, 1);
		assert.ok(logic.dead.length > 20, `${logic.dead.length} dead lines`);
		assert.deepStrictEqual(logic.steps.map((s) => s.line), [...logic.steps.map((s) => s.line)].sort((a, b) => a - b));
		const last = logic.steps.at(-1)!;
		assert.deepStrictEqual([last.kind, last.line, last.text], ['return', lineOf('return requests;'), 'requests']);
	});

	test('Acceptance scenario 2, part 1: METER_READING, new readings and timeout show two events on one path', () => {
		api.side.receive({ type: 'resetChoices' });
		choose(keyOf('chain:home_battery_ctl.state'), 'HOMEPOWER_METER_READING');
		choose(keyOf('if:data.size() > 0'), 'yes');
		choose(keyOf('if:home_battery_ctl.operational_mode == POWER_AUTO && '), 'yes');

		const logic = api.side.logic!;
		assert.deepStrictEqual(logic.events.map((e) => e.label), ['_measured', '_timeout']);
		assert.ok(logic.warnings.some((w) => w.text.startsWith('Two events on one path: _measured') && w.short === 'two events on one path'),
			JSON.stringify(logic.warnings));
		assert.ok(!logic.warnings.some((w) => w.text.includes('can be null')), JSON.stringify(logic.warnings));
		assert.ok(logic.dead.includes(lineOf('"_ended"')));
		assert.ok(logic.dead.includes(lineOf('"_planned"')));
		assert.ok(!logic.dead.includes(lineOf('"_timeout"')));
		assert.ok(logic.hints.some((h) => h.line === lineOf('"_timeout"')), JSON.stringify(logic.hints));

		// the steps: the three choices of the user, the two events with the warning on the second event, and the return
		assert.deepStrictEqual(decisions().filter((s) => s.isSet).map((s) => s.value), ['HOMEPOWER_METER_READING', 'yes', 'yes']);
		const events = logic.steps.filter((s) => s.kind === 'event');
		assert.deepStrictEqual(events.map((s) => [s.text, s.line, !!s.problem]), [
			['_measured', lineOf('"_measured"'), false], ['_timeout', lineOf('"_timeout"'), true],
		]);
		assert.strictEqual(logic.steps.at(-1)?.text, 'requests');
	});

	test('Acceptance scenario 2, part 2: CHARGE_PLANNING, converged and POWER_AUTO show the null pointer on line 109', () => {
		api.side.receive({ type: 'resetChoices' });
		choose(keyOf('chain:home_battery_ctl.state'), 'HOMEPOWER_CHARGE_PLANNING');
		choose(keyOf('if:home_battery_ctl.charging_future'), 'yes');
		choose(keyOf('if:converged'), 'yes');
		choose(keyOf('if:home_battery_ctl.operational_mode == POWER_AUTO#0'), 'yes');

		const deref = lineOf('*cur_tariff_plan)');
		assert.strictEqual(deref, 109);
		const logic = api.side.logic!;
		assert.deepStrictEqual(logic.events.map((e) => e.label), ['_planned']);
		assert.ok(logic.warnings.some((w) => w.text.startsWith(`cur_tariff_plan can be null on line ${deref}`) && w.short === 'cur_tariff_plan can be null'),
			JSON.stringify(logic.warnings));
		assert.deepStrictEqual(logic.problems.map((p) => p.line), [deref]);
		assert.ok(!logic.dead.includes(deref));
		assert.deepStrictEqual(logic.steps.filter((s) => s.kind === 'warning').map((s) => [s.line, s.text]), [[deref, 'cur_tariff_plan can be null']]);
	});

	test('Why a line runs: the answer for a line number, and its choices', () => {
		api.side.receive({ type: 'resetChoices' });
		const line = lineOf('"_timeout"');
		api.side.receive({ type: 'why', line });
		const items = api.side.lastWhy?.items ?? [];
		assert.strictEqual(api.side.lastWhy?.line, line);
		assert.deepStrictEqual(items.map((i) => i.option), ['no', 'HOMEPOWER_METER_READING', 'yes']);

		api.side.receive({ type: 'applyWhy', line });
		const logic = api.side.logic!;
		for (const item of items) {
			assert.strictEqual(decisions().find((s) => s.key === item.key)?.value, item.option, item.text);
		}
		assert.ok(logic.hasChoices);
		assert.ok(!logic.dead.includes(line));
		assert.ok(logic.dead.includes(lineOf('"_ended"')));
	});

	test('The path panel shows why the line of the cursor runs', async function () {
		this.timeout(30000);
		api.side.receive({ type: 'resetChoices' });
		const line = lineOf('"_timeout"');
		api.side.receive({ type: 'select', line, col: 6 });
		await waitFor(() => api.side.logic?.why?.line === line, 15000, () => JSON.stringify(api.side.logic?.why ?? null));
		assert.deepStrictEqual(api.side.logic!.why!.items!.map((i) => i.option), ['no', 'HOMEPOWER_METER_READING', 'yes']);
	});

	test('Logic Map follows the cursor: a line that cannot run gets the choices that make it run', async function () {
		this.timeout(30000);
		api.side.receive({ type: 'resetChoices' });
		const line = lineOf('"_ended"');
		assert.ok(api.side.logic!.dead.includes(line));
		// the cursor goes to the line, as with a click in the side view
		api.side.receive({ type: 'select', line, col: 6 });
		await waitFor(() => !api.side.logic!.dead.includes(line), 10000, () => JSON.stringify(api.side.logic!.steps.map((s) => s.value ?? s.text)));
		assert.strictEqual(decisions().find((s) => s.key!.startsWith('chain:home_battery_ctl.state'))?.value, 'HOMEPOWER_CHARGE_ACTIVE');
		assert.ok(api.side.logic!.hasChoices);

		// a choice of the user stays, also when the line of the cursor cannot run with it
		choose(keyOf('chain:home_battery_ctl.state'), 'HOMEPOWER_METER_READING');
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.ok(api.side.logic!.dead.includes(line));
		assert.strictEqual(decisions().find((s) => s.key!.startsWith('chain:home_battery_ctl.state'))?.value, 'HOMEPOWER_METER_READING');
	});

	test('A lambda has its own logic: the cursor in its body shows the path through the lambda', async function () {
		this.timeout(30000);
		const line = lineOf('executor.async([&]()');
		const col = readFileSync(file(), 'utf8').split(/\r?\n/)[line - 1].indexOf('return solve_power_plan');
		api.side.receive({ type: 'select', line, col });
		await waitFor(() => api.side.logic?.fn.endsWith('::(lambda 1)') === true, 15000, () => JSON.stringify(api.side.logic?.fn ?? null));
		const logic = api.side.logic!;
		assert.ok(logic.fn.endsWith('process::(lambda 1)'), logic.fn);
		assert.deepStrictEqual([logic.first, logic.last], [line, line]);
		assert.deepStrictEqual(logic.steps.map((s) => [s.kind, s.text]), [['return', 'solve_power_plan(charge)']]);

		// the cursor out of the lambda shows the function again
		api.side.receive({ type: 'select', line: lineOf('process(tf::Executor'), col: 4 });
		await waitFor(() => api.side.logic?.fn.endsWith('process') === true, 15000, () => JSON.stringify(api.side.logic?.fn ?? null));
	});

	test('The lens switch of the side view turns Logic Map off', async () => {
		api.side.receive({ type: 'toggleLens', lens: 'logic' });
		await waitFor(() => !api.store.state.lenses.logic && api.side.logic === null, 5000, () => JSON.stringify(api.store.state.lenses));
		assert.strictEqual(api.store.state.logicPath, undefined);
	});
});

// Phase S4 on the CMake fixture: acceptance scenario 3 with Hidden C++ in the side view
suite('S4: Hidden C++ in the side view', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');
	const lines = () => readFileSync(file(), 'utf8').split(/\r?\n/);
	const lineOf = (text: string) => lines().findIndex((l) => l.includes(text)) + 1;

	let api: DataFlowApi;
	const markOf = (line: number, category: string, text: RegExp) =>
		api.side.cost!.marks.find((m) => m.line === line && m.category === category && text.test(m.text));
	const textOf = (m: { line: number; start: number; end: number }) => lines()[m.line - 1].slice(m.start, m.end);

	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		// the state of the test workspace stays between test runs
		await vscode.commands.executeCommand('dataflow.cost.showHidden');
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		const pos = new vscode.Position(lineOf('stable_readings(const MeterFeeds') - 1, 4);
		editor.selection = new vscode.Selection(pos, pos);
		if (!api.store.state.lenses.cost) {
			api.side.receive({ type: 'toggleLens', lens: 'cost' });
		}
		await waitFor(() => api.side.isOpen && api.side.cost?.fn === 'stable_readings', 60000, () => JSON.stringify(api.side.cost?.fn ?? null));
	});

	test('Acceptance scenario 3: the static map, the copy of GridStatus, the lookups of one key and the shadowed taps', () => {
		const state = markOf(lineOf('static std::map'), 'state', /^static/);
		assert.ok(state, JSON.stringify(api.side.cost!.marks));
		assert.strictEqual(textOf(state), 'last_read');
		const copy = markOf(lineOf('MeterRead{state'), 'copy', /GridStatus/);
		assert.ok(copy);
		assert.strictEqual(textOf(copy), 'state');

		// the lookups of tapTopic: the first lookup has the item, and the 6 other lookups are its group. A path through
		// the branches has a maximum of 5 lookups
		const lookup = api.side.cost!.marks.find((m) => m.category === 'lookup')!;
		assert.match(lookup.text, /^5 lookups of tapTopic in last_read/);
		assert.match(lookup.detail, /5 times on one path: contains 1, \[\] 4\. The group has 7 lookups in different branches\./);
		assert.strictEqual(lookup.line, lineOf('last_read.contains(tapTopic)'));
		assert.strictEqual(lookup.related.length, 6);
		assert.strictEqual(lookup.related.at(-1)!.line, lineOf('data.push_back(last_read[tapTopic])'));

		assert.ok(markOf(lineOf('const auto &taps = stream.history'), 'lifetime', /^hides taps of line/));

		// the details column: the items of the function at the cursor. The bar: the counts of the file
		const cost = api.side.cost!;
		const categories = new Set(cost.items.map((i) => i.category));
		assert.ok(['state', 'lifetime', 'allocation', 'copy', 'lookup', 'destructor'].every((c) => categories.has(c)), [...categories].join(', '));
		assert.ok(cost.categories.find((c) => c.id === 'copy')!.count >= cost.items.filter((i) => i.category === 'copy').length);
	});

	test('The command "Show Card at Cursor" shows the card of the items of Hidden C++ on the line of the cursor', async function () {
		this.timeout(30000);
		// at the start of the line, the cursor is on no reference of Flow Lens
		const line = lineOf('MeterRead{state');
		const editor = vscode.window.activeTextEditor!;
		const before = api.side.lastCard;
		const moved = new Promise<void>((resolve) => {
			const listener = vscode.window.onDidChangeTextEditorSelection(() => {
				listener.dispose();
				resolve();
			});
		});
		editor.selection = new vscode.Selection(line - 1, 0, line - 1, 0);
		await moved;
		await vscode.commands.executeCommand('dataflow.showCard');
		await waitFor(() => api.side.lastCard !== before, 5000, () => JSON.stringify(api.side.lastCard));
		assert.deepStrictEqual(api.side.lastCard, { kind: 'cost', line });
	});

	test('"Not useful" in the side view hides a pattern, and "Show them again" shows it', async () => {
		api.side.receive({ type: 'notUseful', pattern: 'copy|GridStatus' });
		await waitFor(() => !api.side.cost!.marks.some((m) => /GridStatus/.test(m.text)) && api.side.cost!.hidden === 1, 5000,
			() => JSON.stringify(api.side.cost!.hidden));
		api.side.receive({ type: 'showHidden' });
		await waitFor(() => api.side.cost!.marks.some((m) => /GridStatus/.test(m.text)) && api.side.cost!.hidden === 0, 5000,
			() => JSON.stringify(api.side.cost!.hidden));
	});

	test('A category switch of the side view hides the items of the category, and its count stays', async function () {
		this.timeout(30000);
		api.side.receive({ type: 'setCostCategory', id: 'destructor', enabled: false });
		try {
			await waitFor(() => !api.side.cost!.marks.some((m) => m.category === 'destructor'), 5000, () => JSON.stringify(api.side.cost!.categories));
			const destructors = api.side.cost!.categories.find((c) => c.id === 'destructor')!;
			assert.deepStrictEqual([destructors.enabled, destructors.count > 0], [false, true]);
		} finally {
			await vscode.workspace.getConfiguration('dataflow.cost').update('categories', undefined, vscode.ConfigurationTarget.Global);
		}
		await waitFor(() => api.side.cost!.marks.some((m) => m.category === 'destructor'), 5000, () => JSON.stringify(api.side.cost!.categories));
	});

	test('The lens switch of the side view turns Hidden C++ off', async () => {
		api.side.receive({ type: 'toggleLens', lens: 'cost' });
		await waitFor(() => !api.store.state.lenses.cost && api.side.cost === null, 5000, () => JSON.stringify(api.store.state.lenses));
		assert.strictEqual(api.store.state.costLayer, undefined);
	});
});

// Include Hierarchy on the CMake fixture: the hints on the include lines of battery.cpp, the project header and the
// standard library in their groups, and the lens switch
suite('Include Hierarchy in the side view', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(file(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;

	let api: DataFlowApi;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		if (!api.store.state.lenses.includes) {
			api.side.receive({ type: 'toggleLens', lens: 'includes' });
		}
		await vscode.commands.executeCommand('dataflow.openSideView');
		await waitFor(() => api.side.includes?.name === 'battery.cpp', 60000, () => JSON.stringify(api.side.includes?.stats ?? null));
	});

	test('The include lines get the lines that each include adds, and the tree has the groups of the files', () => {
		const includes = api.side.includes!;
		const typesLine = lineOf('#include <battery/types.hpp>');
		const hints = includes.hints.filter((h) => h.line === typesLine);
		assert.strictEqual(hints.length, 1, JSON.stringify(includes.hints));
		assert.match(hints[0].text, /^\+[\d.]+k? lines$/);

		const types = includes.nodes.find((n) => n.parent === 0 && n.name === '<battery/types.hpp>')!;
		assert.deepStrictEqual([types.line, types.state, types.group, types.isUsed], [typesLine, 'entered', 'project headers', true]);
		assert.ok(types.children.some((c) => includes.nodes[c].name === '<map>'), JSON.stringify(types.children.map((c) => includes.nodes[c].name)));
		const algorithm = includes.nodes.find((n) => n.parent === 0 && n.name === '<algorithm>')!;
		assert.strictEqual(algorithm.group, 'C++ standard library');
		assert.strictEqual(includes.stats.includes, 4);
		assert.ok(includes.stats.total > includes.stats.lines * 10, JSON.stringify(includes.stats));
		assert.ok(includes.groups.some((g) => g.name === 'project headers') && includes.groups.some((g) => g.name === 'this file'));
	});

	test('Included by gives the translation units of the compile database that include the selected header', async function () {
		this.timeout(60000);
		const types = api.side.includes!.nodes.find((n) => n.parent === 0 && n.name === '<battery/types.hpp>')!;
		api.side.receive({ type: 'includersShown', file: types.path });
		await waitFor(() => api.side.includers?.file === types.path && api.side.includers.state === 'ready', 30000,
			() => JSON.stringify(api.side.includers));
		const includers = api.side.includers!;
		assert.deepStrictEqual(includers.units.map((u) => u.name), ['src/battery.cpp']);
		assert.deepStrictEqual([includers.isUnit, includers.failed], [false, 0]);
		assert.ok(includers.unitCount >= 3, JSON.stringify(includers));
	});

	test('The lens switch of the side view turns Include Hierarchy off and on', async function () {
		this.timeout(30000);
		api.side.receive({ type: 'toggleLens', lens: 'includes' });
		await waitFor(() => !api.store.state.lenses.includes && api.side.includes === null, 5000, () => JSON.stringify(api.store.state.lenses));
		api.side.receive({ type: 'toggleLens', lens: 'includes' });
		await waitFor(() => api.side.includes?.name === 'battery.cpp', 30000, () => JSON.stringify(api.store.state.lenses));
	});
});

// Call Hierarchy on the CMake fixture: the links of process() with their data, the hints on its calls, and the hint of
// the optional of best_preset() when the cursor goes into initial_power(). The file also calls charge::initial_power(),
// so both functions get their namespaces
suite('Call Hierarchy in the side view', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(file(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;

	let api: DataFlowApi;
	let editor: vscode.TextEditor;
	const focusName = () => api.side.calls?.functions[api.side.calls.focus]?.label;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		if (!api.store.state.lenses.calls) {
			api.side.receive({ type: 'toggleLens', lens: 'calls' });
		}
		await vscode.commands.executeCommand('dataflow.openSideView');
		const line = lineOf('fire_transition(home_battery_ctl, "", true);');
		editor.selection = new vscode.Selection(line - 1, 2, line - 1, 2);
		await waitFor(() => focusName() === 'process()', 60000, () => JSON.stringify(focusName() ?? null));
	});

	test('The links of process() have the data of the calls, and its calls get hints', () => {
		const calls = api.side.calls!;
		const edge = (label: string) => calls.edges.find((e) => e.from === calls.focus && calls.functions[e.to].label === label)!;
		const events = edge('fire_transition()');
		assert.deepStrictEqual([events.kind, events.short, events.sites.length], ['event', 'event ×10', 10]);
		const solve = edge('solve_power_plan()');
		assert.deepStrictEqual([solve.kind, solve.sites.map((s) => s.line)], ['async', [lineOf('executor.async([&]()')]]);
		assert.ok(calls.hints.some((h) => h.line === lineOf('executor.async([&]()') && h.kind === 'async'), JSON.stringify(calls.hints));
		assert.strictEqual(calls.hints.filter((h) => h.kind === 'event').length, 10);
		assert.strictEqual(calls.functions[events.to].where, 'project');
	});

	test('In initial_power(), the optional of best_preset() has a hint: not checked on line 46', async function () {
		this.timeout(30000);
		const line = lineOf('auto bestFit = best_preset(');
		editor.selection = new vscode.Selection(line - 1, 4, line - 1, 4);
		await waitFor(() => focusName() === 'power_ctrl::initial_power()', 15000, () => JSON.stringify(focusName() ?? null));
		const hint = api.side.calls!.hints.find((h) => h.line === line)!;
		assert.deepStrictEqual([hint.kind, hint.text], ['warn', 'best_preset() · optional not checked on line 46']);
	});

	test('The lens switch of the side view turns Call Hierarchy off and on', async function () {
		this.timeout(30000);
		api.side.receive({ type: 'toggleLens', lens: 'calls' });
		await waitFor(() => !api.store.state.lenses.calls && api.side.calls === null, 5000, () => JSON.stringify(api.store.state.lenses));
		api.side.receive({ type: 'toggleLens', lens: 'calls' });
		await waitFor(() => focusName() === 'power_ctrl::initial_power()', 30000, () => JSON.stringify(focusName() ?? null));
	});

	test('A function with its body in a different source file has a button that finds the definition', async function () {
		this.timeout(60000);
		const decl = api.side.calls!.functions.find((f) => f.label.endsWith('fire_transition()'))!;
		assert.deepStrictEqual([decl?.where, decl?.isDefined], ['project', false], JSON.stringify(api.side.calls!.functions.map((f) => f.label)));
		// the test build has no C/C++ extension, so a provider of the test gives the definition
		const target = path.join(path.dirname(file()), 'main.cpp');
		const provider = vscode.languages.registerDefinitionProvider({ language: 'cpp' }, {
			provideDefinition: () => new vscode.Location(vscode.Uri.file(target), new vscode.Position(0, 0)),
		});
		const key = (f: string) => path.normalize(f).toLowerCase();
		try {
			api.side.receive({ type: 'openDefinition', file: decl.file, line: decl.line, col: decl.col });
			await waitFor(() => key(api.side.file ?? '') === key(target), 30000, () => `${api.side.file}`);
		} finally {
			provider.dispose();
			editor = await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
			await waitFor(() => !!api.side.calls && key(api.side.calls.file) === key(file()), 30000, () => `${api.side.calls?.file}`);
			// the webview tells if the tab Calls shows after it gets the calls of the file. The next tests set this state
			await sleep(1000);
		}
	});

	test('A function of a header has a button that opens its file, and that file shows all of its calls', async function () {
		this.timeout(60000);
		const header = api.side.calls!.functions.find((f) => f.label.endsWith('isValidKw()'))!;
		assert.deepStrictEqual([header?.where, header?.isDefined], ['project', true], JSON.stringify(api.side.calls!.functions.map((f) => f.label)));
		api.side.receive({ type: 'callFocus', fn: header.id });
		// the button of the details column opens the file at the name of the function
		api.side.receive({ type: 'openPlace', file: header.file, line: header.line, col: header.col });
		const key = (f: string) => path.normalize(f).toLowerCase();
		try {
			await waitFor(() => !!api.side.calls && key(api.side.calls.file) === key(header.file) && !!focusName()?.endsWith('isValidKw()'), 60000,
				() => `${api.side.calls?.file}: ${focusName()}`);
			assert.strictEqual(api.side.calls!.functions[api.side.calls!.focus].where, 'main');
		} finally {
			editor = await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
			await waitFor(() => !!api.side.calls && key(api.side.calls.file) === key(file()), 30000, () => `${api.side.calls?.file}`);
		}
	});

	test('Show Calls lists the calls of a function, also in other files, and a click on a call shows it', async function () {
		this.timeout(60000);
		// a provider for C++ in place of the C/C++ extension: main() in main.cpp calls the function on line 10
		const main = vscode.Uri.file(path.join(path.dirname(file()), 'main.cpp'));
		const name = (line: number) => new vscode.Range(line - 1, 4, line - 1, 8);
		const provider = vscode.languages.registerCallHierarchyProvider({ language: 'cpp' }, {
			prepareCallHierarchy: (doc, pos) =>
				new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'f', '', doc.uri, doc.lineAt(pos.line).range, new vscode.Range(pos, pos)),
			provideCallHierarchyIncomingCalls: () =>
				[new vscode.CallHierarchyIncomingCall(new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'main', '', main, name(4), name(4)), [name(10)])],
			provideCallHierarchyOutgoingCalls: () => [],
		});
		const key = (f: string) => path.normalize(f).toLowerCase();
		const cursorLine = () => vscode.window.visibleTextEditors.find((e) => e.document === editor.document)?.selection.active.line;
		try {
			// the menu of the side view on the name fire_transition in process() gives the place of the click
			const line = lineOf('fire_transition(home_battery_ctl, "", true);');
			const col = editor.document.lineAt(line - 1).text.indexOf('fire_transition') + 3;
			await vscode.commands.executeCommand('dataflow.showCalls', { webview: 'dataflow.sideView', dataflowCallable: true, line, col });
			await waitFor(() => api.side.lastCallList?.isSearching === false, 30000, () => JSON.stringify(api.side.lastCallList));
			const list = api.side.lastCallList!;
			assert.deepStrictEqual([list.fn, list.isFromMenu], ['fire_transition()', true]);
			const here = list.sites.filter((s) => key(s.file) === key(file()));
			assert.strictEqual(here.filter((s) => s.caller === 'process()').length, 10, JSON.stringify(here));
			assert.ok(here.every((s) => s.text.includes('fire_transition(')), JSON.stringify(here));
			// the calls in other files come after the calls in this file
			assert.deepStrictEqual(list.sites.slice(here.length).map((s) => [path.basename(s.file), s.line, s.caller]), [['main.cpp', 10, 'main()']]);

			// a click on a call shows it in the text editor
			const site = here[here.length - 1];
			api.side.receive({ type: 'openPlace', file: site.file, line: site.line, col: site.col });
			await waitFor(() => cursorLine() === site.line - 1, 10000, () => `${cursorLine()}`);

			// with no menu: the name at the cursor of the editor
			const best = lineOf('auto bestFit = best_preset(');
			const at = editor.document.lineAt(best - 1).text.indexOf('best_preset') + 2;
			const shown = vscode.window.visibleTextEditors.find((e) => e.document === editor.document)!;
			shown.selection = new vscode.Selection(best - 1, at, best - 1, at);
			await vscode.commands.executeCommand('dataflow.showCalls');
			await waitFor(() => api.side.lastCallList?.fn === 'best_preset()' && !api.side.lastCallList.isSearching, 30000,
				() => JSON.stringify(api.side.lastCallList));
			assert.strictEqual(api.side.lastCallList!.isFromMenu, false);
			assert.ok(api.side.lastCallList!.sites.some((s) => s.line === best && s.caller === 'power_ctrl::initial_power()'), JSON.stringify(api.side.lastCallList));
		} finally {
			provider.dispose();
		}
	});

	// A request can stop the language server of the C/C++ extension, so DataFlow asks for the callers in other files only
	// while the tab Calls or the graph shows
	test('Call Hierarchy asks VS Code for the callers in other files only when the tab Calls or the graph shows', async function () {
		this.timeout(60000);
		let requests = 0;
		const provider = vscode.languages.registerCallHierarchyProvider({ language: 'cpp' }, {
			prepareCallHierarchy: () => {
				requests++;
				return [];
			},
			provideCallHierarchyIncomingCalls: () => [],
			provideCallHierarchyOutgoingCalls: () => [],
		});
		try {
			// the next test needs solve_power_plan() with no callers from VS Code, so this test uses stable_readings()
			api.side.receive({ type: 'callsShown', isShown: false });
			const line = lineOf('std::vector<MeterRead> stable_readings(');
			editor.selection = new vscode.Selection(line, 2, line, 2);
			await waitFor(() => !!focusName()?.endsWith('stable_readings()'), 15000, () => JSON.stringify(focusName() ?? null));
			await sleep(2000);
			assert.strictEqual(requests, 0);

			// the tab shows: the callers of the function at the cursor come
			api.side.receive({ type: 'callsShown', isShown: true });
			await waitFor(() => requests === 1, 15000, () => `${requests} requests, focus ${focusName()}`);
		} finally {
			provider.dispose();
		}
	});

	// cpptools 1.34.4 stops with an access violation on a request for some code. VS Code restarts a language server
	// only 5 times in 3 minutes, so DataFlow must not ask again. This test must be the last test of the window that uses
	// the call hierarchy, because DataFlow does not ask again in this window.
	test('After a failure of the call hierarchy provider, DataFlow does not ask again, and the details tell why', async function () {
		this.timeout(60000);
		let requests = 0;
		const provider = vscode.languages.registerCallHierarchyProvider({ language: 'cpp' }, {
			prepareCallHierarchy: () => {
				requests++;
				throw new Error('Pending response rejected since connection got disposed');
			},
			provideCallHierarchyIncomingCalls: () => [],
			provideCallHierarchyOutgoingCalls: () => [],
		});
		try {
			const fn = (label: string) => api.side.calls!.functions.findIndex((f) => f.label === label && f.where === 'main');
			api.side.receive({ type: 'callFocus', fn: fn('solve_power_plan()') });
			await waitFor(() => !!api.side.calls?.notice, 15000, () => JSON.stringify(api.side.calls?.notice ?? null));
			assert.ok(api.side.calls!.notice!.startsWith('The call hierarchy of the C/C++ extension stopped with an error'), api.side.calls!.notice);
			assert.strictEqual(requests, 1);
			// a different function, and the retry after a failure, do not ask again
			api.side.receive({ type: 'callFocus', fn: fn('best_preset()') });
			await sleep(3000);
			assert.strictEqual(requests, 1);
		} finally {
			provider.dispose();
		}
	});
});

// Flow Lens for a data member, phase 2: the search finds the other source file of WorkerPool, and a parse adds its
// access to the trace
suite('Flow Lens for a data member in the other source files of its class', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const source = () => path.join(root(), 'src', 'worker_pool.cpp');
	const state = () => path.join(root(), 'src', 'worker_pool_state.cpp');
	const lineOf = (file: string, text: string) => readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;

	let api: DataFlowApi;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(source());
		if (!api.store.state.lenses.flow) {
			api.side.receive({ type: 'toggleLens', lens: 'flow' });
		}
		await vscode.commands.executeCommand('dataflow.openSideView');
	});

	test('The search finds worker_pool_state.cpp, and a parse adds its access to the trace and to the race check', async function () {
		this.timeout(90000);
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source()), vscode.ViewColumn.One);
		const line = lineOf(source(), 'isStopping_ = true;');
		await waitFor(() => api.side.file === source(), 30000, () => String(api.side.file));
		api.side.receive({ type: 'trace', line, col: editor.document.lineAt(line - 1).text.indexOf('isStopping_') });
		const member = () => api.side.flow?.member;
		const fileState = (file: string) => member()?.files.find((f) => path.basename(f.file) === path.basename(file))?.state;
		await waitFor(() => member()?.search === 'done' && fileState(state()) === 'found', 60000, () => JSON.stringify(member()?.files ?? null));
		assert.strictEqual(fileState(source()), 'trace');
		assert.ok(member()!.files.every((f) => !f.name.endsWith('battery.cpp') && !f.name.endsWith('main.cpp')), JSON.stringify(member()!.files));

		api.side.receive({ type: 'parseMemberFile', file: state() });
		await waitFor(() => fileState(state()) === 'trace', 60000, () => JSON.stringify(member()?.files ?? null));
		const group = member()!.groups.find((g) => g.name === 'worker_pool_state.cpp')!;
		assert.deepStrictEqual(group.refs.map((r) => [r.line, r.fn, r.role, r.locks]),
			[[lineOf(state(), 'return isStopping_;'), 'is_stopping()', 'read', ['mutex_']]]);
		assert.strictEqual(member()!.summary.files, 3);
		assert.deepStrictEqual(member()!.verdict && [member()!.verdict!.kind, member()!.verdict!.text],
			['safe', 'Each access holds mutex_, so the threads do not race on isStopping_.']);
	});

	test('An edit of the header of the class parses the unit again, and the line of the declaration moves', async function () {
		this.timeout(90000);
		const header = path.join(root(), 'include', 'battery', 'worker_pool.hpp');
		const declLine = lineOf(header, 'bool isStopping_');
		const doc = await vscode.workspace.openTextDocument(header);
		const member = () => api.side.flow?.member;
		assert.strictEqual(member()?.decl.line, declLine);
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.insert(doc.uri, new vscode.Position(0, 0), '// a line from the test\n');
			assert.ok(await vscode.workspace.applyEdit(edit));
			await waitFor(() => member()?.decl.line === declLine + 1, 60000, () => JSON.stringify(member()?.decl ?? null));
			assert.strictEqual(api.store.state.trace?.member?.model.member.name, 'isStopping_');
		} finally {
			// the file on disk did not change. The edit goes away with the text of the editor
			await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		}
	});
});

// Threads and races: the thread of executor.async in process(), the data that it shares with the caller thread, and the
// order of get()
suite('Threads and races in the side view', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(file(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;

	let api: DataFlowApi;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		if (!api.store.state.lenses.threads) {
			api.side.receive({ type: 'toggleLens', lens: 'threads' });
		}
		await vscode.commands.executeCommand('dataflow.openSideView');
		await waitFor(() => (api.side.threads?.items.length ?? 0) > 0, 60000, () => JSON.stringify(api.side.threads ?? null));
	});

	test('charge.is_dirty is a race with a possible fix, charge.optimizers is a check, and last_read is safe now', () => {
		const threads = api.side.threads!;
		const start = lineOf('executor.async([&]()');
		assert.deepStrictEqual(threads.threads.map((t) => [t.via, t.line, t.handle, t.joins.map((j) => [j.kind, j.line])]),
			[['tf::Executor::async', start, 'home_battery_ctl.charging_future', [['get', lineOf('charging_future->get()')]]]]);
		const byLabel = (label: string) => threads.items.find((i) => i.label === label)!;
		assert.deepStrictEqual(threads.items.map((i) => [i.label, i.pill]), [
			['charge.is_dirty', 'Race'],
			['charge.optimizers', 'Check'],
			['charge, captured by [&]', 'Check'],
			['last_read', 'Safe now'],
		]);
		const read = lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)');
		const is_dirty = byLabel('charge.is_dirty');
		assert.deepStrictEqual(is_dirty.fix && [is_dirty.fix.line, is_dirty.fix.after], [read, '!home_battery_ctl.charging_future && charge.is_dirty']);
		assert.ok(is_dirty.marks.some((m) => m.line === read && m.pair === 'race' && m.lane === 'caller'), JSON.stringify(is_dirty.marks));
		assert.ok(byLabel('charge.optimizers').summary.includes('home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE'), byLabel('charge.optimizers').summary);

		// solve_power_plan() runs on the worker thread. The start and the join have tags
		const solve = lineOf('std::optional<double> solve_power_plan(');
		assert.ok(threads.lanes.some((l) => l.first === solve && !l.isCaller), JSON.stringify(threads.lanes));
		assert.deepStrictEqual(threads.tags.map((t) => [t.line, t.kind]), [[start, 'start'], [lineOf('charging_future->get()'), 'join']]);
	});

	test('The swap of the two conditions removes the race: the read then runs only when the handle is empty', async function () {
		this.timeout(60000);
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		const line = lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)');
		try {
			await editor.edit((edit) => edit.replace(editor.document.lineAt(line - 1).range, '  if (!home_battery_ctl.charging_future && charge.is_dirty) {'));
			await waitFor(() => api.side.threads?.items.find((i) => i.label === 'charge.is_dirty')?.verdict === 'check', 30000,
				() => JSON.stringify(api.side.threads?.items.map((i) => [i.label, i.pill]) ?? null));
		} finally {
			await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
		await waitFor(() => api.side.threads?.items.find((i) => i.label === 'charge.is_dirty')?.verdict === 'race', 30000,
			() => JSON.stringify(api.side.threads?.items.map((i) => [i.label, i.pill]) ?? null));
	});

	test('The lens switch of the side view turns Threads and races off and on', async function () {
		this.timeout(60000);
		api.side.receive({ type: 'toggleLens', lens: 'threads' });
		await waitFor(() => !api.store.state.lenses.threads && api.side.threads === null, 5000, () => JSON.stringify(api.store.state.lenses));
		api.side.receive({ type: 'toggleLens', lens: 'threads' });
		await waitFor(() => (api.side.threads?.items.length ?? 0) > 0, 30000, () => JSON.stringify(api.side.threads ?? null));
	});
});

// Claude Code, or a different webview, in front of the C++ editor: the side view is the only view of the code. It has its
// own cursor, the lenses follow it, and its places and the view tools of the model do not open the text editor
suite('The side view with no text editor', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const file = () => path.join(root(), 'src', 'battery.cpp');
	const header = () => path.join(root(), 'include', 'battery', 'types.hpp');
	const textOf = (f: string) => readFileSync(f, 'utf8').split(/\r?\n/);
	const lineOf = (text: string) => textOf(file()).findIndex((l) => l.includes(text)) + 1;
	const colOf = (line: number, name: string) => textOf(file())[line - 1].indexOf(name);
	const key = (f: string) => path.normalize(f).toLowerCase();
	const codeEditors = () => vscode.window.visibleTextEditors.filter((e) => e.document.languageId === 'cpp').map((e) => e.document.uri.fsPath);

	let api: DataFlowApi;
	let cover: vscode.WebviewPanel | undefined;
	const focusName = () => api.side.calls?.functions[api.side.calls.focus]?.label;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		for (const lens of ['flow', 'calls'] as const) {
			if (!api.store.state.lenses[lens]) {
				api.side.receive({ type: 'toggleLens', lens });
			}
		}
		await vscode.commands.executeCommand('dataflow.openSideView');
		const line = lineOf('fire_transition(home_battery_ctl, "", true);');
		editor.selection = new vscode.Selection(line - 1, 2, line - 1, 2);
		await waitFor(() => focusName() === 'process()', 60000, () => JSON.stringify(focusName() ?? null));
		// a webview in the group of the editor, as the panel of Claude Code. The C++ editor goes behind it
		cover = vscode.window.createWebviewPanel('dataflow.test.cover', 'Claude Code', vscode.ViewColumn.One);
		await waitFor(() => codeEditors().length === 0, 10000, () => codeEditors().join(', '));
	});

	suiteTeardown(async () => {
		cover?.dispose();
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
	});

	test('The side view keeps the cursor of the hidden editor, and a click in the side view moves the cursor of the lenses', async function () {
		this.timeout(60000);
		assert.strictEqual(api.side.cursorPlace?.pos.line, lineOf('fire_transition(home_battery_ctl, "", true);') - 1);
		const line = lineOf('auto bestFit = best_preset(');
		api.side.receive({ type: 'select', line, col: 4 });
		assert.strictEqual(api.side.cursorPlace?.pos.line, line - 1);
		await waitFor(() => focusName() === 'power_ctrl::initial_power()', 30000, () => JSON.stringify(focusName() ?? null));
		assert.strictEqual(api.store.state.fn?.name, 'initial_power');
		assert.deepStrictEqual(codeEditors(), []);
	});

	test('Flow Lens traces a click on a variable, and it follows the cursor of the side view', async function () {
		this.timeout(60000);
		const line = lineOf('std::vector<StartPlan> startPlans;');
		api.side.receive({ type: 'trace', line, col: colOf(line, 'startPlans') });
		await waitFor(() => api.side.flow?.name === 'startPlans', 15000, () => JSON.stringify(api.side.flow?.name ?? null));
		// a click with no trace: Flow Lens follows the cursor, as in the text editor
		const next = lineOf('auto bestFit = best_preset(');
		api.side.receive({ type: 'select', line: next, col: colOf(next, 'bestFit') });
		await waitFor(() => api.side.flow?.name === 'bestFit', 15000, () => JSON.stringify(api.side.flow?.name ?? null));
		assert.deepStrictEqual(codeEditors(), []);
	});

	test('A place of a list shows in the side view only, also in a different file', async function () {
		this.timeout(60000);
		const declLine = textOf(header()).findIndex((l) => l.includes('bool is_dirty')) + 1;
		api.side.receive({ type: 'openPlace', file: header(), line: declLine, col: 2 });
		await waitFor(() => key(api.side.file ?? '') === key(header()), 15000, () => `${api.side.file}`);
		assert.strictEqual(api.side.cursorPlace?.pos.line, declLine - 1);
		assert.deepStrictEqual(codeEditors(), []);

		const line = lineOf('auto bestFit = best_preset(');
		api.side.receive({ type: 'openPlace', file: file(), line, col: 4 });
		await waitFor(() => key(api.side.file ?? '') === key(file()), 15000, () => `${api.side.file}`);
		assert.strictEqual(api.side.cursorPlace?.pos.line, line - 1);
		await waitFor(() => focusName() === 'power_ctrl::initial_power()', 30000, () => JSON.stringify(focusName() ?? null));
		assert.deepStrictEqual(codeEditors(), []);
	});

	test('The MCP tools get the cursor of the side view, and a view tool moves only the side view', async function () {
		this.timeout(60000);
		const line = lineOf('auto bestFit = best_preset(');
		api.side.receive({ type: 'select', line, col: 4 });
		const view = await api.mcpHost.view() as { file: string | null; cursor: { line: number; col: number } | null };
		assert.strictEqual(key(view.file ?? ''), key(file()));
		assert.deepStrictEqual(view.cursor, { line, col: 5 });

		const target = lineOf('fire_transition(home_battery_ctl, "", true);');
		try {
			await api.mcpHost.highlight(undefined, [{ lines: [target, target], note: 'A note of the test.' }]);
			assert.strictEqual(api.side.cursorPlace?.pos.line, target - 1);
			assert.deepStrictEqual(codeEditors(), []);
			await waitFor(() => focusName() === 'process()', 30000, () => JSON.stringify(focusName() ?? null));
		} finally {
			api.mcpHost.removeLayer(file());
		}
	});

	test('A selection in the side view goes to get_view, and add_detail with no line takes it', async function () {
		this.timeout(30000);
		const line = lineOf('auto bestFit = best_preset(');
		const col = colOf(line, 'best_preset');
		api.side.receive({ type: 'selectRange', line, col, endLine: line, endCol: col + 'best_preset'.length });
		assert.strictEqual(api.side.selectionPlace?.range.start.character, col);
		const view = await api.mcpHost.view() as { selection: { text: string; start: { line: number; col: number } } | null };
		assert.deepStrictEqual([view.selection?.text, view.selection?.start], ['best_preset', { line, col: col + 1 }]);
		try {
			const res = await api.mcpHost.detail(undefined, { text: 'Gives the best preset, or no value.' }) as { code: string };
			assert.strictEqual(res.code, 'best_preset');
			assert.deepStrictEqual(codeEditors(), []);
		} finally {
			api.mcpHost.removeLayer(file());
		}
		// a click removes the selection
		api.side.receive({ type: 'select', line, col: 4 });
		assert.strictEqual(api.side.selectionPlace, undefined);
	});

	test('The button of the file name opens the text editor at the cursor of the side view', async function () {
		this.timeout(30000);
		const line = lineOf('auto bestFit = best_preset(');
		api.side.receive({ type: 'select', line, col: 4 });
		api.side.receive({ type: 'openEditor' });
		const active = () => vscode.window.activeTextEditor;
		await waitFor(() => key(active()?.document.uri.fsPath ?? '') === key(file()) && active()?.selection.active.line === line - 1, 10000,
			() => `${active()?.document.uri.fsPath}:${(active()?.selection.active.line ?? -2) + 1}`);
		// with the text editor on the screen, the cursor of the editor counts again
		assert.strictEqual(api.side.cursorPlace, undefined);
	});
});
