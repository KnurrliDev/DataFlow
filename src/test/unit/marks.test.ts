import * as assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCppFile } from '../../review/git';
import { markDiff, MarkSource, MarkStore, MAX_MARK_FILES, MAX_MARKS } from '../../review/marks';

// The marks of the clients: a mark keeps the text files under its paths in a folder, and the diff since a mark compares
// the files now with their texts in the mark
suite('Marks of the clients', () => {
	const ROOT = path.resolve('/repo');
	const SRC = path.join(ROOT, 'src');
	let dir: string;
	let texts: Map<string, string>;
	// a project in memory: the folder src has the files of the map
	const source: MarkSource = {
		files: async (full) => {
			if (texts.has(full)) {
				return [full];
			}
			const inside = [...texts.keys()].filter((f) => f.startsWith(`${full}${path.sep}`));
			return full === SRC || inside.length > 0 ? inside : undefined;
		},
		text: async (file) => texts.get(file),
	};
	const file = (name: string) => path.join(SRC, name);

	setup(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-marks-'));
		texts = new Map([
			[file('a.cpp'), 'int a() {\n\treturn 1;\n}\n'],
			[file('b.hpp'), '#pragma once\nint a();\n'],
			[file('CMakeLists.txt'), 'add_library(x a.cpp)\n'],
			[file('logo.png'), 'PNG\u0000data'],
		]);
	});
	teardown(() => rmSync(dir, { recursive: true, force: true }));

	test('A mark keeps the text files under its paths, a new mark with the same name replaces it, and a client has its own marks', async () => {
		const store = new MarkStore(dir);
		const mark = await store.create('my-ext', 'step-1', [SRC], ROOT, source);
		// a binary file is not in the mark
		assert.deepStrictEqual(mark.files.map((f) => path.basename(f.file)).sort(), ['CMakeLists.txt', 'a.cpp', 'b.hpp']);
		assert.strictEqual((await store.texts(mark)).get(file('a.cpp')), 'int a() {\n\treturn 1;\n}\n');
		assert.ok(store.copyOf(mark, file('a.cpp'))?.endsWith('.txt'));
		assert.strictEqual(store.copyOf(mark, file('none.cpp')), undefined);
		// the same name replaces the mark. A different client has its own marks with the same names
		texts.set(file('a.cpp'), 'int a() { return 2; }\n');
		await store.create('my-ext', 'step-1', [file('a.cpp')], ROOT, source);
		await store.create('other', 'step-1', [file('b.hpp')], ROOT, source);
		const again = await store.get('my-ext', 'step-1');
		assert.deepStrictEqual([again?.files.length, (await store.texts(again!)).get(file('a.cpp'))], [1, 'int a() { return 2; }\n']);
		assert.deepStrictEqual((await store.list('other')).map((m) => [m.name, m.files.length]), [['step-1', 1]]);
		// a delete removes only the mark of the client
		assert.strictEqual(await store.remove('my-ext', 'step-1'), true);
		assert.strictEqual(await store.remove('my-ext', 'step-1'), false);
		assert.deepStrictEqual([(await store.list('my-ext')).length, (await store.list('other')).length], [0, 1]);
	});

	test('A wrong name, a path that is not there, too many files and too many marks give an error, and no mark changes', async () => {
		const store = new MarkStore(dir);
		await assert.rejects(store.create('c', 'step 1', [SRC], ROOT, source), /"name" must have 1 to 64 letters/);
		await assert.rejects(store.create('c', 'x', [], ROOT, source), /Give "paths"/);
		await assert.rejects(store.create('c', 'x', [path.join(ROOT, 'none')], ROOT, source), /These paths are not there: .*none\. No mark changed\./);
		for (let i = 0; i <= MAX_MARK_FILES; i++) {
			texts.set(file(`f${i}.cpp`), `int f${i};\n`);
		}
		await assert.rejects(store.create('c', 'x', [SRC], ROOT, source), new RegExp(`more than ${MAX_MARK_FILES} files`));
		assert.deepStrictEqual(await store.list('c'), []);
		for (let i = 0; i < MAX_MARKS; i++) {
			await store.create('c', `m${i}`, [file('a.cpp')], ROOT, source);
		}
		await assert.rejects(store.create('c', 'one-more', [file('a.cpp')], ROOT, source), new RegExp(`${MAX_MARKS} marks, the maximum`));
		// a mark with a name that the client has replaces it, also with the maximum of marks
		await store.create('c', 'm0', [file('b.hpp')], ROOT, source);
		assert.strictEqual((await store.list('c')).length, MAX_MARKS);
	});

	test('The diff since a mark gives the changed files, the new files and the deleted files', async () => {
		const store = new MarkStore(dir);
		const mark = await store.create('my-ext', 'step-2', [SRC], ROOT, source);
		texts.set(file('a.cpp'), 'int a() {\n\treturn 2;\n}\n');
		texts.set(file('c.cpp'), 'int c;\n');
		texts.set(file('CMakeLists.txt'), 'add_library(x a.cpp c.cpp)\n');
		texts.delete(file('b.hpp'));
		const diff = await markDiff(mark, await store.texts(mark), source, isCppFile);
		assert.deepStrictEqual(diff.files.map((f) => [path.basename(f.uri.fsPath), f.isNew, f.changes.lines]), [['a.cpp', false, [2]], ['c.cpp', true, [1]]]);
		assert.deepStrictEqual(diff.deleted.map((f) => path.basename(f)), ['b.hpp']);
		// a changed text file that is not a C or C++ file is in other, and all text files go into the files
		assert.deepStrictEqual(diff.other.map((f) => path.basename(f)), ['CMakeLists.txt']);
		const all = await markDiff(mark, await store.texts(mark), source, () => true);
		assert.deepStrictEqual(all.files.map((f) => path.basename(f.uri.fsPath)).sort(), ['CMakeLists.txt', 'a.cpp', 'c.cpp']);
	});
});
