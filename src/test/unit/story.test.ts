import * as assert from 'assert';
import type { EngineFunction, SliceConfidence, SliceExitKind, SliceStep, SliceStepKind } from '../../engine/client';
import { diffHunks } from '../../review/git';
import type { ReviewState } from '../../lenses/ripple';
import { RippleModel } from '../../review/ripple';
import { LEXICAL_KEYS, lexSpans, pairedSpans, semanticStyleIndex, SEMANTIC_TYPES } from '../../side/model';
import type { SideRow } from '../../side/protocol';
import { buildSideRipple, buildSideStory, lastName, lineRanges, storyLines, treeOrder } from '../../side/storyLayer';
import type { RippleLayerState } from '../../state/store';

const fn = (name: string, line: number, end: number): EngineFunction => ({
	name, qualifiedName: `ns::${name}`, kind: 'function',
	range: { begin: { line, col: 1 }, end: { line: end, col: 1 } }, nameAt: { line, col: 6 },
});
const step = (line: number, distance: number, kind: SliceStepKind, confidence: SliceConfidence, from: number, via: string): SliceStep =>
	({ line, col: 3, len: 4, lines: [line], kind, confidence, distance, from, via, text: `line ${line}` });
const exit = (kind: SliceExitKind, line: number, stepIndex: number, text: string, followed = false) =>
	({ kind, line, col: 3, len: 4, text, step: stepIndex, followed });
const lexical = (key: string) => LEXICAL_KEYS.indexOf(key as never);
const variable = semanticStyleIndex(SEMANTIC_TYPES.indexOf('variable'), 0);

// The ripple of acceptance scenario 4 in the fixture: solve() changes on line 69 and returns on line 77. A lambda in
// process() calls solve() on line 95 in an async call, and process() reads the result through a field.
const file = 'src/battery.cpp';
const call = { file, line: 95, col: 70 };
function layer(): RippleLayerState {
	const model: RippleModel = {
		changes: [{
			file, fn: fn('solve', 59, 79), lines: [69], bodies: [
				{
					file, depth: 0, offset: 0, body: {
						function: fn('solve', 59, 79), seedLines: [69],
						steps: [step(69, 0, 'seed', 'exact', -1, 'cost < 1e-4'), step(70, 1, 'control', 'exact', 0, 'cost < 1e-4'),
							step(77, 2, 'data', 'exact', 1, 'res')],
						exits: [exit('return', 77, 2, 'return res')], callers: [{ line: 95, col: 70, function: 'ns::process' }],
					},
				},
				{
					file, depth: 1, offset: 3, from: 0, call, body: {
						function: fn('process', 84, 170), lambda: { line: 95, col: 55 }, seedLines: [],
						steps: [step(95, 0, 'seed', 'call', -1, 'solve')], exits: [exit('return', 95, 0, 'return of the lambda', true)],
					},
				},
				{
					file, depth: 1, offset: 3, from: 0, call, body: {
						function: fn('process', 84, 170), seedLines: [],
						steps: [step(95, 1, 'async', 'estimated', -1, 'tf::Executor::async'),
							step(102, 2, 'data', 'estimated', 0, 'home_battery_ctl.charging_future'),
							step(104, 3, 'control', 'estimated', 1, 'converged'), step(105, 3, 'control', 'estimated', 1, 'converged'),
							step(109, 3, 'control', 'estimated', 1, 'converged'), step(169, 4, 'data', 'estimated', 3, 'requests')],
						exits: [exit('async', 95, 0, 'tf::Executor::async', true), exit('member', 95, 0, 'home_battery_ctl.charging_future', true),
							exit('reference', 116, 3, 'settings'), exit('return', 169, 4, 'return requests')],
					},
				},
			],
		}],
		other: [], isCallHierarchyMissing: true, errors: [],
	};
	const context = (line: number) => ({ kind: 'context' as const, text: `      line ${line};`, oldLine: line, newLine: line });
	return {
		model, base: 'main (merge base 1234567)',
		files: [{
			file, hunks: [[context(66), context(67), context(68),
				{ kind: 'removed', text: '      if (cost < 1e-5) {', oldLine: 69, newLine: 69 },
				{ kind: 'added', text: '      if (cost < 1e-4) {', newLine: 69 },
				context(70), context(71), context(72)]],
		}],
	};
}

// The rows of the engine: line 69 has tokens, the other lines have their text
const rowOf = (_file: string, line: number): SideRow => (line === 69
	? { line, text: '      if (cost < 1e-4) {', spans: [6, 8, lexical('keyword.control'), 10, 14, variable, 17, 21, lexical('number')] }
	: { line, text: `      line ${line};`, spans: [] });

const review = (): ReviewState => ({ isRunning: false, base: 'main (merge base 1234567)', notice: 'No call hierarchy provider answered.', other: [] });

// The style of the span that contains a column, or -1
function styleAt(spans: number[], col: number): number {
	for (let i = 0; i + 2 < spans.length; i += 3) {
		if (spans[i] <= col && col < spans[i + 1]) {
			return spans[i + 2];
		}
	}
	return -1;
}

suite('Change Ripple in the side view', () => {
	test('The hunks of a diff have the lines of the base and of the working tree', () => {
		const patch = [
			'diff --git a/src/a.cpp b/src/a.cpp',
			'--- a/src/a.cpp',
			'+++ b/src/a.cpp',
			'@@ -10,3 +10,3 @@ void f() {',
			'   int a = 1;',
			'-  if (a < 1e-5) {',
			'+  if (a < 1e-4) {',
			'     g(a);',
			'@@ -50,2 +50,0 @@',
			'-  a();',
			'-  b();',
			'\\ No newline at end of file',
			'',
		].join('\n');
		assert.deepStrictEqual(diffHunks(patch), [
			[
				{ kind: 'context', text: '  int a = 1;', oldLine: 10, newLine: 10 },
				{ kind: 'removed', text: '  if (a < 1e-5) {', oldLine: 11, newLine: 11 },
				{ kind: 'added', text: '  if (a < 1e-4) {', newLine: 11 },
				{ kind: 'context', text: '    g(a);', oldLine: 12, newLine: 12 },
			],
			[
				{ kind: 'removed', text: '  a();', oldLine: 50, newLine: 51 },
				{ kind: 'removed', text: '  b();', oldLine: 51, newLine: 51 },
			],
		]);
	});

	test('The lexer colors a line of the base, and a changed line keeps the colors of the engine', () => {
		const text = '  if (a < 1e-5) return "x"; // done';
		const spans = lexSpans(text);
		assert.strictEqual(styleAt(spans, text.indexOf('if')), lexical('keyword.control'));
		assert.strictEqual(styleAt(spans, text.indexOf('1e-5') + 3), lexical('number'));
		assert.strictEqual(styleAt(spans, text.indexOf('"x"')), lexical('string'));
		assert.strictEqual(styleAt(spans, text.indexOf('// done') + 4), lexical('comment'));
		assert.strictEqual(styleAt(spans, text.indexOf('a <')), -1);
		assert.strictEqual(styleAt(lexSpans('#include <vector>'), 1), lexical('preprocessor'));

		const old = pairedSpans('      if (cost < 1e-5) {', rowOf(file, 69));
		assert.strictEqual(styleAt(old, 6), lexical('keyword.control'));
		assert.strictEqual(styleAt(old, 11), variable);
		assert.strictEqual(styleAt(old, 17), lexical('number'));
		assert.strictEqual(styleAt(old, 20), lexical('number'));
	});

	test('The story has the diff, the facts, and a card for each function and lambda with its links', () => {
		const story = buildSideStory(review(), layer(), rowOf, 4)!;
		assert.strictEqual(story.seq, 4);
		assert.strictEqual(story.notice, 'No call hierarchy provider answered.');
		const [change] = story.changes;
		assert.strictEqual(change.label, 'solve()');

		// the diff: the removed line and the added line mark the changed digit
		assert.deepStrictEqual(change.diff.map((r) => `${r.kind} ${r.line}`),
			['context 66', 'context 67', 'context 68', 'removed 69', 'added 69', 'context 70', 'context 71', 'context 72']);
		const removed = change.diff[3];
		const added = change.diff[4];
		assert.deepStrictEqual([removed.changed, added.changed], [[20, 21], [20, 21]]);
		assert.strictEqual(styleAt(removed.spans, 20), lexical('number'));
		assert.strictEqual(styleAt(added.spans, 11), variable);

		assert.deepStrictEqual(change.stats, ['1 line changed', '2 functions', '1 async boundary', '9 steps', '2 exits']);
		assert.strictEqual(change.waves, 8);

		const [solve, lambda, process] = change.cards;
		assert.deepStrictEqual(change.cards.map((c) => [c.label, c.depth, c.isChange, c.isEstimated, c.wave]),
			[['solve()', 0, true, false, 0], ['lambda in process()', 1, false, false, 3], ['process()', 1, false, true, 4]]);

		// the card of the change: the steps, a fold for the gap, and the return to the caller as the note of line 77
		assert.deepStrictEqual(solve.rows.map((r) => [r.line, r.fold ?? r.wave, r.note]), [
			[69, 0, 'changed'], [70, 1, 'runs on a branch of line 69'], [71, 6, undefined], [77, 2, 'returns to 1 caller'],
		]);
		assert.deepStrictEqual(solve.rows[0].changed, [20, 21]);
		assert.ok(solve.rows[0].spans.length > 0);
		assert.deepStrictEqual(solve.exits, []);
		assert.strictEqual(solve.link, undefined);

		// the return value goes to the lambda, and the lambda goes into the async call
		assert.deepStrictEqual(lambda.link, { kind: 'return', text: 'solve() returns to the lambda in process(), line 95' });
		assert.deepStrictEqual(lambda.rows.map((r) => r.note), ['calls solve()']);
		assert.deepStrictEqual(process.link,
			{ kind: 'async', text: 'async call: tf::Executor::async. The value comes back through home_battery_ctl.charging_future.' });

		// a gap of one line is a line of context. A row with the same note as the row before it has no note, but a row after
		// a fold has its note
		assert.deepStrictEqual(process.rows.map((r) => [r.line, r.fold ?? r.wave, r.note]), [
			[95, 4, 'async call: tf::Executor::async'], [96, 6, undefined], [102, 5, 'reads home_battery_ctl.charging_future'],
			[103, -1, undefined], [104, 6, 'runs on a branch of line 102'], [105, 6, undefined], [106, 3, undefined],
			[109, 6, 'runs on a branch of line 102'], [110, 59, undefined], [169, 7, 'reads requests'],
		]);
		assert.strictEqual(process.rows[5].why, 'runs on a branch of line 102');
		assert.deepStrictEqual(process.rows[3], { line: 103, text: '      line 103;', spans: [], wave: -1 });
		assert.deepStrictEqual(process.exits, [{ line: 116, kind: 'reference', text: 'can change settings' }, { line: 169, kind: 'return', text: 'return requests' }]);
	});

	test('The story asks the engine for the lines of its cards and of its diff in groups', () => {
		const lines = storyLines(layer());
		assert.strictEqual(lines.size, 1);
		const [entry] = lines.values();
		assert.deepStrictEqual(entry.lines, [66, 67, 68, 69, 70, 71, 72, 77, 95, 102, 103, 104, 105, 109, 169]);
		assert.deepStrictEqual(lineRanges(entry.lines, 20), [[66, 109], [169, 169]]);
		assert.deepStrictEqual(lineRanges([5, 1, 30, 3, 30], 2), [[1, 5], [30, 30]]);
	});

	test('A running review and a review with an error have a story with no changes', () => {
		assert.strictEqual(buildSideStory(undefined, undefined, rowOf, 1), null);
		const running = buildSideStory({ isRunning: true, other: [] }, undefined, rowOf, 2)!;
		assert.deepStrictEqual([running.isRunning, running.changes], [true, []]);
		const failed = buildSideStory({ isRunning: false, message: 'The base main does not exist.', other: [] }, undefined, rowOf, 3)!;
		assert.strictEqual(failed.message, 'The base main does not exist.');
	});

	test('The file view gets the changed lines, the lines that the changes reach and the hints of its file', () => {
		const ripple = buildSideRipple(layer(), file)!;
		assert.deepStrictEqual(ripple.lines.map((l) => [l.line, l.isChange, l.isEstimated]), [
			[69, true, false], [70, false, false], [77, false, false], [95, false, false], [102, false, true], [104, false, true],
			[105, false, true], [109, false, true], [169, false, true],
		]);
		assert.deepStrictEqual(ripple.hints.map((h) => [h.line, h.text]), [
			[77, 'returns to 1 caller'], [95, 'async: tf::Executor::async · later calls read home_battery_ctl.charging_future'],
		]);
		assert.strictEqual(buildSideRipple(layer(), 'src/main.cpp'), null);
	});

	test('The cards come in the order of a tree: each body before its callers, and the short names of the exits', () => {
		// f returns to g and h, and g returns to k. The ripple finds them level by level: f, g, h, k
		const body = (from?: number) => ({ file, depth: from === undefined ? 0 : 1, offset: 0, from, body: { function: fn('x', 1, 2), seedLines: [], steps: [], exits: [] } });
		assert.deepStrictEqual(treeOrder([body(), body(0), body(0), body(1)]), [0, 1, 3, 2]);
		// two bodies of the change, for example a function and its lambda, are two roots
		assert.deepStrictEqual(treeOrder([body(), body(), body(1), body(0)]), [0, 3, 1, 2]);
		assert.strictEqual(lastName('electricity::power_ctrl::fire_transition'), 'fire_transition');
		assert.strictEqual(lastName('ns::Holder<std::vector<int>>::get'), 'get');
		assert.strictEqual(lastName('process'), 'process');
	});
});
