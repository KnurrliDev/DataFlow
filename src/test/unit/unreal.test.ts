import * as assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	defaultTarget, engineRootOf, findEngine, findUnrealProject, ubtArguments, ubtPlatform, ubtProgram, unrealDbPath, unrealTargets, writeUnrealDatabase,
} from '../../cdb/unreal';

// The Unreal projects: the .uproject file, the targets, the engine and the arguments of UnrealBuildTool

suite('Unreal projects', () => {
	let temp: string;
	const write = (file: string, text = '') => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	// a folder of an engine with the program of UnrealBuildTool
	const engine = (dir: string) => {
		write(path.join(dir, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.exe'));
		return dir;
	};
	const project = (dir: string, association: string, targets: Record<string, string> = {}) => {
		write(path.join(dir, `${path.basename(dir)}.uproject`), JSON.stringify({ FileVersion: 3, EngineAssociation: association }));
		for (const [name, type] of Object.entries(targets)) {
			write(path.join(dir, 'Source', `${name}.Target.cs`), `public class ${name}Target : TargetRules\n{\n\tType = TargetType.${type};\n}\n`);
		}
		return findUnrealProject(dir)!;
	};

	setup(() => {
		temp = mkdtempSync(path.join(os.tmpdir(), 'dataflow-unreal-'));
	});
	teardown(() => rmSync(temp, { recursive: true, force: true }));

	test('A .uproject file makes the folder an Unreal project, with its engine association and its C++ code', () => {
		const p = project(path.join(temp, 'Plant'), '5.8', { Plant: 'Game' });
		assert.deepStrictEqual({ ...p, file: path.basename(p.file) }, {
			file: 'Plant.uproject', root: path.join(temp, 'Plant'), name: 'Plant', engineAssociation: '5.8', hasSource: true,
		});
		assert.strictEqual(findUnrealProject(temp), undefined);
		write(path.join(temp, 'Broken', 'Broken.uproject'), '{ not json');
		assert.strictEqual(findUnrealProject(path.join(temp, 'Broken'))?.engineAssociation, '');
		assert.strictEqual(unrealDbPath(p.root), path.join(p.root, 'Intermediate', 'DataFlow', 'compile_commands.json'));
	});

	test('The default target is the target of the setting, else the editor target of the project', () => {
		const p = project(path.join(temp, 'Plant'), '5.8', { Plant: 'Game', PlantEditor: 'Editor', PlantServer: 'Server' });
		const targets = unrealTargets(p.root);
		assert.deepStrictEqual(targets, [{ name: 'Plant', type: 'Game' }, { name: 'PlantEditor', type: 'Editor' }, { name: 'PlantServer', type: 'Server' }]);
		assert.strictEqual(defaultTarget(targets, 'Plant')?.name, 'PlantEditor');
		assert.strictEqual(defaultTarget(targets, 'Plant', 'plantserver')?.name, 'PlantServer');
		// a target of the setting that the project does not have goes to UnrealBuildTool as it is
		assert.deepStrictEqual(defaultTarget(targets, 'Plant', 'Other'), { name: 'Other' });
		// with no editor target, the game target with the name of the project
		assert.strictEqual(defaultTarget([{ name: 'PlantServer', type: 'Server' }, { name: 'Plant', type: 'Game' }], 'Plant')?.name, 'Plant');
		assert.strictEqual(defaultTarget([], 'Plant'), undefined);
	});

	test('The folder of an engine has UnrealBuildTool, and the folder Engine also gives it', () => {
		const root = engine(path.join(temp, 'UE_5.8'));
		assert.strictEqual(engineRootOf(root), root);
		assert.strictEqual(engineRootOf(path.join(root, 'Engine')), root);
		assert.strictEqual(engineRootOf(temp), undefined);
		assert.strictEqual(ubtProgram(root), path.join(root, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.exe'));
	});

	test('The engine comes from the setting, the registry, the launcher, or a folder above the project', async () => {
		const installed = engine(path.join(temp, 'Epic', 'UE_9.9'));
		const source = engine(path.join(temp, 'SourceBuild'));
		const asked: string[] = [];
		const registry = async (key: string, value?: string) => {
			asked.push(`${key}|${value}`);
			return key.endsWith('Unreal Engine\\9.9') ? installed : key.endsWith('Builds') && value === '{1234-ABCD}' ? source : undefined;
		};
		const p = project(path.join(temp, 'Plant'), '9.9');
		assert.strictEqual(await findEngine(p, { registry }), installed);
		assert.deepStrictEqual(asked, ['HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\9.9|InstalledDirectory']);
		// the list of the launcher, if the registry has no key
		assert.strictEqual(await findEngine(p, { registry: async () => undefined, launcherInstalls: () => [{ appName: 'UE_9.9', location: installed }] }), installed);
		// the GUID of a source build
		assert.strictEqual(await findEngine(project(path.join(temp, 'Guid'), '{1234-ABCD}'), { registry }), source);
		// the setting wins, also over the association
		assert.strictEqual(await findEngine(p, { setting: path.join(source, 'Engine'), registry }), source);
		// no association: the project is in the folder of a source build
		assert.strictEqual(await findEngine(project(path.join(source, 'Games', 'Plant'), ''), {}), source);
		// an engine with no UnrealBuildTool is no engine
		assert.strictEqual(await findEngine(project(path.join(temp, 'Old'), '9.8'), { registry: async () => path.join(temp, 'Epic') }), undefined);
	});

	test('UnrealBuildTool writes the database of the target into Intermediate/DataFlow, and the extra arguments come last', () => {
		const p = project(path.join(temp, 'Plant'), '5.8');
		assert.deepStrictEqual(ubtArguments(p, 'PlantEditor', 'Development', ['-Compiler=VisualStudio2022']), [
			'PlantEditor', ubtPlatform(), 'Development', `-Project=${p.file}`, '-Mode=GenerateClangDatabase',
			`-OutputDir=${path.join(p.root, 'Intermediate', 'DataFlow')}`, '-OutputFilename=compile_commands.ubt.json', '-WaitMutex', '-Compiler=VisualStudio2022',
		]);
		assert.deepStrictEqual(['win32', 'darwin', 'linux'].map((x) => ubtPlatform(x as NodeJS.Platform)), ['Win64', 'Mac', 'Linux']);
	});

	test('The database of DataFlow uses copies of the response files of UnrealBuildTool, so a normal build does not change it', async () => {
		const p = project(path.join(temp, 'Plant'), '5.8');
		const slash = (file: string) => file.split(path.sep).join('/');
		const build = path.join(p.root, 'Intermediate', 'Build', 'Win64', 'x64', 'UnrealEditor', 'Development', 'Plant');
		const shared = slash(path.join(build, 'Plant.Shared.rsp'));
		const definitions = slash(path.join(build, 'Definitions.h'));
		write(shared, '/I "Source"\n/DPLANT=1\n');
		write(path.join(build, 'Actor.cpp.obj.rsp'), `"${slash(path.join(p.root, 'Source', 'Actor.cpp'))}"\n@"${shared}"\n/FI"${definitions}"\n`);
		// a relative response file in a response file starts at the folder of that response file
		write(path.join(build, 'Plant.cpp.obj.rsp'), '@Plant.Shared.rsp\n/c\n');
		const dbFolder = path.join(p.root, 'Intermediate', 'DataFlow');
		const ubtFile = path.join(dbFolder, 'compile_commands.ubt.json');
		write(ubtFile, JSON.stringify([
			{ file: path.join(p.root, 'Source', 'Actor.cpp'), directory: temp, command: `"clang-cl.exe" @"${slash(path.join(build, 'Actor.cpp.obj.rsp'))}"` },
			// a relative response file in a command starts at the folder of the command
			{ file: path.join(p.root, 'Source', 'Plant.cpp'), directory: build, arguments: ['clang-cl.exe', '@Plant.cpp.obj.rsp'] },
			{ file: path.join(p.root, 'Source', 'Other.cpp'), directory: build, command: 'clang-cl.exe @"Missing.rsp" /c Other.cpp' },
		]));
		write(path.join(dbFolder, 'rsp', '0123456789-Gone.cpp.obj.rsp'), '/c\n');

		assert.strictEqual(await writeUnrealDatabase(ubtFile, unrealDbPath(p.root)), 3);
		assert.ok(!existsSync(ubtFile), 'the file of UnrealBuildTool is gone');
		const db = JSON.parse(readFileSync(unrealDbPath(p.root), 'utf8')) as { command?: string; arguments?: string[] }[];
		const copies = slash(path.join(dbFolder, 'rsp'));
		const actor = /^"clang-cl\.exe" @"([^"]+)"$/.exec(db[0].command!)?.[1];
		assert.ok(actor && path.posix.dirname(actor) === copies && actor.endsWith('-Actor.cpp.obj.rsp'), db[0].command);
		const plant = db[1].arguments![1];
		assert.ok(plant.startsWith(`@${copies}/`) && plant.endsWith('-Plant.cpp.obj.rsp'), plant);
		// a response file that does not exist stays
		assert.strictEqual(db[2].command, 'clang-cl.exe @"Missing.rsp" /c Other.cpp');

		// the copies refer to the copy of the shared response file. The forced include stays the file of UnrealBuildTool
		const sharedCopy = /@"([^"]+)"/.exec(readFileSync(actor, 'utf8'))?.[1];
		assert.ok(sharedCopy && path.posix.dirname(sharedCopy) === copies, sharedCopy);
		assert.ok(readFileSync(actor, 'utf8').includes(`/FI"${definitions}"`));
		assert.strictEqual(readFileSync(plant.slice(1), 'utf8'), `@"${sharedCopy}"\n/c\n`);
		// the copy of the earlier database is gone
		assert.strictEqual(readdirSync(path.join(dbFolder, 'rsp')).length, 3);

		// a normal build writes the response files of UnrealBuildTool again, with its precompiled header
		write(shared, '/Yu"SharedPCH.UnrealEd.h"\n');
		assert.strictEqual(readFileSync(sharedCopy, 'utf8'), '/I "Source"\n/DPLANT=1\n');
	});
});
