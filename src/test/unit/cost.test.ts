import * as assert from 'assert';
import type { CostModel } from '../../engine/client';
import { ALL_COST_CATEGORIES, buildCostMarks, categoryOf, CostCategory, costCounts, functionItems } from '../../lenses/cost';
import { buildSideCost } from '../../side/costLayer';

// Two functions with items of the engine. The engine counts lines from 1.
function model(): CostModel {
	const fn = (name: string, begin: number, end: number) =>
		({ name, qualifiedName: `ns::${name}`, kind: 'function' as const, range: { begin: { line: begin, col: 1 }, end: { line: end, col: 1 } } });
	return {
		functions: [fn('a', 1, 10), fn('b', 12, 20)],
		items: [
			{ kind: 'copy', fn: 0, line: 3, col: 5, len: 4, text: 'copy: Big (64 B)', detail: 'd', pattern: 'copy|Big' },
			{ kind: 'destructor', fn: 0, line: 9, col: 1, len: 1, text: '~x', detail: 'd', pattern: 'destructor|X' },
			{ kind: 'destructor', fn: 0, line: 9, col: 1, len: 1, text: '~y', detail: 'd', pattern: 'destructor|Y' },
			{ kind: 'shadow', fn: 0, line: 5, col: 9, len: 1, text: 'hides x of line 2', detail: 'd', pattern: 'shadow|x' },
			{ kind: 'lookup', fn: 1, line: 14, col: 3, len: 10, text: '3 lookups of k in m', detail: 'd', pattern: 'lookup|map<int, int>',
				related: [{ line: 15, col: 3, len: 4 }, { line: 16, col: 3, len: 4 }] },
			{ kind: 'allocation', fn: 1, line: 18, col: 3, len: 12, text: 'can allocate: push_back', detail: 'd', pattern: 'allocation|push_back', heuristic: true },
		],
	};
}

const filter = (hidden: string[] = [], categories: CostCategory[] = ALL_COST_CATEGORIES) => ({ categories: new Set(categories), hidden: new Set(hidden) });

suite('Hidden C++', () => {
	test('Temporaries and shadowed names are in the category lifetime', () => {
		assert.strictEqual(categoryOf('shadow'), 'lifetime');
		assert.strictEqual(categoryOf('temporary'), 'lifetime');
		assert.strictEqual(categoryOf('copy'), 'copy');
	});

	test('The details column gets the items of the function at the cursor that show, in the sequence of the source', () => {
		assert.deepStrictEqual(functionItems(model(), filter(), { qualifiedName: 'ns::a', line: 1 }).items.map((i) => i.text),
			['copy: Big (64 B)', 'hides x of line 2', '~x', '~y']);
		const items = functionItems(model(), filter(['destructor|Y'], ['copy', 'lookup']), { qualifiedName: 'ns::a', line: 1 });
		assert.strictEqual(items.fn, 'a');
		assert.deepStrictEqual(items.items.map((i) => [i.line, i.category, i.text]), [[3, 'copy', 'copy: Big (64 B)']]);
	});

	test('With no function at the cursor, the details column gets no items', () => {
		assert.deepStrictEqual(functionItems(model(), filter()), { items: [] });
		assert.deepStrictEqual(functionItems(model(), filter(), { qualifiedName: 'ns::c', line: 30 }), { items: [] });
	});

	test('The side view gets the items with UTF-16 columns, the other lookups of a group, and the counts of the file', () => {
		// ä has 2 bytes, so the column 5 of the engine on line 3 is the UTF-16 column 3
		const lineText = (line: number) => (line === 2 ? 'ä' : '') + ' '.repeat(40);
		const marks = buildCostMarks(model(), filter(['destructor|Y'], ['copy', 'lookup', 'destructor']), lineText);
		assert.deepStrictEqual(marks.map((m) => [m.line, m.start, m.end, m.category, m.text]), [
			[3, 3, 7, 'copy', 'copy: Big (64 B)'],
			[9, 0, 1, 'destructor', '~x'],
			[14, 2, 12, 'lookup', '3 lookups of k in m'],
		]);
		assert.deepStrictEqual(marks[2].related, [{ line: 15, start: 2, end: 6 }, { line: 16, start: 2, end: 6 }]);
		const counts = costCounts(model(), filter(['destructor|Y'], ['copy']));
		assert.deepStrictEqual([counts.copy, counts.destructor, counts.lifetime, counts.lookup, counts.allocation, counts.move], [1, 1, 1, 1, 1, 0]);
	});

	test('The layer of the side view has the counts of the file, the switches, and the items of the function', () => {
		const f = filter([], ['copy', 'lookup']);
		const layer = {
			file: 'a.cpp', marks: buildCostMarks(model(), f, () => ' '.repeat(40)), counts: costCounts(model(), f), enabled: [...f.categories],
			...functionItems(model(), f, { qualifiedName: 'ns::b', line: 12 }), hidden: 0,
		};
		const side = buildSideCost(layer);
		assert.deepStrictEqual(side.categories.filter((c) => c.enabled).map((c) => `${c.id}:${c.count}`), ['copy:1', 'lookup:1']);
		assert.strictEqual(side.categories.find((c) => c.id === 'destructor')!.count, 2);
		assert.deepStrictEqual([side.fn, side.items.map((i) => i.text)], ['b', ['3 lookups of k in m']]);
		assert.deepStrictEqual(side.marks.map((m) => m.category), ['copy', 'lookup']);
	});
});
