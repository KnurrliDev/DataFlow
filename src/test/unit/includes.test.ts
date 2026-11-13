import * as assert from 'assert';
import * as path from 'path';
import type { IncludeFile, IncludeModel, IncludeNode, IncludersResult } from '../../engine/client';
import { buildSideIncluders, buildSideIncludes, formatLines, forwardHint } from '../../lenses/includes';

// A model with the shape of the result of dataflow/includes for app.cpp of the engine test: a forced include, the own
// header, a header that comes in three times, an unused header, a forwarding header, <vector> and a missing header.
const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const file = (name: string, lines: number, group = 'project headers', isSystem = false): IncludeFile => ({
	path: path.join(ROOT, name), lines, group, isSystem,
});
const FILES = [
	file('app.cpp', 13, 'this file'), file('force.h', 2), file('app.h', 3), file('base.h', 2), file('util.h', 3), file('unused.h', 2),
	file('macros.h', 2), file('fwd.h', 1), file('vector', 1000, 'C++ standard library', true),
];
const node = (fileIndex: number, parent: number, line: number, spelled: string, state: IncludeNode['state'], more: Partial<IncludeNode> = {}): IncludeNode => ({
	file: fileIndex, parent, line, spelled, state, ...more,
});

function appModel(): IncludeModel {
	return {
		files: FILES,
		nodes: [
			node(0, -1, 0, '', 'main'),
			node(1, 0, 0, `"${path.join(ROOT, 'force.h')}"`, 'entered', { isUsed: false }),
			node(2, 0, 1, '"app.h"', 'entered', { isOwn: true, isUsed: true, use: { name: 'app_main', line: 9 } }),
			node(3, 2, 2, '"base.h"', 'entered'),
			node(4, 0, 2, '"util.h"', 'entered', {
				isUsed: true, use: { name: 'helper', line: 12 }, forward: { state: 'needed', blocker: { name: 'helper', kind: 'a function', line: 12 } },
			}),
			node(3, 4, 2, '"base.h"', 'skipped', { first: 3 }),
			node(3, 0, 3, '"base.h"', 'skipped', { first: 3 }),
			node(5, 0, 4, '"unused.h"', 'entered', { isUsed: false }),
			node(6, 0, 5, '"macros.h"', 'entered', { isUsed: true, use: { name: 'APP_VALUE', line: 11 } }),
			node(7, 0, 6, '"fwd.h"', 'entered', {
				isUsed: true, use: { name: 'Base', line: 10 }, forward: { state: 'possible', text: 'class Base;', types: [{ name: 'Base', lines: [10] }] },
			}),
			node(3, 7, 1, '"base.h"', 'skipped', { first: 3 }),
			node(8, 0, 7, '<vector>', 'entered', { isUsed: true, use: { name: 'std::vector', line: 11 } }),
			node(-1, 0, 8, '"nope.h"', 'missing'),
		],
		preprocessMs: 12,
		cached: false,
	};
}

suite('Include Hierarchy', () => {
	test('Line counts get a short form', () => {
		assert.deepStrictEqual([950, 12345, 1234567].map(formatLines), ['950', '12.3k', '1.2M']);
	});

	test('Each node adds its own lines and the lines of the files under it. A skipped include adds nothing', () => {
		const view = buildSideIncludes(appModel(), path.join(ROOT, 'app.cpp'))!;
		assert.deepStrictEqual(view.nodes.map((n) => n.total), [1028, 2, 5, 2, 3, 0, 0, 2, 2, 1, 0, 1000, 0]);
		assert.deepStrictEqual(view.nodes[0].children, [1, 2, 4, 6, 7, 8, 9, 11, 12]);
		assert.deepStrictEqual(view.nodes.map((n) => n.depth), [0, 1, 1, 2, 1, 2, 1, 1, 1, 1, 2, 1, 1]);
		assert.deepStrictEqual(view.stats, { lines: 13, total: 1028, includes: 8, skipped: 1, unused: 1, missing: 1, forward: 1 });
	});

	test('The names, the forced include, the parent files and the colors of the nodes', () => {
		const view = buildSideIncludes(appModel(), path.join(ROOT, 'app.cpp'))!;
		assert.deepStrictEqual(view.nodes.map((n) => n.name), [
			'app.cpp', 'force.h', 'app.h', 'base.h', 'util.h', 'base.h', 'base.h', 'unused.h', 'macros.h', 'fwd.h', 'base.h', '<vector>', 'nope.h',
		]);
		assert.deepStrictEqual([view.nodes[1].isForced, view.nodes[2].isForced], [true, false]);
		assert.strictEqual(view.nodes[3].parentPath, path.join(ROOT, 'app.h'));
		assert.deepStrictEqual([view.nodes[12].path, view.nodes[12].color], ['', 'problem']);
		assert.deepStrictEqual(view.groups, [
			{ name: 'C++ standard library', lines: 1000, color: 'muted' },
			{ name: 'project headers', lines: 15, color: 'read' },
			{ name: 'this file', lines: 13, color: 'path' },
		]);
		assert.deepStrictEqual([view.nodes[11].color, view.nodes[2].color, view.nodes[0].color], ['muted', 'read', 'path']);
	});

	test('The include lines of the file get hints: the added lines, included before, possibly unused, forward declarations and not found', () => {
		const view = buildSideIncludes(appModel(), path.join(ROOT, 'app.cpp'))!;
		assert.deepStrictEqual(view.hints.map((h) => `${h.line} ${h.kind} ${h.text}`), [
			'1 cost +5 lines',
			'2 cost +3 lines',
			'3 skipped included before, by app.h',
			'4 cost +2 lines',
			'4 unused possibly unused',
			'5 cost +2 lines',
			'6 cost +1 line',
			'6 forward → class Base;',
			'7 large +1.0k lines',
			'8 missing not found',
		]);
		assert.deepStrictEqual(view.hints.filter((h) => h.line === 3).map((h) => h.node), [6]);
		assert.deepStrictEqual(view.hints.filter((h) => h.kind === 'forward').map((h) => h.node), [9]);
		// the nodes keep the result of the check for the badge and the details
		assert.deepStrictEqual([view.nodes[9].forward?.state, view.nodes[4].forward?.state, view.nodes[2].forward], ['possible', 'needed', undefined]);
	});

	test('A long or a multi-line text of forward declarations gives their count in the hint', () => {
		assert.strictEqual(forwardHint('namespace power { struct Battery; }'), '→ namespace power { struct Battery; }');
		assert.strictEqual(forwardHint('namespace power { struct Battery; class Plan; }\nenum class Mode : unsigned char;'), '→ 3 forward declarations');
		assert.strictEqual(forwardHint(`namespace a_long_namespace_name::and_another_one { struct ${'X'.repeat(20)}; }`), '→ 1 forward declaration');
	});

	test('Other groups get the colors of the palette, the most lines first', () => {
		const model = appModel();
		model.files = model.files.map((f) => (f.group === 'project headers' ? { ...f, group: 'Qt' } : f));
		model.files[8] = { ...model.files[8], group: 'Windows SDK' };
		const view = buildSideIncludes(model, path.join(ROOT, 'app.cpp'))!;
		assert.deepStrictEqual(view.groups.map((g) => [g.name, g.color]), [['Windows SDK', 'check'], ['Qt', 'definition'], ['this file', 'path']]);
	});

	test('A result with no main node gives no view', () => {
		assert.strictEqual(buildSideIncludes({ files: [], nodes: [], preprocessMs: 0, cached: false }, 'a.cpp'), null);
	});

	test('Included by: a translation unit gets its path in the deepest project folder, else its full path', () => {
		const outside = process.platform === 'win32' ? 'D:\\other\\d.cpp' : '/other/d.cpp';
		const res: IncludersResult = {
			file: path.join(ROOT, 'lib', 'x.h'),
			units: [path.join(ROOT, 'lib', 'b.cpp'), path.join(ROOT, 'app', 'a.cpp'), path.join(ROOT, 'lib', 'sub', 'c.cpp'), outside],
			unitCount: 9, failed: [path.join(ROOT, 'bad.cpp')], isUnit: false, scanned: true, scanMs: 12, projectUnits: 8, projectIncluders: 3, ms: 12,
		};
		const side = buildSideIncluders(res, res.file, [ROOT, path.join(ROOT, 'lib')]);
		const names = side.units.map((u) => u.name);
		assert.deepStrictEqual(names.filter((n) => n !== outside), ['app/a.cpp', 'b.cpp', 'sub/c.cpp']);
		assert.ok(names.includes(outside), JSON.stringify(names));
		assert.strictEqual(side.units.find((u) => u.name === 'b.cpp')!.file, path.join(ROOT, 'lib', 'b.cpp'));
		assert.deepStrictEqual([side.file, side.state, side.unitCount, side.failed, side.isUnit], [res.file, 'ready', 9, 1, false]);
	});
});
