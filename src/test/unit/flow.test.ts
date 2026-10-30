import * as assert from 'assert';
import type { FlowModel } from '../../engine/client';
import { assignSlots, buildFlowView, findVariable, FlowLane, ordinalOf, toUtf16Column, toUtf8Column, variableAt } from '../../lenses/flow';

// A small model with the shape of the bestFit case: a declaration, a check, a read and an unchecked access.
// The engine counts lines from 1 and columns in UTF-8 bytes from 1.
const LINES = [
	'auto best = find();',
	'if (best) {',
	'  use(best->id);',
	'}',
	'log(best->id);',
];
const lineText = (line: number) => LINES[line];

function bestModel(): FlowModel {
	return {
		function: { name: 'f', qualifiedName: 'f', kind: 'function', range: { begin: { line: 1, col: 1 }, end: { line: 5, col: 15 } } },
		variables: [{ name: 'best', type: 'std::optional<Item>', storage: 'local', declRef: 0 }],
		refs: [
			{ var: 0, role: 'def', line: 1, col: 6, len: 4 },
			{ var: 0, role: 'check', line: 2, col: 5, len: 4 },
			{ var: 0, role: 'read', line: 3, col: 7, len: 4 },
			{ var: 0, role: 'read', line: 5, col: 5, len: 4, finding: 'unchecked optional access' },
		],
		edges: [[0, 1], [0, 2], [0, 3]],
	};
}

function lane(from: number, to: number, isProblem = false): FlowLane {
	return { from, to, color: 'definition', segments: [{ from, to, isProblem }], nodes: [] };
}

suite('Flow Lens', () => {
	test('Columns convert between UTF-8 bytes and UTF-16 code units', () => {
		// ä has 2 bytes, € has 3 bytes, and 😀 has 4 bytes and 2 UTF-16 code units
		const text = 'a = "ä€😀"; b';
		assert.strictEqual(toUtf16Column(text, 18), 12);
		assert.strictEqual(toUtf8Column(text, 12), 18);
		assert.strictEqual(toUtf16Column(text, 1), 0);
		assert.strictEqual(toUtf8Column(text, 0), 1);
	});

	test('The view marks the finding and draws a problem segment to it', () => {
		const view = buildFlowView(bestModel(), 0, lineText);
		assert.deepStrictEqual(view.marks.map((m) => [m.line, m.start, m.end, m.role]),
			[[0, 5, 9, 'def'], [1, 4, 8, 'check'], [2, 6, 10, 'read'], [4, 4, 8, 'read']]);
		assert.deepStrictEqual(view.findings, [{ line: 4, text: 'optional not checked here' }]);
		assert.deepStrictEqual(view.counts, { def: 1, write: 0, mayWrite: 0, check: 1, read: 2 });

		assert.strictEqual(view.lanes.length, 1);
		const [only] = view.lanes;
		assert.deepStrictEqual([only.from, only.to, only.color], [0, 4, 'definition']);
		assert.deepStrictEqual(only.nodes.map((n) => [n.line, n.color, n.isDef]),
			[[0, 'definition', true], [1, 'check', false], [2, 'read', false], [4, 'problem', false]]);
		assert.deepStrictEqual(only.segments.map((s) => [s.from, s.to, s.isProblem]), [[0, 1, false], [1, 2, false], [2, 4, true]]);
	});

	test('The variable at the cursor', () => {
		const model = bestModel();
		assert.strictEqual(variableAt(model, 2, 7, lineText), 0);
		assert.strictEqual(variableAt(model, 2, 10, lineText), 0);
		assert.strictEqual(variableAt(model, 2, 2, lineText), undefined);
		assert.strictEqual(variableAt(model, 3, 0, lineText), undefined);
	});

	test('A possible write is a ring on the lane of the declaration, not a lane', () => {
		const model: FlowModel = {
			...bestModel(),
			refs: [
				{ var: 0, role: 'def', line: 1, col: 6, len: 4 },
				{ var: 0, role: 'mayWrite', line: 2, col: 5, len: 4 },
				{ var: 0, role: 'read', line: 3, col: 7, len: 4 },
			],
			edges: [[0, 1], [0, 2], [1, 2]],
		};
		const view = buildFlowView(model, 0, lineText);
		assert.strictEqual(view.lanes.length, 1);
		assert.deepStrictEqual(view.lanes[0].nodes.map((n) => [n.line, n.color, n.isHollow]),
			[[0, 'definition', false], [1, 'write', true], [2, 'read', false]]);
	});

	test('Lanes that do not overlap share a slot, and a lane with a problem gets a slot first', () => {
		const slots = assignSlots([lane(0, 5), lane(2, 8), lane(6, 9), lane(3, 4, true)], 2);
		assert.deepStrictEqual(slots, [1, -1, 0, 0]);
	});

	test('Two variables with the same name have different ordinals', () => {
		const model: FlowModel = {
			...bestModel(),
			variables: [
				{ name: 'kw', type: 'int', storage: 'local', declRef: 0 },
				{ name: 'best', type: 'int', storage: 'local', declRef: 0 },
				{ name: 'kw', type: 'int', storage: 'local', declRef: 0 },
			],
		};
		assert.strictEqual(ordinalOf(model, 2), 1);
		assert.strictEqual(findVariable(model, 'kw', 1), 2);
		assert.strictEqual(findVariable(model, 'kw', 2), undefined);
	});
});
