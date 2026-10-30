import * as assert from 'assert';
import type { LogicModel } from '../../engine/client';
import { buildControls, Choices, dominators, evaluatePath, moveChoices, pathChoices, pathSteps, whyLine } from '../../logic/paths';

// A small CFG for this function. Block ids are in the comments.
//  1  void f(int s, bool a, bool b) {
//  2    int *p = get();                 // 6 (with line 3)
//  3    if (s == 1) {
//  4      ev("one");                    // 5
//  5    } else if (s == 2) {            // 4
//  6      if (a && b) {                 // 3 is a, 2 is b
//  7        ev("ab");                   // 8
//  8      }
//  9      ev("two");                    // 9
// 10    }
// 11    if (!p) return;                 // 1 is the condition, 10 is the return
// 12    use(*p);                        // 11
// 13  }                                 // 0 is the exit, 7 is the entry
function model(checks = [{ block: 1, succ: 1 }]): LogicModel {
	const block = (succs: number[], lines: [number, number][] = []) => ({ succs, lines });
	return {
		function: { name: 'f', qualifiedName: 'f', kind: 'function', range: { begin: { line: 1, col: 1 }, end: { line: 13, col: 1 } } },
		entry: 7,
		exit: 0,
		blocks: [
			block([]), block([10, 11], [[11, 11]]), block([8, 9], [[6, 6]]), block([2, 9], [[6, 6]]), block([3, 1], [[5, 5]]),
			block([1], [[4, 4]]), block([5, 4], [[2, 3]]), block([6]), block([9], [[7, 7]]), block([1], [[9, 9]]),
			block([0], [[11, 11]]), block([0], [[12, 12]]),
		],
		decisions: [
			{ kind: 'if', block: 6, condBlocks: [], text: 's == 1', line: 3, col: 7, parent: -1,
				branches: [{ label: 'yes', succ: 0, first: 3, last: 5 }, { label: 'no', succ: 1, first: 5, last: 10 }] },
			{ kind: 'if', block: 4, condBlocks: [], text: 's == 2', line: 5, col: 14, parent: 0, parentBranch: 'no',
				branches: [{ label: 'yes', succ: 0, first: 5, last: 10 }, { label: 'no', succ: 1 }] },
			{ kind: 'if', block: 2, condBlocks: [3], text: 'a && b', line: 6, col: 9, parent: 1, parentBranch: 'yes',
				branches: [{ label: 'yes', succ: 0, first: 6, last: 8 }, { label: 'no', succ: 1 }] },
			{ kind: 'if', block: 1, condBlocks: [], text: '!p', line: 11, col: 7, parent: -1,
				branches: [{ label: 'yes', succ: 0, first: 11, last: 11 }, { label: 'no', succ: 1 }] },
		],
		chains: [{ subject: 's', items: [{ decision: 0, value: '1' }, { decision: 1, value: '2' }], hasElse: false }],
		events: [
			{ block: 5, line: 4, col: 8, len: 5, function: 'ev', label: 'one' },
			{ block: 8, line: 7, col: 10, len: 4, function: 'ev', label: 'ab' },
			{ block: 9, line: 9, col: 8, len: 5, function: 'ev', label: 'two' },
		],
		nullable: [{ var: 'p', source: 'get', at: { block: 6, line: 2, col: 8, len: 1 }, derefs: [{ block: 11, line: 12, col: 7, len: 2 }], checks }],
	};
}

suite('Logic Map paths', () => {
	test('The chain is one control, and the nested decision belongs to one of its values', () => {
		const controls = buildControls(model());
		assert.deepStrictEqual(controls.map((c) => [c.key, c.options.join('|'), c.parent ? `${c.parent.key}=${c.parent.option}` : '']), [
			['chain:s#0', 'any|1|2|other', ''],
			['if:a && b#0', 'any|yes|no', 'chain:s#0=2'],
			['if:!p#0', 'any|yes|no', ''],
		]);
	});

	test('With no choice, all lines run, and two events can follow on one path', () => {
		const m = model();
		const path = evaluatePath(m, buildControls(m), {});
		assert.deepStrictEqual(path.dead, []);
		assert.deepStrictEqual(path.events.map((e) => m.events[e].label), ['one', 'ab', 'two']);
		assert.deepStrictEqual(path.pairs.map((p) => [m.events[p.first].label, m.events[p.second].label]), [['ab', 'two']]);
	});

	test('A value of the chain makes the other items dead, also the braces of their branches', () => {
		const m = model();
		const path = evaluatePath(m, buildControls(m), { 'chain:s#0': '1' });
		assert.deepStrictEqual(path.dead, [5, 6, 7, 8, 9, 10]);
		assert.deepStrictEqual(path.events.map((e) => m.events[e].label), ['one']);
		assert.deepStrictEqual(path.pairs, []);
	});

	test('"no" for a && b also removes the short-circuit edge to the body', () => {
		const m = model();
		const controls = buildControls(m);
		const no = evaluatePath(m, controls, { 'chain:s#0': '2', 'if:a && b#0': 'no' });
		assert.deepStrictEqual(no.dead, [4, 7, 8]);
		assert.deepStrictEqual(no.events.map((e) => m.events[e].label), ['two']);

		const yes = evaluatePath(m, controls, { 'chain:s#0': '2', 'if:a && b#0': 'yes' });
		assert.deepStrictEqual(yes.succs[3], [2]);
		assert.deepStrictEqual(yes.pairs.map((p) => [m.events[p.first].label, m.events[p.second].label]), [['ab', 'two']]);
	});

	test('A dereference after a null check gets no warning, and a dereference with no check gets one', () => {
		const checked = model();
		assert.deepStrictEqual(evaluatePath(checked, buildControls(checked), {}).nullWarnings, []);
		const unchecked = model([]);
		assert.deepStrictEqual(evaluatePath(unchecked, buildControls(unchecked), {}).nullWarnings, [{ nullable: 0, deref: 0 }]);
	});

	test('Why a line runs: the decisions that control it, with the outer decisions first', () => {
		const m = model();
		const controls = buildControls(m);
		const dom = dominators(m);
		const why = (line: number) => whyLine(m, controls, dom, line)?.map((w) => `${w.text}=${w.option}`);
		assert.deepStrictEqual(why(7), ['s=2', 'a && b=yes']);
		assert.deepStrictEqual(why(9), ['s=2']);
		assert.deepStrictEqual(why(12), ['!p=no']);
		assert.deepStrictEqual(why(8), ['s=2', 'a && b=yes']);

		// Line 11 comes after the chain. All paths reach it, so it needs no choice.
		assert.deepStrictEqual(why(11), []);
	});

	test('The default path runs the most lines: the longest value of the chain, and no early return', () => {
		const m = model();
		const controls = buildControls(m);
		assert.deepStrictEqual(pathChoices(m, controls, {}), { 'chain:s#0': '2', 'if:a && b#0': 'yes', 'if:!p#0': 'no' });
		// a choice of the user wins. The decision in the branch of the value 2 gets its first option, because the path
		// cannot reach it
		assert.deepStrictEqual(pathChoices(m, controls, { 'chain:s#0': '1' }), { 'chain:s#0': '1', 'if:a && b#0': 'yes', 'if:!p#0': 'no' });
	});

	test('The steps of the path: the decisions with their options, the events, a return and the end of the function', () => {
		const m: LogicModel = { ...model(), returns: [{ block: 10, line: 11, col: 11, len: 6, value: '' }] };
		const controls = buildControls(m);
		const stepsOf = (chosen: Choices) => {
			const choices = pathChoices(m, controls, chosen);
			return pathSteps(m, controls, choices, evaluatePath(m, controls, choices)).map((s) => [s.kind, s.line, s.value ?? s.text, s.problem ?? '']);
		};
		assert.deepStrictEqual(stepsOf({}), [
			['decision', 3, '2', ''], ['decision', 6, 'yes', ''], ['event', 7, 'ab', ''],
			['event', 9, 'two', 'second event on this path, after ab (line 7)'], ['decision', 11, 'no', ''], ['end', 13, '', ''],
		]);
		// the early return: the path gets to the return on line 11, and not to the end of the function
		assert.deepStrictEqual(stepsOf({ 'if:!p#0': 'yes' }).slice(-2), [['decision', 11, 'yes', ''], ['return', 11, '', '']]);
	});

	test('An effect on the path is a step. An effect in a branch that the path cannot enter is not', () => {
		const m: LogicModel = {
			...model(),
			effects: [
				{ block: 5, line: 4, col: 3, len: 4, target: 'out', action: 'push_back', kind: 'parameter' },
				{ block: 9, line: 9, col: 3, len: 5, target: 'total', action: '+=', kind: 'member' },
				{ block: 11, line: 12, col: 3, len: 5, target: 'count', action: '++', kind: 'global' },
				{ block: 11, line: 12, col: 14, len: 4, target: 'last', action: '=', kind: 'member' },
			],
		};
		const controls = buildControls(m);
		const effects = (chosen: Choices) => {
			const choices = pathChoices(m, controls, chosen);
			return pathSteps(m, controls, choices, evaluatePath(m, controls, choices)).filter((s) => s.kind === 'effect')
				.map((s) => `${s.line} ${s.text}: ${s.changes!.map((c) => `${c.target} ${c.action} ${c.kind}`).join(', ')}`);
		};
		// the two changes on line 12 have no other step between them, so they are one step
		assert.deepStrictEqual(effects({}), ['9 total: total += member', '12 count, last: count ++ global, last = member']);
		assert.deepStrictEqual(effects({ 'chain:s#0': '1' }), ['4 out: out push_back parameter', '12 count, last: count ++ global, last = member']);
	});

	test('An event that the path can send again, for example in a loop, is a pair with itself', () => {
		// 1 void g(int n) {
		// 2   for (int i = 0; i < n; ++i) {   // 3 is the condition, 1 is ++i
		// 3     ev("tick");                    // 2
		// 4   }
		// 5 }                                  // 0 is the exit, 4 is the entry
		const m: LogicModel = {
			function: { name: 'g', qualifiedName: 'g', kind: 'function', range: { begin: { line: 1, col: 1 }, end: { line: 5, col: 1 } } },
			entry: 4,
			exit: 0,
			blocks: [{ succs: [], lines: [] }, { succs: [3], lines: [[2, 2]] }, { succs: [1], lines: [[3, 3]] }, { succs: [2, 0], lines: [[2, 2]] }, { succs: [3], lines: [] }],
			decisions: [{ kind: 'loop', block: 3, condBlocks: [], text: 'i < n', line: 2, col: 19, parent: -1,
				branches: [{ label: 'enter', succ: 0, first: 2, last: 4 }, { label: 'skip', succ: 1 }] }],
			chains: [],
			events: [{ block: 2, line: 3, col: 8, len: 6, function: 'ev', label: 'tick' }],
			nullable: [],
		};
		const controls = buildControls(m);
		const steps = (chosen: Choices) => {
			const choices = pathChoices(m, controls, chosen);
			const path = evaluatePath(m, controls, choices);
			return { pairs: path.pairs, events: pathSteps(m, controls, choices, path).filter((s) => s.kind === 'event').map((s) => s.problem) };
		};
		assert.deepStrictEqual(steps({}), { pairs: [{ first: 0, second: 0 }], events: ['this event can run again on this path, in a loop'] });
		assert.deepStrictEqual(steps({ 'loop:i < n#0': 'skip' }), { pairs: [], events: [] });
	});

	test('Why a line in a switch with fallthrough runs: one of the cases that reach it', () => {
		//  1 void h(int s) {
		//  2   switch (s) {      // 5
		//  3     case 1:         // 4
		//  4       a();
		//  5     case 2:         // 3: case 1 falls through to it
		//  6       b();
		//  7       break;
		//  8     case 3:         // 2
		//  9       c();
		// 10   }                 // 1 is after the switch
		// 11 }                   // 0 is the exit, 6 is the entry
		const m: LogicModel = {
			function: { name: 'h', qualifiedName: 'h', kind: 'function', range: { begin: { line: 1, col: 1 }, end: { line: 11, col: 1 } } },
			entry: 6,
			exit: 0,
			blocks: [
				{ succs: [], lines: [] }, { succs: [0], lines: [] }, { succs: [1], lines: [[9, 9]] }, { succs: [1], lines: [[6, 7]] },
				{ succs: [3], lines: [[4, 4]] }, { succs: [4, 3, 2, 1], lines: [[2, 2]] }, { succs: [5], lines: [] },
			],
			decisions: [{ kind: 'switch', block: 5, condBlocks: [], text: 's', line: 2, col: 11, parent: -1, branches: [
				{ label: '1', succ: 0, first: 3, last: 4 }, { label: '2', succ: 1, first: 5, last: 7 }, { label: '3', succ: 2, first: 8, last: 9 },
				{ label: 'no case', succ: 3 },
			] }],
			chains: [],
			events: [],
			nullable: [],
		};
		const controls = buildControls(m);
		const dom = dominators(m);
		const why = (line: number) => whyLine(m, controls, dom, line)?.map((w) => `${w.text}=${w.option}${w.options ? ` of ${w.options.join(',')}` : ''}`);
		assert.deepStrictEqual(why(6), ['s=1 of 1,2']);
		assert.deepStrictEqual(why(4), ['s=1']);
		assert.deepStrictEqual(why(9), ['s=3']);
	});

	test('A new model of the same function: the choices go to the controls at the same places, also after an edit of a condition', () => {
		const before = buildControls(model());
		const edited = model();
		edited.chains[0].items[1].value = '3';
		edited.decisions[2].text = 'a || b';
		const after = buildControls(edited);
		const choices = { 'chain:s#0': '2', 'if:a && b#0': 'no', 'if:!p#0': 'yes' };
		// the value 2 of the chain became 3: the option at the same place
		assert.deepStrictEqual(moveChoices(before, after, choices), { 'chain:s#0': '3', 'if:a || b#0': 'no', 'if:!p#0': 'yes' });

		// a control came or went: the places do not agree, so only the keys count
		assert.deepStrictEqual(moveChoices(before, after.slice(0, 2), choices), { 'chain:s#0': '3' });
	});
});
