import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TextChange } from '../../lenses/blocks';
import type { HeatBand, HeatFunction, HeatModel, HeatReason } from '../../lenses/heat';
import { diffHunks, type DiffLine } from '../../review/git';
import { guideFacts, guideSummary, moveGuide, restoreGuide, storeGuide, type GuideFileLines } from '../../review/guide';
import { walkBranchItems, type TargetItem } from '../../review/targets';
import {
	commandWalk, groupText, groupTitle, MAX_WALK_STEPS, resolveWalkPlan, stepDiff, walkFacts, walkGroups, walkHunks, walkTitle, type WalkFile, type WalkInput,
} from '../../review/walk';

// The diff walk: the hunks of a diff, the default steps of the command, the check of the plan of a model, the facts for
// the model, and the diff of a step when the text changes

const ROOT = path.resolve('/repo');
const CPP = path.join(ROOT, 'src', 'rate.cpp');
const HPP = path.join(ROOT, 'include', 'rate.hpp');

// The base of rate.cpp:
//   1 #include <cmath>       5 	return r;              9 	int a = x + 1;
//   2                       6 }                       10 	int b = a * 2;
//   3 // the rate            7                         11 	return b;
//   4 int clamp_rate(int r) { 8 int process(int x) {   12 }
// The working tree adds an include, clamps the rate, removes b and adds the function helper() at the end
const PATCH = [
	'@@ -1,2 +1,3 @@',
	' #include <cmath>',
	'+#include <algorithm>',
	' ',
	'@@ -4,3 +5,3 @@',
	' int clamp_rate(int r) {',
	'-\treturn r;',
	'+\treturn std::clamp(r, 0, 100);',
	' }',
	'@@ -9,4 +10,3 @@',
	' \tint a = x + 1;',
	'-\tint b = a * 2;',
	'-\treturn b;',
	'+\treturn a;',
	' }',
	'@@ -12,0 +13,4 @@',
	'+',
	'+int helper() {',
	'+\treturn 3;',
	'+}',
].join('\n');

const FUNCTIONS = [
	{ name: 'clamp_rate()', qualified: 'rate::clamp_rate', first: 5, last: 7 },
	{ name: 'process()', qualified: 'rate::process', first: 9, last: 12 },
	{ name: 'helper()', qualified: 'rate::helper', first: 14, last: 16 },
];

const rateFile = (extra: Partial<WalkFile> = {}): WalkFile => ({ file: CPP, lineCount: 16, hunks: diffHunks(PATCH), functions: FUNCTIONS, ...extra });

const input = (files: WalkFile[], extra: Partial<WalkInput> = {}): WalkInput => ({
	root: ROOT, title: 'Changes that are not committed', base: 'HEAD (1a2b3c4)', baseCommit: '1a2b3c4d5e', files, deleted: [], other: [], ...extra,
});

// A hunk of added lines from a line, for the tests of many hunks
const addedHunk = (first: number, count: number): DiffLine[] =>
	Array.from({ length: count }, (_, i) => ({ kind: 'added' as const, text: `line ${first + i}`, newLine: first + i }));

const change = (startLine: number, startChar: number, endLine: number, endChar: number, text: string): TextChange =>
	({ range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } }, text });

suite('Diff walk', () => {
	test('The hunks get ids, their changed lines, the functions that they change and the functions that they add', () => {
		const hunks = walkHunks([rateFile()]);
		assert.deepStrictEqual(hunks.map((h) => [h.id, h.first, h.last, h.plus, h.minus]), [
			['h1', 2, 2, 1, 0],
			// a removed line with an added line after it marks the added line
			['h2', 6, 6, 1, 1],
			['h3', 11, 11, 1, 2],
			['h4', 13, 16, 4, 0],
		]);
		assert.deepStrictEqual(hunks.map((h) => h.functions.map((f) => f.name)), [[], ['clamp_rate()'], ['process()'], ['helper()']]);
		assert.deepStrictEqual(hunks.map((h) => h.newFunctions.map((f) => f.name)), [[], [], [], ['helper()']]);
		// with no functions of the engine, a hunk has no functions
		assert.deepStrictEqual(walkHunks([rateFile({ functions: undefined })]).map((h) => h.functions.length), [0, 0, 0, 0]);
	});

	test('A removed block marks the line after it, and a block at the end of the file marks the last line', () => {
		const removed = (oldLine: number, newLine: number): DiffLine => ({ kind: 'removed', text: 'gone', oldLine, newLine });
		const hunks = walkHunks([{ file: CPP, lineCount: 10, hunks: [[removed(4, 4), removed(5, 4)], [removed(12, 11)]] }]);
		assert.deepStrictEqual(hunks.map((h) => [h.first, h.last, h.plus, h.minus]), [[4, 4, 0, 2], [10, 10, 0, 1]]);
	});

	test('The default steps put the hunks of one function in one step, and a hunk with no function is a step', () => {
		const sameFunction: WalkFile = {
			file: CPP, lineCount: 100, hunks: [addedHunk(10, 1), addedHunk(20, 2), addedHunk(60, 1)],
			functions: [{ name: 'run()', qualified: 'run', first: 5, last: 40 }],
		};
		const { groups, skipped } = walkGroups(walkHunks([sameFunction]));
		assert.deepStrictEqual(groups.map((g) => g.map((h) => h.id)), [['h1', 'h2'], ['h3']]);
		assert.deepStrictEqual(skipped, []);
		assert.strictEqual(groupTitle(groups[0]), 'Changes in run()');
		assert.strictEqual(groupText(groups[0]), '3 lines added in `run`. The step has 2 parts of the diff.');
		assert.strictEqual(groupTitle(groups[1]), 'Changes at line 60');
	});

	test('The titles and the texts of the default steps give the new file, the new function, the function or the lines', () => {
		const groups = walkGroups(walkHunks([rateFile()])).groups;
		assert.deepStrictEqual(groups.map(groupTitle), ['Changes at line 2', 'Changes in clamp_rate()', 'Changes in process()', 'New function helper()']);
		assert.deepStrictEqual(groups.map(groupText), [
			'1 line added.',
			'1 line added, 1 line removed in `rate::clamp_rate`.',
			'1 line added, 2 lines removed in `rate::process`.',
			'4 lines added in `rate::helper`.',
		]);
		const newFile = walkGroups(walkHunks([{ file: HPP, lineCount: 3, hunks: [addedHunk(1, 3)], isNew: true }])).groups[0];
		assert.strictEqual(groupTitle(newFile), 'New file rate.hpp');
		assert.strictEqual(groupText(newFile), 'A new file with 3 lines.');
	});

	test('With more than the maximum of steps, each file is one step, and the files after the maximum are not in the walk', () => {
		const manyHunks: WalkFile = { file: CPP, lineCount: 500, hunks: Array.from({ length: MAX_WALK_STEPS + 5 }, (_, i) => addedHunk(1 + i * 10, 1)) };
		assert.deepStrictEqual(walkGroups(walkHunks([manyHunks])).groups.map((g) => g.length), [MAX_WALK_STEPS + 5]);
		const manyFiles = Array.from({ length: MAX_WALK_STEPS + 3 }, (_, i): WalkFile => ({ file: path.join(ROOT, `f${i}.cpp`), lineCount: 5, hunks: [addedHunk(1, 1)] }));
		const { groups, skipped } = walkGroups(walkHunks(manyFiles));
		assert.strictEqual(groups.length, MAX_WALK_STEPS);
		assert.deepStrictEqual(skipped.map((h) => path.basename(h.file)), [`f${MAX_WALK_STEPS}.cpp`, `f${MAX_WALK_STEPS + 1}.cpp`, `f${MAX_WALK_STEPS + 2}.cpp`]);
		const guide = commandWalk(input(manyFiles), 1)!;
		assert.strictEqual(guide.steps.length, MAX_WALK_STEPS);
		assert.match(guide.summary!, /A walk has a maximum of 40 steps, so the changes of f40\.cpp, f41\.cpp, f42\.cpp are not in the walk\./);
	});

	test('The diff of a step has the rows with a fold between two hunks, the added lines, the changed characters and the removed blocks', () => {
		const [h1, h2] = walkHunks([rateFile()]);
		const diff = stepDiff([h1, h2]);
		assert.deepStrictEqual(diff.rows.map((r) => [r.kind, r.line, r.at, r.count]), [
			['context', 1, 1, undefined], ['added', 2, 2, undefined], ['context', 3, 3, undefined],
			['fold', 5, 5, 1],
			['context', 5, 5, undefined], ['removed', 5, 6, undefined], ['added', 6, 6, undefined], ['context', 7, 7, undefined],
		]);
		// "return r" became "return std::clamp(r, 0, 100)": the changed characters of the pair
		const [removed, added] = diff.rows.filter((r) => r.kind === 'removed' || r.kind === 'added').slice(1);
		assert.strictEqual(removed.text.slice(...removed.changed!), 'r');
		assert.strictEqual(added.text.slice(...added.changed!), 'std::clamp(r, 0, 100)');
		assert.deepStrictEqual(diff.added, [[2, 2], [6, 6]]);
		assert.deepStrictEqual(diff.changed, [{ line: 6, start: 8, end: 29 }]);
		assert.deepStrictEqual(diff.removed, [{ at: 6, count: 1, texts: ['\treturn r;'] }]);
		assert.deepStrictEqual([diff.plus, diff.minus], [2, 1]);
		// most of the line changed: no changed characters
		const h3 = walkHunks([rateFile()])[2];
		assert.deepStrictEqual(stepDiff([h3]).changed, []);
		assert.deepStrictEqual(stepDiff([h3]).removed, [{ at: 11, count: 2, texts: ['\tint b = a * 2;', '\treturn b;'] }]);
	});

	test('A long diff of a step gets a fold for the rows after the maximum, and the marks keep all lines', () => {
		const [hunk] = walkHunks([{ file: CPP, lineCount: 400, hunks: [addedHunk(1, 400)], isNew: true }]);
		const diff = stepDiff([hunk]);
		assert.strictEqual(diff.rows.length, 161);
		assert.deepStrictEqual(diff.rows[160], { kind: 'fold', line: 161, at: 161, text: '', count: 240 });
		assert.deepStrictEqual(diff.added, [[1, 400]]);
	});

	test('The walk of the command has the default steps with their diff, and a summary of the changes', () => {
		const guide = commandWalk(input([rateFile()], { deleted: [path.join(ROOT, 'src', 'old.cpp')], other: [path.join(ROOT, 'CMakeLists.txt')] }), 7)!;
		assert.strictEqual(guide.kind, 'diff');
		assert.strictEqual(guide.title, 'Changes that are not committed');
		assert.strictEqual(guide.base, 'HEAD (1a2b3c4)');
		assert.strictEqual(guide.baseCommit, '1a2b3c4d5e');
		assert.strictEqual(guide.seq, 7);
		assert.strictEqual(guide.current, 0);
		assert.strictEqual(guide.client, undefined);
		assert.strictEqual(guide.summary,
			'1 file: 7 lines added, 3 lines removed. Deleted files: src/old.cpp. Changed files that are not C or C++ files: CMakeLists.txt.');
		assert.deepStrictEqual(guide.steps.map((s) => [s.title, s.name, s.first, s.last, s.status, s.diff?.plus, s.diff?.minus]), [
			['Changes at line 2', 'rate.cpp', 2, 2, 'todo', 1, 0],
			['Changes in clamp_rate()', 'rate.cpp', 6, 6, 'todo', 1, 1],
			['Changes in process()', 'rate.cpp', 11, 11, 'todo', 1, 2],
			['New function helper()', 'rate.cpp', 13, 16, 'todo', 4, 0],
		]);
		assert.ok(guide.steps.every((s) => s.kind === undefined && s.checks.length === 0));
		// no hunk: no walk
		assert.strictEqual(commandWalk(input([]), 1), undefined);
	});

	test('A plan of a model keeps its sequence, and DataFlow adds a step for each hunk that no step names', () => {
		const hunks = walkHunks([rateFile()]);
		const plan = {
			title: 'The clamp of the rate',
			summary: 'The rate stays in 0 to 100.',
			steps: [
				{ title: 'Add the helper', text: 'The helper gives 3.', hunks: ['h4'] },
				{ title: 'Clamp the rate', text: 'The rate cannot go over 100.', hunks: [' h2 '], kind: 'change', checks: ['Is 100 the limit?', ''] },
			],
		};
		const { guide, problems, added } = resolveWalkPlan(plan, hunks, { input: input([rateFile()]), seq: 3, client: 'claude-code' });
		assert.deepStrictEqual(problems, []);
		assert.ok(guide);
		assert.strictEqual(guide.title, 'The clamp of the rate');
		assert.strictEqual(guide.summary, 'The rate stays in 0 to 100.');
		assert.strictEqual(guide.client, 'claude-code');
		assert.strictEqual(guide.kind, 'diff');
		assert.deepStrictEqual(guide.steps.map((s) => [s.title, s.first, s.last, s.kind]), [
			['Add the helper', 13, 16, undefined],
			['Clamp the rate', 6, 6, 'change'],
			['Changes at line 2', 2, 2, undefined],
			['Changes in process()', 11, 11, undefined],
		]);
		assert.deepStrictEqual(guide.steps[1].checks, ['Is 100 the limit?']);
		assert.match(guide.steps[2].text, /^1 line added\. The plan of the model has no step for this change, so DataFlow added this step\.$/);
		assert.deepStrictEqual(added.map((g) => g.map((h) => h.id)), [['h1'], ['h3']]);

		// with allHunks false, the walk has only the steps of the plan, and notShown names the other hunks
		const only = resolveWalkPlan({ ...plan, allHunks: false }, hunks, { input: input([rateFile()]), seq: 4 });
		assert.deepStrictEqual(only.problems, []);
		assert.deepStrictEqual(only.guide?.steps.map((s) => s.title), ['Add the helper', 'Clamp the rate']);
		assert.deepStrictEqual([only.added, only.notShown], [[], ['h1', 'h3']]);
		assert.deepStrictEqual(resolveWalkPlan(plan, hunks, { input: input([rateFile()]), seq: 5 }).notShown, []);
	});

	test('A wrong plan gives one problem for each wrong step, and no guide', () => {
		const hunks = walkHunks([rateFile(), { file: HPP, lineCount: 5, hunks: [addedHunk(2, 1)] }]);
		const { guide, problems } = resolveWalkPlan({
			steps: [
				{ title: 'Unknown', text: 'x', hunks: ['h1', 'h9'] },
				{ title: 'Two files', text: 'x', hunks: ['h5', 'h2'] },
				{ title: '', text: 'x', hunks: ['h1'] },
				{ title: 'No hunks', text: 'x', hunks: [] },
				{ title: 'Bad kind', text: 'x', hunks: ['h3'], kind: 'later', checks: 'all' },
				'step',
			],
		}, hunks, { input: input([]), seq: 1 });
		assert.strictEqual(guide, undefined);
		assert.deepStrictEqual(problems, [
			'Step 1: h9 is not in the diff. The hunks of get_diff are h1 to h5.',
			'Step 2: the hunks h2 and h5 are in 2 files. All hunks of a step must be in one file, so make one step for each file.',
			'Step 3 has no "title".',
			'Step 4: "hunks" must be a list of one hunk id or more, for example ["h1", "h2"].',
			'Step 5: "kind" must be one of change, ripple, context, risk, test.',
			'Step 5: "checks" must be a list of texts.',
			'Step 6 is not an object.',
		]);
		assert.deepStrictEqual(resolveWalkPlan({ steps: [] }, hunks, { input: input([]), seq: 1 }).problems, ['Give "steps": a list with one step or more.']);
	});

	test('The facts for the model give the hunks with their ids, functions and diff, and the suggested steps', () => {
		const files = [rateFile(), { file: HPP, lineCount: 1800, hunks: [addedHunk(1, 1600)], isNew: true }, { file: path.join(ROOT, 'src', 'z.cpp'), lineCount: 3, hunks: [addedHunk(3, 1)] }];
		const facts = walkFacts(input(files, { deleted: [path.join(ROOT, 'old.hpp')], other: [path.join(ROOT, 'README.md')] }), walkHunks(files)) as {
			base: string; files: { file: string; isNew?: boolean; hunks: { id: string; lines: number[]; functions?: string[]; newFunctions?: string[]; diff?: string; isDiffTruncated?: boolean }[] }[];
			suggestedSteps: { title: string; hunks: string[] }[]; deletedFiles: string[]; otherChangedFiles: string[];
		};
		assert.strictEqual(facts.base, 'HEAD (1a2b3c4)');
		assert.deepStrictEqual(facts.files.map((f) => [f.file, f.isNew ?? false, f.hunks.map((h) => h.id)]), [
			['src/rate.cpp', false, ['h1', 'h2', 'h3', 'h4']], ['include/rate.hpp', true, ['h5']], ['src/z.cpp', false, ['h6']],
		]);
		const [h1, h2, , h4] = facts.files[0].hunks;
		assert.deepStrictEqual(h1, { id: 'h1', lines: [2, 2], added: 1, removed: 0, diff: '     1 | #include <cmath>\n+    2 | #include <algorithm>\n     3 | ' });
		assert.deepStrictEqual(h2.functions, ['rate::clamp_rate']);
		assert.strictEqual(h2.diff, '     5 | int clamp_rate(int r) {\n-      | \treturn r;\n+    6 | \treturn std::clamp(r, 0, 100);\n     7 | }');
		assert.deepStrictEqual(h4.newFunctions, ['rate::helper']);
		// the hunk of 1600 lines is over the maximum of lines of diff. The small hunk after it has its diff
		assert.strictEqual(facts.files[1].hunks[0].isDiffTruncated, true);
		assert.strictEqual(facts.files[1].hunks[0].diff, undefined);
		assert.strictEqual(facts.files[2].hunks[0].diff, '+    3 | line 3');
		assert.deepStrictEqual(facts.suggestedSteps.map((s) => s.hunks), [['h1'], ['h2'], ['h3'], ['h4'], ['h5'], ['h6']]);
		assert.deepStrictEqual(facts.deletedFiles, ['old.hpp']);
		assert.deepStrictEqual(facts.otherChangedFiles, ['README.md']);
	});

	test('With the heat of the files, each hunk has the heat of its changed functions, and hottestChanges gives them, the hottest first', () => {
		const fn = (name: string, first: number, last: number, score: number, band: HeatBand, reasons: HeatReason[] = []): HeatFunction => ({
			name, qualifiedName: `rate::${name}`, first, last, nameLine: first, score, band, flames: 1, reach: 0, risk: 0, history: 0, isSiloed: false,
			isReachComplete: true, reasons,
		});
		const frame: HeatReason = {
			group: 'reach', points: 40, text: 'Runs in each frame: called in the main loop of main',
			id: 'framePath', value: { reason: 'called in the main loop of main', path: [], calls: 0, isInLoop: false },
		};
		const model: HeatModel = {
			file: CPP, notices: [], isReachComplete: true,
			functions: [fn('clamp_rate', 5, 7, 72, 'hot', [{ group: 'risk', points: 3, text: '1 decision', id: 'decisions', value: 1 }, frame]), fn('process', 9, 12, 30, 'warm'), fn('helper', 14, 16, 10, 'cool')],
		};
		const files = [rateFile()];
		const facts = walkFacts(input(files), walkHunks(files), new Map([[CPP, model]])) as {
			files: { hunks: { id: string; heat?: { function: string; score: number; band: string }[] }[] }[];
			hottestChanges: { function: string; file: string; lines: number[]; score: number; band: string; reasons: string[]; hunks: string[] }[];
			suggestedSteps: { hunks: string[]; heat?: number }[];
		};
		// the include on line 2 is in no function
		assert.deepStrictEqual(facts.files[0].hunks.map((h) => [h.id, h.heat?.map((x) => `${x.function} ${x.score} ${x.band}`)]), [
			['h1', undefined], ['h2', ['rate::clamp_rate 72 hot']], ['h3', ['rate::process 30 warm']], ['h4', ['rate::helper 10 cool']],
		]);
		// the reasons with the most points come first
		assert.deepStrictEqual(facts.hottestChanges[0], {
			function: 'rate::clamp_rate', lines: [5, 7], score: 72, band: 'hot', isReachComplete: true, file: 'src/rate.cpp', hunks: ['h2'],
			reasons: ['Runs in each frame: called in the main loop of main (+40 reach)', '1 decision (+3 risk)'],
		});
		assert.deepStrictEqual(facts.hottestChanges.map((c) => c.function), ['rate::clamp_rate', 'rate::process', 'rate::helper']);
		assert.deepStrictEqual(facts.suggestedSteps.map((s) => [s.hunks.join(), s.heat]), [['h1', undefined], ['h2', 72], ['h3', 30], ['h4', 10]]);
		// with no heat, the facts have no heat
		const plain = walkFacts(input(files), walkHunks(files)) as { hottestChanges?: unknown; suggestedSteps: { heat?: number }[] };
		assert.ok(plain.hottestChanges === undefined && plain.suggestedSteps.every((s) => s.heat === undefined));
	});

	test('The diff of a step moves with an edit, and a changed line in the edit loses its changed characters', () => {
		const guide = commandWalk(input([rateFile()]), 1)!;
		// two new lines at the top: all steps and their diffs move down by two
		const moved = moveGuide(guide, CPP, [change(0, 0, 0, 0, 'a\nb\n')]);
		const clamp = moved.steps[1];
		assert.deepStrictEqual([clamp.first, clamp.last], [8, 8]);
		assert.deepStrictEqual(clamp.diff!.added, [[8, 8]]);
		assert.deepStrictEqual(clamp.diff!.changed, [{ line: 8, start: 8, end: 29 }]);
		assert.deepStrictEqual(clamp.diff!.removed.map((r) => r.at), [8]);
		// a removed row keeps its line in the base
		assert.deepStrictEqual(clamp.diff!.rows.map((r) => [r.kind, r.line, r.at]), [['context', 7, 7], ['removed', 5, 8], ['added', 8, 8], ['context', 9, 9]]);
		// an edit in the changed line: the line stays, and its changed characters go away
		const edited = moveGuide(guide, CPP, [change(5, 9, 5, 10, 'x')]);
		assert.deepStrictEqual(edited.steps[1].diff!.changed, []);
		assert.deepStrictEqual(edited.steps[1].diff!.added, [[6, 6]]);
		// an edit after all lines of the steps moves nothing
		assert.strictEqual(moveGuide(guide, CPP, [change(30, 0, 30, 0, 'a\n')]), guide);
	});

	test('A stored walk comes back with the diff of each step at the new place of the step', () => {
		const guide = commandWalk(input([rateFile()]), 1)!;
		const text = ['#include <cmath>', '#include <algorithm>', '', '// the rate', 'int clamp_rate(int r) {', '\treturn std::clamp(r, 0, 100);', '}', '',
			'int process(int x) {', '\tint a = x + 1;', '\treturn a;', '}', '', 'int helper() {', '\treturn 3;', '}'];
		let files: Record<string, string[]> = { [CPP]: text };
		const lines: GuideFileLines = (f) => (files[f] ? { text: (l) => files[f][l - 1], count: files[f].length } : undefined);
		const stored = storeGuide(guide, lines);
		// three new lines at the top in the next session
		files = { [CPP]: ['// a', '// b', '// c', ...text] };
		const back = restoreGuide(stored, lines)!;
		assert.deepStrictEqual(back.steps.map((s) => [s.first, s.last]), [[5, 5], [9, 9], [14, 14], [16, 19]]);
		assert.deepStrictEqual(back.steps[3].diff!.added, [[16, 19]]);
		assert.deepStrictEqual(back.steps[2].diff!.removed.map((r) => r.at), [14]);
	});

	test('The summary and the facts of get_view give the base and the changed lines of each step', () => {
		const guide = commandWalk(input([rateFile()]), 1)!;
		const summary = guideSummary(guide);
		assert.match(summary, /^## Changes that are not committed\n\n1 file: 7 lines added, 3 lines removed\.\n\nChanges against HEAD \(1a2b3c4\)\.\n\n0 of 4 steps reviewed\.\n/);
		assert.match(summary, /- \[ \] 2\. \*\*Changes in clamp_rate\(\)\*\* \(`rate\.cpp:6`, \+1 −1\): not reviewed/);
		const facts = guideFacts(guide) as { kind: string; base: string; steps: { added: number; removed: number }[] };
		assert.strictEqual(facts.kind, 'diff walk');
		assert.strictEqual(facts.base, 'HEAD (1a2b3c4)');
		assert.deepStrictEqual(facts.steps.map((s) => [s.added, s.removed]), [[1, 0], [1, 1], [1, 2], [4, 0]]);
	});

	test('The title of a walk of the command gives the two branches, or the commit or the tag of the base', () => {
		const branches = { local: ['feature', 'main'], remote: ['origin/dev'] };
		assert.strictEqual(walkTitle('HEAD', branches, 'feature'), 'Changes that are not committed');
		assert.strictEqual(walkTitle('main', branches, 'feature'), 'Changes of feature against main');
		assert.strictEqual(walkTitle('origin/dev', branches, 'feature'), 'Changes of feature against origin/dev');
		// a detached HEAD has no active branch
		assert.strictEqual(walkTitle('main', branches, undefined), 'Changes against main');
		assert.strictEqual(walkTitle('HEAD~1', branches, 'feature'), 'Changes since HEAD~1');
		assert.strictEqual(walkTitle('v1.0', branches, 'feature'), 'Changes since v1.0');
	});

	test('The list of branches for a walk has the default branch of the remote first, and not the active branch', () => {
		const text = (items: TargetItem[]) => items.map((i) => (i.kind === vscode.QuickPickItemKind.Separator ? `-- ${i.label}` : `${i.ref}: ${i.description ?? ''}`));
		const branches = { local: ['feature', 'main', 'old'], remote: ['origin/dev', 'origin/feature'] };
		assert.deepStrictEqual(text(walkBranchItems(branches, 'feature', 'origin/dev')), [
			'origin/dev: the default branch of the remote',
			'-- Local branches',
			'main: ',
			'old: ',
			'-- Remote branches',
			'origin/feature: ',
		]);
		// a detached HEAD: all local branches are in the list
		assert.deepStrictEqual(walkBranchItems({ local: ['main'], remote: [] }, undefined, undefined).map((i) => i.ref), [undefined, 'main']);
		// a repository with only the active branch has no branch for a walk
		assert.deepStrictEqual(walkBranchItems({ local: ['main'], remote: [] }, 'main', undefined), []);
	});
});
