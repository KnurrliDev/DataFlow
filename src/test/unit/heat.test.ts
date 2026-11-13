import * as assert from 'assert';
import type { MetricsFunction, ThreadsModel } from '../../engine/client';
import { bandOf, buildHeat, flamesOf, HeatInputs, parseBlame } from '../../lenses/heat';

// The heat score: the parse of the blame of git, the points of each signal, the maximum of each group, the bands and
// the flames

const FILE = '/repo/src/rate.cpp';
const HEADER = '/repo/include/rate.hpp';
const DAY = 24 * 60 * 60;
const NOW = Date.UTC(2026, 10, 13) / 1000; // seconds
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const ZERO = '0'.repeat(40);

// a function of lines first to last, with no risk unless the test gives it
function fn(name: string, first: number, last: number, more: Partial<MetricsFunction> = {}): MetricsFunction {
	return {
		name, qualifiedName: `rate::${name}`, kind: 'function', range: { begin: { line: first, col: 1 }, end: { line: last, col: 1 } },
		nameAt: { line: first, col: 5 }, decisions: 0, depth: 0, bodyLines: last - first + 1, loops: [], writes: [], allocationsInLoops: 0,
		copiesInLoops: 0, declaration: { file: FILE, line: first }, ...more,
	};
}

function inputs(functions: MetricsFunction[], more: Partial<HeatInputs> = {}): HeatInputs {
	return { file: FILE, functions, includeReach: () => undefined, now: NOW * 1000, ...more };
}

// the porcelain lines of a group: the commit, the original and the final line, then the headers of a new commit, then
// the text of the line
function group(commit: string, line: number, headers: string[] = []): string[] {
	return [`${commit} ${line} ${line} 1`, ...headers, `filename src/rate.cpp`, '\tint x = 0;'];
}

suite('Heat', () => {
	test('The blame gives the commit of each line, and the time and the summary of each commit. A line that is not committed has none', () => {
		const blame = parseBlame([
			...group(A, 1, ['author A', `author-time ${NOW - 100 * DAY}`, 'summary Add the rate']),
			...group(B, 2, ['author B', `author-time ${NOW - 2 * DAY}`, 'summary Fix the clamp of the rate']),
			...group(A, 3),
			...group(ZERO, 4, ['author Not Committed Yet', `author-time ${NOW}`, 'summary Version of src/rate.cpp from src/rate.cpp']),
		].join('\n'));
		assert.deepStrictEqual(blame.lines, [A, B, A, '']);
		assert.deepStrictEqual([...blame.commits.keys()], [A, B]);
		assert.deepStrictEqual(blame.commits.get(B), { time: NOW - 2 * DAY, summary: 'Fix the clamp of the rate' });
	});

	test('The risk adds the decisions, the depth, the writes, the threads, the costs in loops and the length, to a maximum of 25', () => {
		const small = buildHeat(inputs([fn('small', 1, 5, { decisions: 1 })])).functions[0];
		assert.deepStrictEqual([small.risk, small.reasons], [3, [{ group: 'risk', points: 3, text: '1 decision' }]]);

		const big = fn('solve', 10, 130, {
			decisions: 24, depth: 5, bodyLines: 120, allocationsInLoops: 1, copiesInLoops: 3,
			writes: [{ path: 'rate_', scope: 'member' }, { path: 'cache.size', scope: 'member' }, { path: 'g_count', scope: 'global' }, { path: 'out', scope: 'param' }],
		});
		const heat = buildHeat(inputs([big])).functions[0];
		assert.deepStrictEqual(heat.reasons.map((r) => [r.points, r.text]), [
			[10, '24 decisions'],
			[4, 'Writes shared state: rate_, cache.size, g_count and 1 more'],
			[3, 'Nesting depth of 5'],
			[3, 'In loops: 1 allocation, 3 copies'],
			[2, 'Long body: 120 lines'],
		]);
		assert.strictEqual(heat.risk, 22);

		// the threads: an unprotected access of data that two threads share gives 6 points, then the risk stops at 25
		const threads = {
			threads: [], captures: [], isTruncated: false, analysisMs: 0, cached: false,
			functions: [{ name: 'solve', qualifiedName: 'rate::solve', kind: 'function', file: FILE, line: 10, first: 11, last: 130, threads: [-1] }],
			items: [{
				key: 'jobs', label: 'jobs_', kind: 'member', type: 'int', isAtomic: false,
				refs: [
					{ file: FILE, line: 20, col: 1, len: 4, role: 'write', thread: -1, fn: 0, path: 'jobs_', sub: [], locks: [], order: {}, guards: [], via: [] },
					{ file: FILE, line: 40, col: 1, len: 4, role: 'read', thread: 0, fn: 1, path: 'jobs_', sub: [], locks: [], order: {}, guards: [], via: [] },
				],
			}],
		} as unknown as ThreadsModel;
		const shared = buildHeat(inputs([big], { threads })).functions[0];
		assert.ok(shared.reasons.some((r) => r.points === 6 && r.text === 'Data that threads share, with no protection: jobs_'), JSON.stringify(shared.reasons));
		assert.strictEqual(shared.risk, 25);

		// with a lock, the same data gives 3 points
		threads.items[0].refs[0].locks = ['mutex_'];
		const locked = buildHeat(inputs([big], { threads })).functions[0];
		assert.ok(locked.reasons.some((r) => r.points === 3 && r.text === 'Data that threads share, with a lock: jobs_'), JSON.stringify(locked.reasons));
	});

	test('The reach adds the include reach of the declaration and a virtual function', () => {
		const declared = fn('clamp', 1, 5, { declaration: { file: HEADER, line: 7 }, override: true, virtual: true });
		const local = fn('helper', 7, 9);
		const heat = buildHeat(inputs([declared, local], {
			includeReach: (file) => (file === HEADER ? { units: 30, total: 50 } : { units: 0, total: 50 }),
		}));
		assert.deepStrictEqual(heat.functions[0].reasons.map((r) => [r.group, r.points, r.text]), [
			['reach', 8, 'rate.hpp with the declaration is in 30 of 50 source files'],
			['reach', 2, 'Override of a virtual function'],
		]);
		assert.strictEqual(heat.functions[0].reach, 10);
		// a function of the source file only: no reach
		assert.deepStrictEqual([heat.functions[1].reach, heat.functions[1].reasons], [0, []]);
		// the reach has no callers, so the notice tells it, and no function is siloed
		assert.strictEqual(heat.isReachComplete, false);
		assert.match(heat.notices[0], /does not count the callers and the frame path yet/);
	});

	test('The history adds the commits, the fixes and a recent change of the lines of the function', () => {
		const blame = parseBlame([
			...group(A, 1, [`author-time ${NOW - 400 * DAY}`, 'summary Add the rate']),
			...group(B, 2, [`author-time ${NOW - 200 * DAY}`, 'summary Fix the clamp']),
			...group(C, 3, [`author-time ${NOW - 5 * DAY}`, 'summary Add debug output']),
			...group(A, 4),
			...group(ZERO, 5, [`author-time ${NOW}`, 'summary Version of src/rate.cpp from src/rate.cpp']),
		].join('\n'));
		const [old, all, changed] = buildHeat(inputs([fn('old', 1, 2), fn('all', 1, 4), fn('changed', 4, 5)], { blame })).functions;
		// "Add debug output" is no fix: the word is not "bug"
		assert.deepStrictEqual(all.reasons.map((r) => [r.points, r.text]), [
			[4, 'Changed in 3 commits'],
			[2, '1 commit that fixes a bug: "Fix the clamp"'],
			[2, 'Changed in the last 30 days'],
		]);
		assert.strictEqual(all.history, 8);
		assert.deepStrictEqual(old.reasons.map((r) => r.text), ['Changed in 2 commits', '1 commit that fixes a bug: "Fix the clamp"']);
		// a line that is not committed is a recent change
		assert.deepStrictEqual(changed.reasons.map((r) => r.text), ['Changed in 1 commit', 'Changes that are not committed']);
		// with no blame, the notice tells it
		assert.ok(buildHeat(inputs([fn('x', 1, 2)])).notices.some((n) => n.startsWith('No history')));
	});

	test('The bands and the flames come from the score', () => {
		assert.deepStrictEqual([0, 24, 25, 49, 50, 74, 75, 100].map(bandOf), ['cool', 'cool', 'warm', 'warm', 'hot', 'hot', 'veryHot', 'veryHot']);
		assert.deepStrictEqual([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(flamesOf), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
		const heat = buildHeat(inputs([fn('solve', 1, 200, { decisions: 30, depth: 6, bodyLines: 200 })])).functions[0];
		assert.deepStrictEqual([heat.score, heat.band, heat.flames, heat.nameLine], [15, 'cool', 1, 1]);
	});
});
