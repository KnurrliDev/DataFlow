import * as assert from 'assert';
import type { MemberMetricsMember, MemberMetricsModel, MetricsFunction, ThreadsModel } from '../../engine/client';
import { bandOf, bandText, buildHeat, changedFunctions, flamesOf, heatFact, HeatInputs, hottestIn, parseBlame, unknownCallersText } from '../../lenses/heat';

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
		assert.deepStrictEqual([small.risk, small.reasons], [3, [{ group: 'risk', points: 3, text: '1 decision', id: 'decisions', value: 1 }]]);

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

	test('The types of the file get the facts of their data members, with the data that threads share, and no score', () => {
		const members: MemberMetricsMember[] = [
			{
				name: 'jobs_', line: 4, type: 'int', readers: 2, writers: 1, files: 2, users: [{ name: 'rate::solve', file: FILE, line: 20, isWrite: true }],
				frame: { function: 'rate::solve', reason: 'called in the main loop of main', calls: 1 },
			},
			{ name: 's_count', line: 5, type: 'int', isStatic: true, readers: 0, writers: 0, files: 0, users: [] },
		];
		const types: MemberMetricsModel = {
			callGraph: { state: 'ready' },
			types: [{ name: 'Pool', qualifiedName: 'rate::Pool', kind: 'class', line: 3, first: 3, last: 9, members }],
		};
		// two threads use jobs_ with no lock. The item of the threads has the declaration of the member
		const ref = (thread: number) => ({ file: FILE, line: 20, col: 1, len: 5, role: 'write', thread, fn: 0, path: 'jobs_', sub: [], locks: [] as string[], order: {}, guards: [], via: [] });
		const threads = {
			threads: [], captures: [], isTruncated: false, analysisMs: 0, cached: false, functions: [],
			items: [{ key: 'jobs', label: 'jobs_', kind: 'member', type: 'int', isAtomic: false, decl: { file: FILE, line: 4, col: 5, len: 5 }, refs: [ref(-1), ref(0)] }],
		} as unknown as ThreadsModel;
		const heat = buildHeat(inputs([], { types, threads, includeReach: (f) => (f === FILE ? { units: 3, total: 9 } : undefined) }));
		assert.deepStrictEqual(heat.types, [{
			name: 'rate::Pool', kind: 'class', line: 3, first: 3, last: 9, includeReach: { units: 3, total: 9 }, isReachComplete: true,
			members: [
				{
					name: 'jobs_', line: 4, type: 'int', isStatic: false, readers: 2, writers: 1, files: 2,
					users: [{ function: 'rate::solve', file: FILE, line: 20, isWrite: true }],
					framePath: { function: 'rate::solve', reason: 'called in the main loop of main', calls: 1 }, shared: 'unprotected',
				},
				{ name: 's_count', line: 5, type: 'int', isStatic: true, readers: 0, writers: 0, files: 0, users: [] },
			],
		}]);

		// with a lock on each access, the member is shared with a lock. With no complete call graph, the members have no
		// users
		for (const r of threads.items[0].refs) {
			r.locks = ['mutex_'];
		}
		const scanning = buildHeat(inputs([], {
			threads, types: { callGraph: { state: 'scanning' }, types: [{ ...types.types[0], members: [{ name: 'jobs_', line: 4, type: 'int' }] }] },
		}));
		assert.deepStrictEqual([scanning.types[0].isReachComplete, scanning.types[0].members], [false, [{ name: 'jobs_', line: 4, type: 'int', isStatic: false, shared: 'locked' }]]);
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
		// with no call graph, the notice tells it, and no function is siloed
		assert.strictEqual(heat.isReachComplete, false);
		assert.match(heat.notices[0], /^The call graph is not complete/);
		assert.ok(heat.functions.every((f) => !f.isSiloed));
	});

	test('The reach adds the frame path, a call in a loop on it, the callers and their files. A siloed function gets half of its risk and history', () => {
		const frame = { reason: 'override of QWidget::paintEvent', path: ['View::paintEvent', 'draw'], isInLoop: true };
		const hot = fn('shade', 1, 5, { decisions: 1, reach: { callers: 3, transitiveCallers: 40, callerFiles: 7, frame } });
		const root = fn('paintEvent', 7, 9, {
			reach: { callers: 0, transitiveCallers: 0, callerFiles: 0, frame: { reason: frame.reason, path: [], isInLoop: false } },
		});
		const deep = fn('leaf', 11, 12, {
			reach: {
				callers: 1, transitiveCallers: 1, callerFiles: 1,
				frame: { reason: 'called in the main loop of main', path: ['frame', 'a', 'b', 'c', 'd'], isInLoop: false },
			},
		});
		const siloed = fn('solve', 14, 40, { decisions: 24, reach: { callers: 1, transitiveCallers: 1, callerFiles: 0 } });
		const core = fn('execute', 42, 50, { reach: { callers: 2, transitiveCallers: 1000, isCapped: true, callerFiles: 50 } });
		const heat = buildHeat(inputs([hot, root, deep, siloed, core]));
		// the transitive callers give the points: 40 functions reach shade() through calls, and 3 of them call it directly
		assert.deepStrictEqual(heat.functions[0].reasons.map((r) => [r.group, r.points, r.text]), [
			['reach', 40, 'On the frame path: View::paintEvent (override of QWidget::paintEvent), then draw, then rate::shade'],
			['reach', 10, 'A caller on the frame path calls it in a loop'],
			['reach', 10, '40 functions call it, 3 of them directly'],
			['reach', 5, 'Callers in 7 other files'],
			['risk', 3, '1 decision'],
		]);
		assert.deepStrictEqual(heat.functions[4].reasons.map((r) => [r.points, r.text]),
			[[10, '1000 or more functions call it, 2 of them directly'], [5, 'Callers in 50 other files']]);
		// the reach stops at 60
		assert.deepStrictEqual([heat.functions[0].reach, heat.functions[0].score, heat.functions[0].band], [60, 63, 'hot']);
		assert.deepStrictEqual(heat.functions[1].reasons.map((r) => r.text), ['Runs in each frame: override of QWidget::paintEvent']);
		// a long path shows the frame function, the number of the other functions and the last two
		assert.strictEqual(heat.functions[2].reasons[0].text,
			'On the frame path: frame (called in the main loop of main), then 3 more, then d, then rate::leaf');
		// 1 caller gives 2 points. The reach is less than 10, thus the 10 points of the decisions count half
		const s = heat.functions[3];
		assert.deepStrictEqual([s.reach, s.risk, s.isSiloed, s.score], [2, 5, true, 7]);
		assert.strictEqual(heat.isReachComplete, true);
		assert.ok(!heat.notices.some((n) => n.includes('call graph')), JSON.stringify(heat.notices));
	});

	test('A function that is newer than the scan has no reach, and the notice tells the state of the call graph', () => {
		const heat = buildHeat(inputs([
			fn('old', 1, 2, { reach: { callers: 1, transitiveCallers: 1, callerFiles: 0 } }), fn('added', 4, 5, { reach: null, decisions: 24 }),
		]));
		assert.match(heat.notices[0], /^The call graph has no data for 1 function of the file/);
		// a function with no node in the graph is not siloed
		assert.deepStrictEqual([heat.functions[1].isSiloed, heat.functions[1].risk], [false, 10]);
		assert.strictEqual(heat.isReachComplete, false);
		const scanning = buildHeat(inputs([fn('x', 1, 2)], { callGraph: { state: 'scanning' } }));
		assert.match(scanning.notices[0], /^The scan of the call graph runs/);
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
		// the signals of the history: the number of the commits, the summaries of the fixes, and the kind of the change
		assert.deepStrictEqual(all.reasons.map((r) => [r.id, r.value]), [['commits', 3], ['fixes', ['Fix the clamp']], ['recent', 'recent']]);
		assert.deepStrictEqual(changed.reasons.map((r) => [r.id, r.value]), [['commits', 1], ['recent', 'uncommitted']]);
		// with no blame, the notice tells it
		assert.ok(buildHeat(inputs([fn('x', 1, 2)])).notices.some((n) => n.startsWith('No history')));
	});

	test('The hottest function of a range of lines, and the changed functions of changed lines, the hottest first', () => {
		const heat = buildHeat(inputs([
			fn('setup', 1, 10, { decisions: 24 }), fn('solve', 12, 30, { decisions: 3, reach: { callers: 1, transitiveCallers: 40, callerFiles: 2 } }), fn('log', 32, 33),
		]));
		const [setup, solve, log] = heat.functions;
		assert.ok(setup.score > log.score && solve.score > setup.score, JSON.stringify(heat.functions.map((f) => f.score)));
		assert.strictEqual(hottestIn(heat, 5, 20)?.name, 'solve');
		assert.strictEqual(hottestIn(heat, 31, 31), undefined);
		assert.deepStrictEqual(changedFunctions(heat, [2, 33, 40]).map((f) => f.name), ['setup', 'log']);
		// the facts for a model: the reasons with the most points first, at most three
		const fact = heatFact(solve);
		assert.deepStrictEqual([fact.function, fact.lines, fact.score, fact.band], ['rate::solve', [12, 30], solve.score, bandText(solve.band)]);
		assert.deepStrictEqual(fact.reasons, solve.reasons.slice().sort((a, b) => b.points - a.points).slice(0, 3).map((r) => `${r.text} (+${r.points} ${r.group})`));
	});

	test('Each reason gives the id and the measure of its signal, and each function tells if its reach is complete', () => {
		const frame = { reason: 'override of QWidget::paintEvent', path: ['View::paintEvent', 'draw'], isInLoop: true };
		const hot = fn('shade', 1, 60, {
			decisions: 3, depth: 4, bodyLines: 60, allocationsInLoops: 1, override: true, declaration: { file: HEADER, line: 3 },
			writes: [{ path: 'rate_', scope: 'member' }], reach: { callers: 3, transitiveCallers: 40, callerFiles: 7, frame },
		});
		const threads = {
			threads: [], captures: [], isTruncated: false, analysisMs: 0, cached: false,
			functions: [{ name: 'shade', qualifiedName: 'rate::shade', kind: 'function', file: FILE, line: 1, first: 2, last: 60, threads: [-1] }],
			items: [{
				key: 'jobs', label: 'jobs_', kind: 'member', type: 'int', isAtomic: false,
				refs: [
					{ file: FILE, line: 20, col: 1, len: 4, role: 'write', thread: -1, fn: 0, path: 'jobs_', sub: [], locks: ['mutex_'], order: {}, guards: [], via: [] },
					{ file: FILE, line: 40, col: 1, len: 4, role: 'read', thread: 0, fn: 0, path: 'jobs_', sub: [], locks: ['mutex_'], order: {}, guards: [], via: [] },
				],
			}],
		} as unknown as ThreadsModel;
		const heat = buildHeat(inputs([hot, fn('added', 62, 63, { reach: null })], {
			threads, includeReach: (file) => (file === HEADER ? { units: 30, total: 50 } : undefined),
		}));
		const signals = Object.fromEntries(heat.functions[0].reasons.map((r) => [r.id, r.value]));
		assert.deepStrictEqual(signals, {
			framePath: { reason: 'override of QWidget::paintEvent', path: ['View::paintEvent', 'draw'], calls: 2, isInLoop: true },
			frameLoop: true,
			callers: { direct: 3, transitive: 40, isCapped: false },
			callerFiles: 7,
			includeReach: { file: HEADER, units: 30, total: 50 },
			virtual: 'override',
			decisions: 3,
			depth: 4,
			writes: ['rate_'],
			sharedLocked: ['jobs_'],
			loopCosts: { allocations: 1, copies: 0 },
			length: 60,
		});
		// each reason has its signal, and the signal does not change the text or the points
		assert.ok(heat.functions[0].reasons.every((r) => typeof r.id === 'string' && r.points > 0 && r.text.length > 0));
		// the function that is newer than the scan has no reach yet
		assert.deepStrictEqual(heat.functions.map((f) => f.isReachComplete), [true, false]);
		assert.deepStrictEqual(heat.functions.map((f) => heatFact(f).isReachComplete), [true, false]);
	});

	test('Callers that the graph cannot see stop the half points, a frame path past the limit gives no points, and the tests give a reason', () => {
		const slot = fn('onTimer', 1, 30, {
			decisions: 24, reach: { callers: 0, transitiveCallers: 0, callerFiles: 0, unknownCallers: { cause: 'slot', via: 'a slots section', file: FILE, line: 1 } },
		});
		const plain = fn('helper', 32, 60, { decisions: 24, reach: { callers: 0, transitiveCallers: 0, callerFiles: 0 } });
		const deep = fn('leaf', 62, 63, {
			reach: {
				callers: 1, transitiveCallers: 11, callerFiles: 0,
				frame: { reason: 'called in the main loop of main', path: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'], isInLoop: true, calls: 9, isPastLimit: true },
				tests: { functions: 2, files: ['/repo/tests/test_rate.cpp', '/repo/tests/test_more.cpp'] },
			},
		});
		const heat = buildHeat(inputs([slot, plain, deep]));
		const [s, p, d] = heat.functions;
		// the same decisions: the slot is not siloed, and the plain function gets half of its risk
		assert.deepStrictEqual([s.isSiloed, s.risk, p.isSiloed, p.risk], [false, 10, true, 5]);
		assert.deepStrictEqual(s.reasons[0], {
			group: 'reach', points: 0, text: 'Callers that the call graph cannot see: Qt can call it as a slot',
			id: 'reachUnknown', value: { cause: 'slot', via: 'a slots section', file: FILE, line: 1 },
		});
		assert.deepStrictEqual(s.reachUnknown, { cause: 'slot', text: 'Callers that the call graph cannot see: Qt can call it as a slot' });
		assert.strictEqual(unknownCallersText({ cause: 'address', via: 'install', file: FILE, line: 3 }),
			'Callers that the call graph cannot see: install uses the address of the function, so a pointer or a std::function can call it');
		assert.strictEqual(unknownCallersText({ cause: 'libraryOverride', via: 'QObject::event', file: FILE, line: 3 }),
			'Callers that the call graph cannot see: a library can call this override of QObject::event');
		assert.strictEqual(unknownCallersText({ cause: 'slot', via: 'the signal QPushButton::clicked', file: FILE, line: 3 }),
			'Callers that the call graph cannot see: Qt calls it through the signal QPushButton::clicked');

		// the frame path after 9 calls gives no points, also not for the loop. The callers give their points
		assert.deepStrictEqual(d.reasons.map((r) => [r.id, r.points]), [['callers', 7], ['framePath', 0], ['tests', 0]]);
		assert.match(d.reasons[1].text, /^On a frame path after 9 calls: c1 \(called in the main loop of main\), then 7 more, then c9, then rate::leaf\. The points stop after 8 calls\./);
		assert.strictEqual(d.reasons[2].text, '2 test functions reach it: test_rate.cpp, test_more.cpp');
		assert.deepStrictEqual(d.tests, { functions: 2, files: ['/repo/tests/test_rate.cpp', '/repo/tests/test_more.cpp'] });
		assert.ok(heat.notices.some((n) => n.startsWith('1 function of the file is on a frame path after more than 8 calls.')), JSON.stringify(heat.notices));
	});

	test('The bands and the flames come from the score', () => {
		assert.deepStrictEqual([0, 24, 25, 49, 50, 74, 75, 100].map(bandOf), ['cool', 'cool', 'warm', 'warm', 'hot', 'hot', 'veryHot', 'veryHot']);
		assert.deepStrictEqual([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(flamesOf), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
		const heat = buildHeat(inputs([fn('solve', 1, 200, { decisions: 30, depth: 6, bodyLines: 200 })])).functions[0];
		assert.deepStrictEqual([heat.score, heat.band, heat.flames, heat.nameLine], [15, 'cool', 1, 1]);
	});
});
