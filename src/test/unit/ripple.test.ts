import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EngineFunction, SliceBody, SliceConfidence, SliceExitKind, SliceModel, SliceSeed, SliceStep, SliceStepKind } from '../../engine/client';
import { buildReviewState, buildRippleViews, linesText, rippleFacts } from '../../lenses/ripple';
import { parseDiff } from '../../review/git';
import { CallSite, RippleModel, runRipple } from '../../review/ripple';
import { targetCandidates, targetItems } from '../../review/targets';

// Functions, steps and exits of the engine. The engine counts lines from 1.
const fn = (name: string, line: number): EngineFunction => ({
	name, qualifiedName: `ns::${name}`, kind: 'function',
	range: { begin: { line, col: 1 }, end: { line: line + 20, col: 1 } }, nameAt: { line, col: 6 },
});
const step = (line: number, distance: number, kind: SliceStepKind = 'data', confidence: SliceConfidence = 'exact'): SliceStep =>
	({ line, col: 3, len: 4, lines: [line], kind, confidence, distance, from: -1, via: '', text: `line ${line}` });
const exit = (kind: SliceExitKind, line: number, stepIndex: number, text: string, followed = false) =>
	({ kind, line, col: 3, len: 4, text, step: stepIndex, followed });

// f changes on line 5 and returns on line 8. A lambda in g calls f with std::async and is a caller of f.
function rippleModel(): RippleModel {
	return {
		changes: [{
			file: 'a.cpp', fn: fn('f', 1), lines: [5, 6], bodies: [
				{
					file: 'a.cpp', depth: 0, offset: 0, body: {
						function: fn('f', 1), seedLines: [5],
						steps: [step(5, 0, 'seed'), step(8, 1), step(9, 2, 'member', 'estimated')],
						exits: [exit('return', 8, 1, 'return x'), exit('member', 9, 2, 'obj.state', true)],
					},
				},
				{
					file: 'a.cpp', depth: 1, offset: 2, from: 0, body: {
						function: fn('g', 25), lambda: { line: 30, col: 20 }, seedLines: [],
						steps: [step(30, 0, 'seed', 'call'), step(8, 5, 'data', 'call')],
						exits: [exit('async', 30, 0, 'std::async', true)],
					},
				},
			],
		}],
		other: [], isCallHierarchyMissing: false, errors: [],
	};
}

suite('Change Ripple', () => {
	test('A diff gives the changed lines of the new file, and the deleted blocks with their text', () => {
		const patch = [
			'diff --git a/src/a.cpp b/src/a.cpp',
			'index 1111111..2222222 100644',
			'--- a/src/a.cpp',
			'+++ b/src/a.cpp',
			'@@ -10,4 +10,4 @@ void f() {',
			'   int a = 1;',
			'-  if (a < 1e-5) {',
			'+  if (a < 1e-4) {',
			'     g(a);',
			'   }',
			'@@ -30,3 +30,2 @@',
			'   x = 1;',
			'-  res = cost;',
			'   y = 2;',
			'@@ -50,2 +49,0 @@',
			'-  a();',
			'-  b();',
			'\\ No newline at end of file',
		].join('\n');
		// a replaced line is a change of the new line. a hunk with no new lines comes after the line in its header
		assert.deepStrictEqual(parseDiff(patch), {
			lines: [11],
			deleted: [{ line: 31, text: '  res = cost;' }, { line: 50, text: '  a();\n  b();' }],
		});
	});

	test('The ripple follows a return value to the callers, up to the maximum depth', async () => {
		const f: SliceBody = {
			function: fn('f', 1), seedLines: [5], steps: [step(5, 0, 'seed'), step(8, 1)],
			exits: [exit('return', 8, 1, 'return x')], callers: [{ line: 30, col: 12, function: 'ns::g' }],
		};
		const g: SliceBody = {
			function: fn('g', 25), seedLines: [], steps: [step(30, 0, 'seed', 'call'), step(33, 1, 'data', 'call')],
			exits: [exit('return', 33, 1, 'return y')], callers: [],
		};
		const h: SliceBody = { function: fn('h', 1), seedLines: [], steps: [step(4, 0, 'seed', 'call')], exits: [exit('return', 6, 0, 'return z')] };

		const requests: string[] = [];
		const slice = async (file: string, seed: SliceSeed): Promise<SliceModel> => {
			requests.push(`${file} ${JSON.stringify(seed)}`);
			const isChange = 'lines' in seed;
			return { bodies: isChange ? [f] : file === 'a.cpp' ? [g] : [h], outside: [], quiet: isChange ? [2] : [], callFound: true };
		};
		// the call hierarchy gives the call of f in a.cpp again, and the call of g in b.cpp
		const callers = async (_file: string, target: EngineFunction): Promise<CallSite[]> =>
			target.name === 'f' ? [{ file: 'a.cpp', line: 30, col: 12 }] : target.name === 'g' ? [{ file: 'b.cpp', line: 4, col: 9 }] : [];
		const model = await runRipple([{ file: 'a.cpp', lines: [2, 5], deleted: [] }], { slice, callers, maxDepth: 2 });

		assert.deepStrictEqual(requests, [
			'a.cpp {"lines":[2,5],"deleted":[]}',
			'a.cpp {"call":{"line":30,"col":12}}',
			'b.cpp {"call":{"line":4,"col":9}}',
		]);
		const [change] = model.changes;
		assert.deepStrictEqual(change.lines, [5]);
		// the wave gets to a caller one step after the return of the function
		assert.deepStrictEqual(change.bodies.map((b) => [b.body.function.name, b.depth, b.offset, b.from]),
			[['f', 0, 0, undefined], ['g', 1, 2, 0], ['h', 2, 4, 1]]);
		assert.deepStrictEqual(change.bodies.map((b) => b.call), [undefined, { file: 'a.cpp', line: 30, col: 12 }, { file: 'b.cpp', line: 4, col: 9 }]);
		assert.deepStrictEqual(model.other, [{ file: 'a.cpp', outside: [], quiet: [2] }]);
		assert.strictEqual(model.isCallHierarchyMissing, false);
	});

	test('The files go in parallel, the result has the sequence of the files, and the call hierarchy gets one request at a time', async () => {
		const body = (name: string): SliceBody => ({
			function: fn(name, 1), seedLines: [5], steps: [step(5, 0, 'seed')], exits: [exit('return', 5, 0, 'return 1')], callers: [],
		});
		// the first file is the slowest, so its slice ends last
		const delays: Record<string, number> = { 'a.cpp': 60, 'b.cpp': 10, 'c.cpp': 30 };
		let running = 0;
		let maxRunning = 0;
		let asking = 0;
		let maxAsking = 0;
		const slice = async (file: string, seed: SliceSeed): Promise<SliceModel> => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => setTimeout(resolve, 'lines' in seed ? delays[file] : 1));
			running--;
			return { bodies: 'lines' in seed ? [body(file.replace('.cpp', ''))] : [], outside: [], quiet: [], callFound: true };
		};
		const callers = async (): Promise<CallSite[]> => {
			asking++;
			maxAsking = Math.max(maxAsking, asking);
			await new Promise((resolve) => setTimeout(resolve, 5));
			asking--;
			return [];
		};
		const files = ['a.cpp', 'b.cpp', 'c.cpp'].map((file) => ({ file, lines: [5], deleted: [] }));
		const model = await runRipple(files, { slice, callers, maxDepth: 2, concurrency: 3 });
		assert.deepStrictEqual(model.changes.map((c) => c.fn.name), ['a', 'b', 'c']);
		assert.strictEqual(maxRunning, 3);
		assert.strictEqual(maxAsking, 1);
	});

	test('With no call hierarchy, the ripple follows the callers of the same file, and an error does not stop it', async () => {
		const f: SliceBody = { function: fn('f', 1), seedLines: [5], steps: [step(5, 0, 'seed')], exits: [exit('return', 5, 0, 'return 1')], callers: [] };
		const slice = async (file: string): Promise<SliceModel> => {
			if (file === 'bad.cpp') {
				throw new Error('no compile command');
			}
			return { bodies: [f], outside: [], quiet: [], callFound: true };
		};
		const model = await runRipple([{ file: 'bad.cpp', lines: [1], deleted: [] }, { file: 'a.cpp', lines: [5], deleted: [] }],
			{ slice, callers: async () => undefined, maxDepth: 2 });
		assert.strictEqual(model.changes.length, 1);
		assert.ok(model.isCallHierarchyMissing);
		const review = buildReviewState(model, 'main');
		assert.match(review.notice!, /^No call hierarchy provider answered/);
		assert.strictEqual(review.message, 'bad.cpp: no compile command');
	});

	test('The view of a file has the wave step of each line, the changed lines and the hints', () => {
		const view = buildRippleViews(rippleModel()).get('a.cpp')!;
		// lines start at 0. a line keeps its first wave step
		assert.deepStrictEqual(view.lines.map((l) => [l.line, l.wave, l.confidence, l.isChange]), [
			[4, 0, 'exact', true], [5, 0, 'exact', true], [7, 1, 'exact', false], [8, 2, 'estimated', false], [29, 2, 'call', false],
		]);
		assert.strictEqual(view.waves, 3);
		assert.deepStrictEqual(view.hints, [
			{ line: 7, text: 'returns to 1 caller' }, { line: 8, text: 'later calls read obj.state' }, { line: 29, text: 'async: std::async' },
		]);
	});

	test('The state of a review has the base, the changed lines with no statement, and a message if nothing changed', () => {
		assert.deepStrictEqual(buildReviewState(rippleModel(), 'main (merge base 1234567)', 'main'),
			{ isRunning: false, base: 'main (merge base 1234567)', target: 'main', message: undefined, notice: undefined, other: [] });
		const quiet = buildReviewState({ changes: [], other: [{ file: 'src/a.cpp', outside: [3, 4, 5], quiet: [9] }], isCallHierarchyMissing: false, errors: [] }, 'main');
		assert.deepStrictEqual(quiet.other.map((o) => `${o.file}: ${o.text}`), ['a.cpp: lines 3 to 5 are outside of a function', 'a.cpp: lines 9 have no statement']);
		assert.strictEqual(quiet.message, undefined);
		const empty = buildReviewState({ changes: [], other: [], isCallHierarchyMissing: false, errors: [] }, 'main');
		assert.strictEqual(empty.message, 'No C or C++ file changed against the target branch.');
		assert.strictEqual(linesText([3, 1, 2, 7, 9, 10]), '1 to 3, 7, 9 to 10');
	});

	test('With no target branch of the user, the review tries the setting, the default branch of the remote, main and master', () => {
		assert.deepStrictEqual(targetCandidates('', 'origin/dev'), ['origin/dev', 'origin/main', 'main', 'origin/master', 'master']);
		assert.deepStrictEqual(targetCandidates('', undefined), ['origin/main', 'main', 'origin/master', 'master']);
		// a ref of the setting with origin/ also gives its local branch, for a repository with no remote
		assert.deepStrictEqual(targetCandidates('origin/develop', 'origin/main'), ['origin/develop', 'develop', 'origin/main', 'main', 'origin/master', 'master']);
		// the branch that the active branch comes from, as VS Code notes it, comes after the setting
		assert.deepStrictEqual(targetCandidates('', 'origin/dev', 'topic'), ['topic', 'origin/dev', 'origin/main', 'main', 'origin/master', 'master']);
		assert.deepStrictEqual(targetCandidates('origin/x', 'origin/dev', 'topic').slice(0, 4), ['origin/x', 'x', 'topic', 'origin/dev']);
	});

	test('The list of target branches has Automatic, the default branch and HEAD first, and not the active branch', () => {
		const branches = { local: ['feature', 'master', 'old'], remote: ['origin/dev', 'origin/feature', 'origin/master'] };
		const text = (items: ReturnType<typeof targetItems>) => items.map((i) => (i.kind === vscode.QuickPickItemKind.Separator ? `-- ${i.label}` : `${i.ref}: ${i.description}`));
		assert.deepStrictEqual(text(targetItems(branches, 'feature', 'origin/dev', 'master')), [
			': the branch that this branch comes from, the default branch of the remote, or main or master',
			'origin/dev: the default branch of the remote',
			'HEAD: only the changes that are not committed',
			'-- Local branches',
			'master: selected',
			'old: ',
			'-- Remote branches',
			'origin/feature: ',
			'origin/master: ',
		]);
		// with no target branch of the user, Automatic has the mark
		const automatic = targetItems({ local: ['feature'], remote: [] }, 'feature', undefined, undefined);
		assert.deepStrictEqual(text(automatic), [': the branch that this branch comes from, the default branch of the remote, or main or master · selected',
			'HEAD: only the changes that are not committed']);
	});

	test('The facts of a review for a client: the bodies of each change with their depth, lines, steps and exits', () => {
		const model = rippleModel();
		const state = buildReviewState(model, 'main (merge base 1a2b3c4)', 'main');
		const facts = rippleFacts(model, state, (file) => `src/${file}`);
		assert.deepStrictEqual([facts.base, facts.target, facts.counts], ['main (merge base 1a2b3c4)', 'main', { changes: 1, bodies: 2, reachedLines: 4 }]);
		const [change] = facts.changes!;
		assert.deepStrictEqual([change.file, change.function, change.lines], ['src/a.cpp', 'ns::f', [5, 6]]);
		assert.deepStrictEqual(change.bodies.map((b) => [b.function, b.depth, b.lambdaLine ?? 0, b.lines]), [['ns::f', 0, 0, [5, 8, 9]], ['ns::g', 1, 30, [8, 30]]]);
		assert.deepStrictEqual(change.bodies[0].steps[2], { line: 9, kind: 'member', confidence: 'estimated', distance: 2, text: 'line 9' });
		assert.deepStrictEqual(change.bodies[0].exits, [{ kind: 'return', line: 8, text: 'return x' }, { kind: 'member', line: 9, text: 'obj.state', followed: true }]);
		assert.strictEqual(facts.notice, undefined);
	});
});
