import * as assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commonRoot, findProjectFiles, isInside, MAX_PROJECT_FILES, qtCreatorBuildFolders } from '../../cdb/project';
import { flattenSettings, parseJsonc, ProjectSettings } from '../../cdb/settings';

suite('Project that is not open in VS Code', () => {
	let root: string;
	suiteSetup(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'dataflow-project-'));
		const files = [
			'src/main.cpp', 'src/debug/trace.cpp', 'include/app/model.hpp', 'docs/readme.md', 'CMakeLists.txt',
			// a part of a unity build
			'src/parts/table.inc',
			// the build folders, the hidden folders and the packages of CMake
			'build/moc_main.cpp', 'build-app-Desktop-Release/main.o', 'cmake-build-debug/gen.cpp', '.git/hooks/x.cpp',
			'builds/App-Desktop_Qt_6_11_2_MSVC2022_64bit-Debug/ui_main.h',
			'third/_deps/fmt-src/format.cc', 'node_modules/a/b.cpp',
			// an in-source build of qmake: its debug and release folders have generated files
			'qt/Makefile.Release', 'qt/release/moc_window.cpp', 'qt/window.cpp',
		];
		for (const file of files) {
			mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			writeFileSync(path.join(root, file), '');
		}
	});
	suiteTeardown(() => rmSync(root, { recursive: true, force: true }));

	test('The list of files has the C and C++ files of the project, and no files of the build folders', async () => {
		const files = (await findProjectFiles(root)).map((f) => path.relative(root, f).split(path.sep).join('/'));
		assert.deepStrictEqual(files, ['include/app/model.hpp', 'qt/window.cpp', 'src/debug/trace.cpp', 'src/main.cpp', 'src/parts/table.inc']);
		assert.strictEqual((await findProjectFiles(root, 2)).length, 2);
	});

	test('The setting of the folders to skip changes the list, with * and ? in the names', async () => {
		const list = async (skip: string[]) => (await findProjectFiles(root, MAX_PROJECT_FILES, skip)).map((f) => path.relative(root, f).split(path.sep).join('/'));
		// a folder of sources with the name of a build folder shows if the setting does not have this name
		assert.deepStrictEqual(await list(['.*', 'node_modules', '_deps', 'cmake-build-*', 'BUILD?*']), [
			'build/moc_main.cpp', 'include/app/model.hpp', 'qt/window.cpp', 'src/debug/trace.cpp', 'src/main.cpp', 'src/parts/table.inc',
		]);
		// the debug and release folders of qmake stay out
		assert.ok(!(await list([])).includes('qt/release/moc_window.cpp'));
		assert.ok((await list([])).includes('.git/hooks/x.cpp'));
	});

	test('The common folder of the files of a compile database is the folder of the sources', () => {
		const at = (...parts: string[]) => path.join(root, ...parts);
		assert.strictEqual(commonRoot([at('src', 'main.cpp'), at('src', 'debug', 'trace.cpp')]), at('src'));
		assert.strictEqual(commonRoot([at('src', 'main.cpp'), at('qt', 'window.cpp')]), root);
		assert.strictEqual(commonRoot([]), undefined);
		assert.strictEqual(commonRoot([path.join(path.parse(root).root, 'a.cpp'), at('src', 'main.cpp')]), undefined);
	});

	test('The project files of Qt Creator give the build folders, also outside of the project', () => {
		const value = (template: string) => `<value type="QString" key="ProjectExplorer.BuildConfiguration.BuildDirectory">${template}</value>`;
		const userFile = [
			// subfolders of builds whose names start with the name of the project
			value('%{ActiveProject:NativePath}/builds/%{Project:Name}-%{Kit:FileSystemName}-%{BuildConfig:Name}'),
			value('%{ActiveProject:NativePath}/builds/%{Project:Name}-%{Kit:FileSystemName}-%{BuildConfig:Name}'),
			// the default of Qt Creator: all subfolders of build
			value('%{Project:Path}/build/%{Kit:FileSystemName}-%{BuildConfig:Name}'),
			// the old default of Qt Creator: next to the project
			value('../build-%{Project:Name}-%{Kit:FileSystemName}-%{BuildConfig:Name}'),
			// a folder with no macro, and a text with an entity of XML
			value(`${path.parse(root).root.split(path.sep).join('/')}builds/app &amp; tools`),
			'<value type="QString" key="ProjectExplorer.ProjectConfiguration.DisplayName">Debug</value>',
		].join('\n');
		assert.deepStrictEqual(qtCreatorBuildFolders(userFile, root, 'App'), [
			{ folder: path.join(root, 'builds'), prefix: 'App-' },
			{ folder: path.join(root, 'build'), prefix: '' },
			{ folder: path.dirname(root), prefix: 'build-App-' },
			{ folder: path.join(path.parse(root).root, 'builds', 'app & tools') },
		]);
		assert.deepStrictEqual(qtCreatorBuildFolders(value('%{Kit:FileSystemName}'), root, 'App'), []);
	});

	test('A file is inside a folder only if it is below the folder', () => {
		assert.ok(isInside(path.join(root, 'src', 'main.cpp'), root));
		assert.ok(!isInside(root, root));
		assert.ok(!isInside(path.join(path.dirname(root), 'other', 'a.cpp'), root));
		assert.ok(!isInside(`${root}-other${path.sep}a.cpp`, root));
	});
});

suite('The settings file of a project', () => {
	test('The parser allows comments and a comma after the last item, as VS Code does', () => {
		const text = [
			String.fromCharCode(0xfeff) + '{',
			'  // the events of Logic Map',
			'  "dataflow.logic.eventFunctions": ["fire_transition", "a//b", "c/*d*/",],',
			'  /* the target */ "dataflow.ripple.baseRef": "main", // a comment after a comma',
			'  "url": "http://example.invalid/x,}",',
			'}',
		].join('\n');
		assert.deepStrictEqual(parseJsonc(text), {
			'dataflow.logic.eventFunctions': ['fire_transition', 'a//b', 'c/*d*/'],
			'dataflow.ripple.baseRef': 'main',
			url: 'http://example.invalid/x,}',
		});
	});

	test('A nested object gives the same keys as the keys with dots', () => {
		const flat = flattenSettings({ dataflow: { logic: { eventFunctions: ['a'] }, 'ripple.maxDepth': 3 }, 'dataflow.cost.minCopyBytes': 8 });
		assert.deepStrictEqual([...flat.entries()], [
			['dataflow.logic.eventFunctions', ['a']], ['dataflow.ripple.maxDepth', 3], ['dataflow.cost.minCopyBytes', 8],
		]);
	});

	test('A change of the file gives the new values, and a file that is not valid gives no values', () => {
		const root = mkdtempSync(path.join(os.tmpdir(), 'dataflow-settings-'));
		const warnings: string[] = [];
		const settings = new ProjectSettings((m) => warnings.push(m));
		try {
			assert.strictEqual(settings.get(root, 'dataflow.ripple.baseRef'), undefined);
			mkdirSync(path.join(root, '.vscode'));
			const file = ProjectSettings.fileOf(root);
			writeFileSync(file, '{ "dataflow.ripple.baseRef": "main" }');
			assert.strictEqual(settings.get(root, 'dataflow.ripple.baseRef'), 'main');
			// a new modification time gives the new text
			writeFileSync(file, '{ "dataflow.ripple.baseRef": "dev" }');
			const later = new Date(Date.now() + 5000);
			utimesSync(file, later, later);
			assert.strictEqual(settings.get(root, 'dataflow.ripple.baseRef'), 'dev');
			writeFileSync(file, '{ "dataflow.ripple.baseRef": ');
			const latest = new Date(Date.now() + 10000);
			utimesSync(file, latest, latest);
			assert.strictEqual(settings.get(root, 'dataflow.ripple.baseRef'), undefined);
			assert.strictEqual(warnings.length, 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
