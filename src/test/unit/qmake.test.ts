import * as assert from 'assert';
import * as path from 'path';
import { expandVariables, qmakeEntries, readMakefileVariables, splitArguments } from '../../cdb/qmake';

// The shape of a Makefile.Release that qmake writes for MSVC.
const MAKEFILE = [
	'CXX           = cl',
	'DEFINES       = -DUNICODE -DQT_CORE_LIB',
	'CXXFLAGS      = -nologo -Zc:__cplusplus -std:c++20 $(DEFINES)',
	'INCPATH       = -I..\\src -I"C:\\Qt Dir\\include" -I.',
	'SOURCES       = ..\\src\\a.cpp \\',
	'\t\t..\\src\\b.cpp',
	'',
].join('\r\n');

suite('qmake Makefile reader', () => {
	test('Reads variables and joins the lines that continue', () => {
		const vars = readMakefileVariables(MAKEFILE);
		assert.strictEqual(vars.get('CXX'), 'cl');
		assert.deepStrictEqual(splitArguments(vars.get('SOURCES')!), ['..\\src\\a.cpp', '..\\src\\b.cpp']);
	});

	test('Expands $(NAME) references, also nested ones', () => {
		const vars = new Map([['A', 'x $(B)'], ['B', 'y']]);
		assert.strictEqual(expandVariables('$(A) $(B) $(C)', vars), 'x y y ');
	});

	test('Keeps a quoted part in one argument, also in the middle of the argument', () => {
		assert.deepStrictEqual(splitArguments('-a "b c" -I"C:\\Qt Dir\\include" d'), ['-a', 'b c', '-IC:\\Qt Dir\\include', 'd']);
	});

	test('Makes one compile command for each source file', () => {
		const build = path.resolve('/work/build');
		const entries = qmakeEntries(MAKEFILE, build);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0].directory, build);
		assert.strictEqual(entries[0].file, path.resolve(build, '..\\src\\a.cpp'));
		assert.deepStrictEqual(entries[0].arguments.slice(0, 6), ['cl', '-nologo', '-Zc:__cplusplus', '-std:c++20', '-DUNICODE', '-DQT_CORE_LIB']);
		assert.ok(entries[0].arguments.includes('-IC:\\Qt Dir\\include'));
		assert.deepStrictEqual(entries[0].arguments.slice(-2), ['-c', entries[0].file]);
	});
});
