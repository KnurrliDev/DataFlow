import * as assert from 'assert';
import type { StructureAccess, StructureModel, StructureStatement } from '../../engine/client';
import {
	blockData, mergeComments, ModelBlockInput, moveModelLayer, resolveComments, resolveNotes, restoreModelLayer, snapBlocks, storeModelLayer, structureSummary,
	TextChange,
} from '../../lenses/blocks';
import type { SideModel, SideModelBlock, SideModelExtra } from '../../side/protocol';

// A result of dataflow/structure with the shape of process() of the design study: the setup with an early return, a
// thread start, a block statement, an event, an if chain on the state with three branches, and the return. Lines from 1.
const stmt = (first: number, last: number, kind: StructureStatement['kind'], text: string, extra: Partial<StructureStatement> = {}): StructureStatement => ({
	first, last, kind, text, exits: [], events: [], threads: [], calls: [], ...extra,
});
const access = (line: number, path: string, role: StructureAccess['role'], scope: StructureAccess['scope']): StructureAccess => ({ line, col: 3, path, role, scope });

const MODEL: StructureModel = {
	function: { name: 'process', qualifiedName: 'power::process', kind: 'function', range: { begin: { line: 10, col: 1 }, end: { line: 58, col: 1 } } },
	statements: [
		stmt(11, 11, 'decl', 'auto &settings = state.settings;'),
		stmt(12, 12, 'decl', 'std::optional<Requests> requests;'),
		stmt(13, 15, 'if', 'state.items.empty()', { exits: [{ line: 14, kind: 'return' }] }),
		stmt(17, 20, 'if', 'charge.is_dirty && !state.future', { threads: [{ line: 18, via: 'tf::Executor::async', runs: 'solve' }] }),
		stmt(21, 30, 'block', '{', {
			exits: [{ line: 27, kind: 'return' }],
			body: [stmt(23, 23, 'decl', 'auto pv = site.pv;'), stmt(25, 25, 'expr', 'settings.grid2home = pv.feed;'), stmt(26, 26, 'expr', 'settings.mtr = mtr();'),
				stmt(27, 27, 'return', 'return {};', { exits: [{ line: 27, kind: 'return' }] })],
		}),
		stmt(32, 32, 'expr', 'shift(state, "", true);', { events: [{ line: 32, name: '' }] }),
		stmt(34, 55, 'if', 'state.state == PLANNING', {
			calls: [{ line: 38, name: 'create_charge' }, { line: 43, name: 'create_charge' }],
			exits: [{ line: 45, kind: 'return' }],
			branches: [
				{ first: 34, last: 41, label: 'state.state == PLANNING', statements: [stmt(35, 40, 'if', 'ready(state.future)', { calls: [{ line: 38, name: 'create_charge' }] })] },
				{ first: 42, last: 47, label: 'state.state == MOVING', statements: [stmt(43, 43, 'expr', 'create_charge(settings, charge);', { calls: [{ line: 43, name: 'create_charge' }] }),
					stmt(44, 44, 'expr', 'state.timer.reset();'), stmt(45, 45, 'return', 'return {};', { exits: [{ line: 45, kind: 'return' }] })] },
				{ first: 48, last: 55, label: 'else', statements: [stmt(49, 49, 'decl', 'auto data = taps();'), stmt(50, 51, 'if', '!data.empty()')] },
			],
		}),
		stmt(57, 57, 'return', 'return requests;', { exits: [{ line: 57, kind: 'return' }] }),
	],
	accesses: [
		access(11, 'settings', 'decl', 'local'), access(11, 'state.settings', 'read', 'param'),
		access(12, 'requests', 'decl', 'local'),
		access(13, 'state.items', 'read', 'param'),
		access(17, 'charge.is_dirty', 'read', 'param'), access(17, 'state.future', 'read', 'param'),
		access(18, 'state.future', 'write', 'param'), access(18, 'charge', 'readwrite', 'param'),
		access(23, 'pv', 'decl', 'local'), access(23, 'site.pv', 'read', 'param'),
		access(25, 'settings.grid2home', 'write', 'local'), access(25, 'pv.feed', 'read', 'local'),
		access(26, 'settings.mtr', 'write', 'local'),
		access(32, 'state', 'readwrite', 'param'),
		access(34, 'state.state', 'read', 'param'), access(35, 'state.future', 'read', 'param'),
		access(37, 'requests', 'write', 'local'), access(38, 'settings', 'read', 'local'), access(38, 'charge', 'readwrite', 'param'),
		access(42, 'state.state', 'read', 'param'), access(43, 'settings', 'read', 'local'), access(43, 'charge', 'readwrite', 'param'),
		access(44, 'state.timer', 'readwrite', 'param'),
		access(49, 'data', 'decl', 'local'), access(50, 'data', 'read', 'local'), access(51, 'state.pending', 'write', 'param'), access(51, 'data', 'read', 'local'),
		access(57, 'requests', 'read', 'local'),
	],
};

suite('Logical blocks of a model', () => {
	test('The blocks move to whole statements, and the children of an if chain get its branches', () => {
		const { blocks, problems } = snapBlocks(MODEL, [
			{ lines: [11, 15], title: 'Find the tariff plan', summary: 'Reads the settings.' },
			{ lines: [17, 20], title: 'Start the solver' },
			{ lines: [22, 29], title: 'Update the meters' },
			{ lines: [32, 32], title: 'Advance the state machine' },
			{
				lines: [34, 55], title: 'Run the current state', children: [
					{ lines: [34, 41], title: 'Planning' }, { lines: [43, 46], title: 'Moving' }, { lines: [48, 55], title: 'Other states' },
				],
			},
			{ lines: [57, 57], title: 'Return the commands' },
		]);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(blocks.map((b) => `${b.id} ${b.first}-${b.last} ${b.title}`), [
			'1 11-15 Find the tariff plan', '2 17-20 Start the solver', '3 21-30 Update the meters', '4 32-32 Advance the state machine',
			'5 34-55 Run the current state', '5a 34-41 Planning', '5b 42-47 Moving', '5c 48-55 Other states', '6 57-57 Return the commands',
		]);
		// the model gave 22-29, and the block statement is 21-30
		assert.deepStrictEqual(blocks[2].from, [22, 29]);
		assert.deepStrictEqual(blocks[6].from, [43, 46]);
		assert.strictEqual(blocks[0].from, undefined);
		assert.strictEqual(blocks[5].parent, '5');
		assert.strictEqual(blocks[5].level, 1);
		// each block has the function of the blocks
		assert.ok(blocks.every((b) => b.fn === 'power::process'), JSON.stringify(blocks.map((b) => b.fn)));
		assert.strictEqual(blocks[0].summary, 'Reads the settings.');
	});

	test('The blocks get ids in the sequence of the lines', () => {
		const { blocks, problems } = snapBlocks(MODEL, [{ lines: [57, 57], title: 'Return' }, { lines: [11, 12], title: 'Setup' }]);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(blocks.map((b) => `${b.id} ${b.title}`), ['1 Setup', '2 Return']);
	});

	test('Blocks that overlap after the move, and wrong arguments, are problems', () => {
		assert.match(snapBlocks(MODEL, [{ lines: [11, 17], title: 'A' }, { lines: [17, 20], title: 'B' }]).problems.join('\n'), /Blocks 1 \(11-20\) and 2 \(17-20\) overlap/);
		assert.match(snapBlocks(MODEL, [{ lines: [70, 80], title: 'A' }]).problems.join('\n'), /outside of the function \(10-58\)/);
		assert.match(snapBlocks(MODEL, [{ lines: [20, 11] as [number, number], title: 'A' }]).problems.join('\n'), /first <= last/);
		assert.match(snapBlocks(MODEL, [{ lines: [11, 12], title: ' ' }]).problems.join('\n'), /"title" must be a text/);
		assert.match(snapBlocks(MODEL, []).problems.join('\n'), /at least one block/);
		// six levels: the view shows five
		const nested = (level: number): ModelBlockInput => ({ lines: [34, 55], title: `L${level}`, ...(level < 6 ? { children: [nested(level + 1)] } : {}) });
		assert.match(snapBlocks(MODEL, [nested(1)]).problems.join('\n'), /Block 1a1a1: the view shows 5 levels of blocks/);
	});

	test('A child block can have children, and the ids of the levels alternate letters and numbers', () => {
		const { blocks, problems } = snapBlocks(MODEL, [{
			lines: [34, 55], title: 'Run the current state', children: [
				{ lines: [34, 41], title: 'Planning' },
				{ lines: [42, 47], title: 'Moving', children: [{ lines: [43, 44], title: 'Move' }, { lines: [45, 45], title: 'Stop' }] },
				{ lines: [48, 55], title: 'Other states', children: [{ lines: [50, 51], title: 'Check the data', children: [{ lines: [51, 51], title: 'Keep it' }] }] },
			],
		}]);
		assert.deepStrictEqual(problems, []);
		// a block before its children. The children of the branch 42-47 cover its statements
		assert.deepStrictEqual(blocks.map((b) => `${b.id} ${b.level} ${b.parent ?? '-'} ${b.first}-${b.last}`), [
			'1 0 - 34-55', '1a 1 1 34-41', '1b 1 1 42-47', '1b1 2 1b 43-44', '1b2 2 1b 45-45', '1c 1 1 48-55', '1c1 2 1c 50-51', '1c1a 3 1c1 51-51',
		]);
	});

	test('The data of a block: what goes in, what comes out, and the items', () => {
		const setup = blockData(MODEL, 11, 15);
		assert.deepStrictEqual(setup.ins, ['state.settings', 'state.items']);
		// requests goes out: line 37 writes it only in one branch, and line 57 reads it
		assert.deepStrictEqual(setup.outs, ['settings', 'requests']);
		assert.deepStrictEqual(setup.extra, [{ kind: 'exit', line: 14, text: 'return' }]);

		const start = blockData(MODEL, 17, 20);
		assert.deepStrictEqual(start.ins, ['charge.is_dirty', 'state.future', 'charge']);
		assert.deepStrictEqual(start.outs, ['state.future', 'charge']);
		assert.deepStrictEqual(start.extra, [{ kind: 'thread', line: 18, text: 'tf::Executor::async runs solve' }]);

		// a write of a field of a local variable goes out, because line 38 reads the variable
		assert.deepStrictEqual(blockData(MODEL, 21, 30).outs, ['settings.grid2home', 'settings.mtr']);
		assert.deepStrictEqual(blockData(MODEL, 32, 32).extra, [{ kind: 'event', line: 32, text: 'event' }]);
		assert.deepStrictEqual(blockData(MODEL, 42, 47).extra.map((e) => `${e.kind} ${e.line}`), ['call 43', 'exit 45']);
		// data is a local variable of the branch: it does not go out
		assert.deepStrictEqual(blockData(MODEL, 48, 55).outs, ['state.pending']);
	});

	test('A write goes out if a read outside of the block gets its value over the control flow', () => {
		const model: StructureModel = {
			function: { name: 'pick', qualifiedName: 'pick', kind: 'function', range: { begin: { line: 1, col: 1 }, end: { line: 14, col: 1 } } },
			statements: [stmt(2, 2, 'decl', 'int x = 0;'), stmt(3, 7, 'if', 'c'), stmt(8, 8, 'decl', 'int y = x, z = 0;'), stmt(9, 12, 'for', 'more()'),
				stmt(13, 13, 'return', 'return y;')],
			accesses: [
				{ ...access(2, 'x', 'decl', 'local'), reaches: [] },
				{ ...access(4, 'x', 'write', 'local'), reaches: [8] },
				{ ...access(6, 'x', 'write', 'local'), reaches: [8] },
				access(8, 'x', 'read', 'local'),
				{ ...access(8, 'y', 'decl', 'local'), reaches: [13] },
				{ ...access(8, 'z', 'decl', 'local'), reaches: [10] },
				access(10, 'z', 'read', 'local'),
				{ ...access(11, 'z', 'write', 'local'), reaches: [10] },
				access(13, 'y', 'read', 'local'),
			],
		};
		const noLines = { ...model, accesses: model.accesses.map((a) => ({ ...a, reaches: undefined })) };
		// each branch writes x again, so the value of line 2 does not go out. The rule with no lines puts x out
		assert.deepStrictEqual(blockData(model, 2, 2).outs, []);
		assert.deepStrictEqual(blockData(noLines, 2, 2).outs, ['x']);
		assert.deepStrictEqual(blockData(model, 3, 7).outs, ['x']);
		// the next turn of the loop reads z on line 10, before the block of line 11. No later line reads z
		assert.deepStrictEqual(blockData(model, 11, 11).outs, ['z']);
		assert.deepStrictEqual(blockData(noLines, 11, 11).outs, []);
	});

	test('Notes on lines and on blocks', () => {
		const { blocks } = snapBlocks(MODEL, [{ lines: [34, 55], title: 'Run', children: [{ lines: [34, 41], title: 'P' }, { lines: [42, 47], title: 'M' }] }]);
		const { notes, problems } = resolveNotes([
			{ lines: [17, 17], kind: 'problem', note: 'reads is_dirty while the solver can write it' },
			{ block: '1b', kind: 'warn', note: 'safe only if no solver runs' },
			{ lines: [57, 57], note: 'the result' },
		], blocks, [1, 60]);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(notes.map((n) => `${n.first}-${n.last} ${n.kind}${n.block ? ` ${n.block}` : ''}`), ['17-17 problem', '42-47 warning 1b', '57-57 info']);

		assert.match(resolveNotes([{ block: '9', kind: 'info', note: 'x' }], blocks, [1, 60]).problems.join('\n'), /no block 9. The blocks are 1, 1a, 1b/);
		assert.match(resolveNotes([{ block: '1', kind: 'info', note: 'x' }], [], [1, 60]).problems.join('\n'), /Call show_blocks first/);
		assert.match(resolveNotes([{ lines: [3, 4], kind: 'info', note: '' }], blocks, [1, 60]).problems.join('\n'), /"note" must be a text/);
		assert.match(resolveNotes([{ lines: [70, 80], kind: 'info', note: 'x' }], blocks, [1, 60]).problems.join('\n'), /outside of the file/);
	});

	test('The children of an if with no else cover the statements of its one branch', () => {
		const model: StructureModel = {
			...MODEL,
			accesses: [],
			statements: [stmt(11, 20, 'if', 'ready', {
				branches: [{
					first: 11, last: 20, label: 'ready',
					statements: [stmt(12, 12, 'decl', 'auto a = 1;'), stmt(13, 19, 'for', 'i < n', { body: [stmt(14, 14, 'expr', 'f();'), stmt(15, 18, 'if', 'x')] })],
				}],
			})],
		};
		const { blocks, problems } = snapBlocks(model, [{
			lines: [11, 20], title: 'If ready', children: [{ lines: [12, 12], title: 'Set a' }, { lines: [14, 18], title: 'Loop', children: [{ lines: [15, 18], title: 'Check x' }] }],
		}]);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(blocks.map((b) => `${b.id} ${b.first}-${b.last}`), ['1 11-20', '1a 12-12', '1b 13-19', '1b1 15-18']);
	});

	test('A note on a block of one of two functions with the same ids needs the function', () => {
		const both = [
			...snapBlocks(MODEL, [{ lines: [11, 15], title: 'A' }], 'power::process').blocks,
			...snapBlocks(MODEL, [{ lines: [17, 20], title: 'B' }], 'power::other').blocks,
		];
		assert.match(resolveNotes([{ block: '1', kind: 'info', note: 'x' }], both, [1, 60]).problems.join('\n'),
			/block 1 is in power::process\(\) and power::other\(\)\. Give "function"/);
		const { notes, problems } = resolveNotes([{ block: '1', function: 'other', kind: 'info', note: 'x' }], both, [1, 60]);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual([notes[0].first, notes[0].last, notes[0].block, notes[0].blockFn], [17, 20, '1', 'power::other']);
		assert.match(resolveNotes([{ block: '2', kind: 'info', note: 'x' }], both, [1, 60]).problems.join('\n'),
			/The blocks are 1 in power::process\(\); 1 in power::other\(\)/);
	});

	test('Comments on single lines: one comment for each line, in a color of the palette or in no color', () => {
		const { comments, problems } = resolveComments([
			{ line: 32, text: 'advance the  state\n machine', color: 'Purple' },
			{ line: 11, text: 'the settings' },
		], [1, 60]);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(comments, [{ line: 11, text: 'the settings' }, { line: 32, text: 'advance the state machine', color: 'purple' }]);
		assert.match(resolveComments([{ line: 11, text: 'a' }, { line: 11, text: 'b' }], [1, 60]).problems.join('\n'), /Comments 1 and 2 are on line 11/);
		assert.match(resolveComments([{ line: 11, text: 'a', color: 'pink' }], [1, 60]).problems.join('\n'), /"color" must be one of blue, green/);
		assert.match(resolveComments([{ line: 70, text: 'a' }], [1, 60]).problems.join('\n'), /"line" must be a line of the file \(1-60\)/);
		assert.match(resolveComments([{ line: 11, text: ' ' }], [1, 60]).problems.join('\n'), /"text" must be a text/);
		assert.match(resolveComments([], [1, 60]).problems.join('\n'), /at least one comment/);
		assert.strictEqual(resolveComments([{ line: 11, text: 'x'.repeat(300) }], [1, 60]).comments[0].text.length, 200);
		// more comments for a file: a new comment on a line replaces the old one
		assert.deepStrictEqual(mergeComments([{ line: 11, text: 'a' }, { line: 20, text: 'b' }], [{ line: 20, text: 'c', color: 'red' }, { line: 5, text: 'd' }]),
			[{ line: 5, text: 'd' }, { line: 11, text: 'a' }, { line: 20, text: 'c', color: 'red' }]);
	});

	test('The structure for the model has the data and the branches of each statement', () => {
		const summary = structureSummary(MODEL) as {
			function: string; lines: number[];
			statements: { lines: number[]; kind: string; in?: string[]; out?: string[]; threads?: string[]; branches?: { label: string; statements: unknown[] }[] }[];
		};
		assert.strictEqual(summary.function, 'power::process');
		assert.deepStrictEqual(summary.lines, [10, 58]);
		assert.strictEqual(summary.statements.length, 8);
		assert.deepStrictEqual(summary.statements[3].in, ['charge.is_dirty', 'state.future', 'charge']);
		assert.deepStrictEqual(summary.statements[3].threads, ['tf::Executor::async runs solve on 18']);
		assert.deepStrictEqual(summary.statements[6].branches?.map((b) => b.label), ['state.state == PLANNING', 'state.state == MOVING', 'else']);
		assert.strictEqual(summary.statements[6].branches?.[1].statements.length, 3);
		// a list with no items is not in the output
		assert.ok(!('out' in summary.statements[2]));
	});
});

// The blocks and the notes of a model stay on their code during an edit. Lines from 1, columns from 0.
suite('Blocks of a model after an edit', () => {
	const block = (id: string, first: number, last: number, extra: SideModelExtra[] = [], parent?: string, level = parent ? 1 : 0, fn = 'f'): SideModelBlock => ({
		id, fn, level, ...(parent ? { parent } : {}), first, last, title: `Block ${id}`, summary: '', ins: [], outs: [], extra,
	});
	const LAYER: SideModel = {
		file: 'a.cpp',
		fn: 'f',
		blocks: [block('1', 10, 12), block('2', 14, 20, [{ kind: 'exit', line: 18, text: 'return' }]), block('2a', 15, 16, [], '2'), block('2b', 17, 20, [], '2')],
		notes: [{ first: 15, last: 15, kind: 'warning', text: 'a note of 2a', block: '2a', blockFn: 'f' }, { first: 22, last: 22, kind: 'info', text: 'a note after the blocks' }],
		comments: [{ line: 11, text: 'a comment in 1' }, { line: 16, text: 'a comment in 2a', color: 'green' }, { line: 25, text: 'a comment after the notes' }],
		details: [{ id: 'd1', line: 17, col: 2, endLine: 18, endCol: 9, code: 'statement_17();\n  stateme', title: 'Two lines', text: 'Examples.' }],
	};
	const commentLines = (layer: SideModel | undefined) => layer?.comments.map((c) => c.line);
	const detailLines = (layer: SideModel | undefined) => layer?.details.map((d) => `${d.line}-${d.endLine}`);
	const change = (l1: number, c1: number, l2: number, c2: number, text: string): TextChange => ({
		range: { start: { line: l1 - 1, character: c1 }, end: { line: l2 - 1, character: c2 } }, text,
	});
	const lines = (layer: SideModel | undefined) => layer && {
		blocks: layer.blocks.map((b) => `${b.id} ${b.first}-${b.last}${b.extra.map((x) => ` ${x.kind}@${x.line}`).join('')}`),
		notes: layer.notes.map((n) => `${n.first}-${n.last}${n.block ? ` ${n.block}` : ''}`),
	};

	test('A change in one line, and a change below the layer, move no line', () => {
		assert.strictEqual(moveModelLayer(LAYER, [change(15, 4, 15, 4, 'x')]), LAYER);
		assert.strictEqual(moveModelLayer(LAYER, [change(30, 0, 31, 0, '')]), LAYER);
	});

	test('A new line in a block makes the block longer and moves the lines below it', () => {
		const moved = moveModelLayer(LAYER, [change(16, 8, 16, 8, '\n')]);
		assert.deepStrictEqual(lines(moved), {
			blocks: ['1 10-12', '2 14-21 exit@19', '2a 15-17', '2b 18-21'],
			notes: ['15-15 2a', '23-23'],
		});
		// the comment stays on the line of the start of its code
		assert.deepStrictEqual(commentLines(moved), [11, 16, 26]);
		assert.deepStrictEqual(detailLines(moved), ['18-19']);
	});

	test('A new line at the start of the first line of a block moves the block down', () => {
		assert.deepStrictEqual(lines(moveModelLayer(LAYER, [change(10, 0, 10, 0, '\n')])), {
			blocks: ['1 11-13', '2 15-21 exit@19', '2a 16-17', '2b 18-21'],
			notes: ['16-16 2a', '23-23'],
		});
	});

	test('Deleted lines above the layer move all lines up', () => {
		const moved = moveModelLayer(LAYER, [change(3, 0, 5, 0, '')]);
		assert.deepStrictEqual(lines(moved), {
			blocks: ['1 8-10', '2 12-18 exit@16', '2a 13-14', '2b 15-18'],
			notes: ['13-13 2a', '20-20'],
		});
		assert.deepStrictEqual(commentLines(moved), [9, 14, 23]);
		assert.deepStrictEqual(detailLines(moved), ['15-16']);
	});

	test('A block whose lines the edit deleted goes away with its note and its comment, and the block around it gets shorter', () => {
		const moved = moveModelLayer(LAYER, [change(15, 0, 17, 0, '')]);
		assert.deepStrictEqual(lines(moved), {
			blocks: ['1 10-12', '2 14-18 exit@16', '2b 15-18'],
			notes: ['20-20'],
		});
		assert.deepStrictEqual(commentLines(moved), [11, 23]);
		assert.deepStrictEqual(detailLines(moved), ['15-16']);
		// a detail whose lines the edit deleted goes away
		assert.deepStrictEqual(detailLines(moveModelLayer(LAYER, [change(17, 0, 19, 0, '')])), []);
	});

	test('A block whose lines the edit deleted takes its children with it', () => {
		assert.deepStrictEqual(lines(moveModelLayer(LAYER, [change(14, 0, 21, 0, '')])), { blocks: ['1 10-12'], notes: ['15-15'] });
	});

	test('The blocks of two functions have the same ids, and an edit removes only the blocks of one function', () => {
		const layer: SideModel = {
			file: 'a.cpp', notes: [{ first: 30, last: 30, kind: 'info', text: 'on block 1 of g', block: '1', blockFn: 'g' }], comments: [], details: [],
			blocks: [block('1', 10, 20, [], undefined, 0, 'f'), block('1a', 11, 15, [], '1', 1, 'f'), block('1', 30, 40, [], undefined, 0, 'g'), block('1a', 31, 35, [], '1', 1, 'g')],
		};
		// the lines of block 1 of f go, and its child goes with it. The blocks of g and the note on block 1 of g stay
		const moved = moveModelLayer(layer, [change(10, 0, 21, 0, '')]);
		assert.deepStrictEqual(moved?.blocks.map((b) => `${b.fn} ${b.id} ${b.first}-${b.last}`), ['g 1 19-29', 'g 1a 20-24']);
		assert.deepStrictEqual(moved?.notes.map((n) => `${n.blockFn} ${n.block} ${n.first}`), ['g 1 19']);
	});

	test('Two overloads have the same name and the same ids, and an edit in one overload keeps the blocks of the other', () => {
		const layer: SideModel = {
			file: 'a.cpp', notes: [{ first: 31, last: 35, kind: 'info', text: 'on block 1a of the second f', block: '1a', blockFn: 'f' }], comments: [], details: [],
			blocks: [block('1', 10, 20), block('1a', 11, 15, [], '1'), block('1', 30, 40), block('1a', 31, 35, [], '1')],
		};
		const moved = moveModelLayer(layer, [change(10, 0, 21, 0, '')]);
		assert.deepStrictEqual(lines(moved), { blocks: ['1 19-29', '1a 20-24'], notes: ['20-24 1a'] });
		// line 10 has a different text after a reload: block 1 of the first overload goes with its child. The second
		// overload keeps its blocks
		const textOf = (src: string[]) => (l: number) => src[l - 1];
		const src = Array.from({ length: 45 }, (_, i) => `  statement_${i + 1}();`);
		const stored = storeModelLayer(layer, textOf(src));
		const changed = src.map((l, i) => (i === 9 ? '  other();' : l));
		assert.deepStrictEqual(lines(restoreModelLayer(stored, textOf(changed), changed.length)), { blocks: ['1 30-40', '1a 31-35'], notes: ['31-35 1a'] });
		// a note on block 1 needs the lines
		assert.match(resolveNotes([{ block: '1', function: 'f', kind: 'info', note: 'x' }], layer.blocks, [1, 60]).problems.join('\n'),
			/block 1 is in 2 functions with the name f\(\)\. Give "lines"/);
	});

	test('The blocks of a stored layer of an older version get the function of the layer', () => {
		const textOf = (src: string[]) => (l: number) => src[l - 1];
		const src = Array.from({ length: 30 }, (_, i) => `  statement_${i + 1}();`);
		const stored = storeModelLayer(LAYER, textOf(src));
		const older = {
			...LAYER, fn: 'old::f', blocks: LAYER.blocks.map(({ fn: _fn, ...b }) => b), notes: LAYER.notes.map(({ blockFn: _blockFn, ...n }) => n),
		} as unknown as SideModel;
		const restored = restoreModelLayer({ ...stored, layer: older }, textOf(src), src.length)!;
		assert.ok(restored.blocks.every((b) => b.fn === 'old::f'), JSON.stringify(restored.blocks.map((b) => b.fn)));
		assert.deepStrictEqual(restored.notes.filter((n) => n.block).map((n) => n.blockFn), ['old::f']);
	});

	test('A change from the start of the text to the last line of the layer removes the layer', () => {
		assert.strictEqual(moveModelLayer(LAYER, [change(1, 0, 40, 0, 'int x;\n')]), undefined);
	});

	test('A stored layer finds its blocks and notes again in the text of a new session', () => {
		const textOf = (src: string[]) => (l: number) => src[l - 1];
		const src = Array.from({ length: 30 }, (_, i) => `  statement_${i + 1}();`);
		const stored = storeModelLayer(LAYER, textOf(src));
		assert.strictEqual(stored.texts[14], 'statement_14();');
		assert.deepStrictEqual(restoreModelLayer(stored, textOf(src), src.length), LAYER);

		// two new lines at the start, and a different indent: all lines move two lines down
		const moved = ['// a', '// b', ...src.map((l) => `\t${l.trim()}`)];
		const restored = restoreModelLayer(stored, textOf(moved), moved.length);
		assert.deepStrictEqual(lines(restored), {
			blocks: ['1 12-14', '2 16-22 exit@20', '2a 17-18', '2b 19-22'],
			notes: ['17-17 2a', '24-24'],
		});
		assert.deepStrictEqual(commentLines(restored), [13, 18, 27]);
		assert.deepStrictEqual(detailLines(restored), ['19-20']);

		// a different text on lines 15 and 16: block 2a, its note and its comment go away
		const changed = src.map((l, i) => (i === 14 || i === 15 ? '  other();' : l));
		const restoredChanged = restoreModelLayer(stored, textOf(changed), changed.length);
		assert.deepStrictEqual(lines(restoredChanged), {
			blocks: ['1 10-12', '2 14-20 exit@18', '2b 17-20'],
			notes: ['22-22'],
		});
		assert.deepStrictEqual(commentLines(restoredChanged), [11, 25]);
		assert.strictEqual(restoreModelLayer(stored, textOf(['int x;']), 1), undefined);

		// a layer of an older version of DataFlow has no comments and no details
		const { comments: _comments, details: _details, ...older } = LAYER;
		const restoredOlder = restoreModelLayer({ ...stored, layer: older as SideModel }, textOf(src), src.length);
		assert.deepStrictEqual([restoredOlder?.comments, restoredOlder?.details], [[], []]);
	});

	test('A stored block that the text does not have takes all levels of its children with it', () => {
		const textOf = (src: string[]) => (l: number) => src[l - 1];
		const src = Array.from({ length: 30 }, (_, i) => `  statement_${i + 1}();`);
		const deep: SideModel = {
			file: 'a.cpp', fn: 'f', notes: [], comments: [], details: [],
			blocks: [block('1', 10, 20), block('1a', 11, 15, [], '1'), block('1a1', 12, 13, [], '1a', 2), block('1b', 16, 20, [], '1')],
		};
		const stored = storeModelLayer(deep, textOf(src));
		// line 11 has a different text: 1a goes away, and 1a1 goes with it, although its own lines did not change
		const changed = src.map((l, i) => (i === 10 ? '  other();' : l));
		assert.deepStrictEqual(lines(restoreModelLayer(stored, textOf(changed), changed.length))?.blocks, ['1 10-20', '1b 16-20']);
	});

	test('The changes of an edit with two cursors come from the end of the text to its start', () => {
		assert.deepStrictEqual(lines(moveModelLayer(LAYER, [change(21, 0, 21, 0, '\n'), change(11, 2, 11, 2, '\n')])), {
			blocks: ['1 10-13', '2 15-21 exit@19', '2a 16-17', '2b 18-21'],
			notes: ['16-16 2a', '24-24'],
		});
	});
});
