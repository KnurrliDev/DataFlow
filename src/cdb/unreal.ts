import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

// An Unreal Engine project: a .uproject file in the root folder of the project. UnrealBuildTool (UBT) writes the compile
// database of the project with its mode GenerateClangDatabase. For this mode, UBT turns off the precompiled headers and
// the unity builds, and it runs UnrealHeaderTool first, so the .generated.h files exist. DataFlow lets UBT write the
// database into Intermediate/DataFlow of the project, because Unreal projects keep Intermediate out of git. Then DataFlow
// copies the response files of the commands into Intermediate/DataFlow/rsp (see writeUnrealDatabase).

const execFileAsync = promisify(execFile);

export const UNREAL_DB_FOLDER = path.join('Intermediate', 'DataFlow');
export const UNREAL_DB_FILE = 'compile_commands.json';
// UBT writes this file. DataFlow writes UNREAL_DB_FILE from it, so the watchers of the database see only one change
export const UBT_DB_FILE = 'compile_commands.ubt.json';
// The folder of the copies of the response files, in UNREAL_DB_FOLDER
export const UNREAL_RSP_FOLDER = 'rsp';

export interface UnrealProject {
	file: string; // the .uproject file
	root: string; // the folder of the .uproject file
	name: string; // the name of the project: the name of the .uproject file
	engineAssociation: string; // a version of an installed engine, for example 5.8, the GUID of a source build, or empty
	hasSource: boolean; // the project has C++ code in its folder Source
}

export interface UnrealTarget {
	name: string; // for example MyGameEditor, from MyGameEditor.Target.cs
	type?: string; // Game, Editor, Client, Server or Program
}

// The Unreal project in a folder, or undefined if the folder has no .uproject file
export function findUnrealProject(root: string): UnrealProject | undefined {
	const name = readdirSafe(root).find((n) => n.toLowerCase().endsWith('.uproject'));
	if (!name) {
		return undefined;
	}
	const file = path.join(root, name);
	let engineAssociation = '';
	try {
		const json = JSON.parse(readFileSync(file, 'utf8')) as { EngineAssociation?: unknown };
		engineAssociation = typeof json.EngineAssociation === 'string' ? json.EngineAssociation.trim() : '';
	} catch {
		// a .uproject that is not JSON: the engine comes from the setting or from a folder above
	}
	return { file, root, name: name.slice(0, -'.uproject'.length), engineAssociation, hasSource: existsSync(path.join(root, 'Source')) };
}

// The database that UBT writes for DataFlow
export const unrealDbPath = (root: string) => path.join(root, UNREAL_DB_FOLDER, UNREAL_DB_FILE);

// The targets of the project, from the files Source/<name>.Target.cs. The type comes from "Type = TargetType.<type>"
export function unrealTargets(root: string): UnrealTarget[] {
	const dir = path.join(root, 'Source');
	return readdirSafe(dir).filter((n) => n.endsWith('.Target.cs')).sort().map((n) => {
		let type: string | undefined;
		try {
			type = /Type\s*=\s*TargetType\.(\w+)/.exec(readFileSync(path.join(dir, n), 'utf8'))?.[1];
		} catch {
			// no type
		}
		return { name: n.slice(0, -'.Target.cs'.length), ...(type ? { type } : {}) };
	});
}

// The target for the database: the target of the setting, else the editor target of the project, because it has the
// code of the game and of the editor
export function defaultTarget(targets: readonly UnrealTarget[], projectName: string, setting = ''): UnrealTarget | undefined {
	if (setting) {
		return targets.find((t) => t.name.toLowerCase() === setting.toLowerCase()) ?? { name: setting };
	}
	return targets.find((t) => t.name.toLowerCase() === `${projectName}editor`.toLowerCase())
		?? targets.find((t) => t.type === 'Editor')
		?? targets.find((t) => t.name.toLowerCase() === projectName.toLowerCase())
		?? targets[0];
}

// The program of UBT in an engine. Unreal Engine 5 has it in a folder of its own
export function ubtProgram(engineRoot: string): string | undefined {
	const dir = path.join(engineRoot, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool');
	return ['UnrealBuildTool.exe', 'UnrealBuildTool'].map((n) => path.join(dir, n)).find((f) => existsSync(f));
}

// The folder of an engine: the folder with the folder Engine. A path to the folder Engine also works
export function engineRootOf(dir: string): string | undefined {
	const normal = path.resolve(dir);
	if (ubtProgram(normal)) {
		return normal;
	}
	return path.basename(normal).toLowerCase() === 'engine' && ubtProgram(path.dirname(normal)) ? path.dirname(normal) : undefined;
}

// The places where an engine can be, from the setting, the folders above the project, the registry of Windows and the
// list of the installations of the Epic Games Launcher
export interface EngineSources {
	setting?: string; // dataflow.unreal.enginePath
	registry?: (key: string, value?: string) => Promise<string | undefined>; // a value of the registry of Windows
	launcherInstalls?: () => { appName: string; location: string }[]; // LauncherInstalled.dat of the Epic Games Launcher
}

// The folder of the engine of a project. Undefined if no engine with UBT is there
export async function findEngine(project: UnrealProject, sources: EngineSources): Promise<string | undefined> {
	if (sources.setting) {
		return engineRootOf(sources.setting);
	}
	const association = project.engineAssociation;
	const candidates: string[] = [];
	// no association: the project is in the folder of a source build of the engine
	if (!association) {
		for (let dir = path.dirname(project.root); dir !== path.dirname(dir); dir = path.dirname(dir)) {
			if (ubtProgram(dir)) {
				return dir;
			}
		}
		return undefined;
	}
	// the GUID of a source build: the registry of the user has its folder
	if (/^\{[0-9a-f-]+\}$/i.test(association)) {
		const dir = await sources.registry?.('HKCU\\Software\\Epic Games\\Unreal Engine\\Builds', association);
		if (dir) {
			candidates.push(dir);
		}
	} else {
		const dir = await sources.registry?.(`HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${association}`, 'InstalledDirectory');
		if (dir) {
			candidates.push(dir);
		}
		candidates.push(...(sources.launcherInstalls?.() ?? []).filter((i) => i.appName === `UE_${association}`).map((i) => i.location));
		candidates.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Epic Games', `UE_${association}`));
	}
	return candidates.map(engineRootOf).find((d): d is string => !!d);
}

// A value of the registry of Windows, with the program reg. Undefined if the key or the value does not exist
export async function readRegistry(key: string, value?: string): Promise<string | undefined> {
	if (process.platform !== 'win32') {
		return undefined;
	}
	try {
		const { stdout } = await execFileAsync('reg', ['query', key, ...(value ? ['/v', value] : ['/ve'])], { windowsHide: true });
		const line = stdout.split(/\r?\n/).find((l) => /\sREG_(EXPAND_)?SZ\s/.test(l));
		return line?.replace(/^.*?\sREG_(EXPAND_)?SZ\s+/, '').trim() || undefined;
	} catch {
		return undefined;
	}
}

// The installations of the Epic Games Launcher, from its file LauncherInstalled.dat
export function launcherInstalls(): { appName: string; location: string }[] {
	const file = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
	try {
		const json = JSON.parse(readFileSync(file, 'utf8')) as { InstallationList?: { AppName?: string; InstallLocation?: string }[] };
		return (json.InstallationList ?? []).filter((i) => i.AppName && i.InstallLocation).map((i) => ({ appName: i.AppName!, location: i.InstallLocation! }));
	} catch {
		return [];
	}
}

// The platform of UBT for this computer
export function ubtPlatform(platform = process.platform): string {
	return platform === 'win32' ? 'Win64' : platform === 'darwin' ? 'Mac' : 'Linux';
}

// The arguments of UBT for the compile database of a target. -WaitMutex waits for a different UBT, for example of a
// build in Visual Studio. The extra arguments come last, so they can change the compiler, for example
// -Compiler=VisualStudio2022
export function ubtArguments(project: UnrealProject, target: string, configuration: string, extra: readonly string[] = []): string[] {
	return [
		target, ubtPlatform(), configuration, `-Project=${project.file}`, '-Mode=GenerateClangDatabase',
		`-OutputDir=${path.join(project.root, UNREAL_DB_FOLDER)}`, `-OutputFilename=${UBT_DB_FILE}`, '-WaitMutex', ...extra,
	];
}

interface DbEntry {
	directory: string;
	file: string;
	command?: string;
	arguments?: string[];
}

// A response file in a command or in a response file: @"<file>", "@<file>" or @<file> at the start of an argument
const RESPONSE_FILE = /(^|\s)(?:@"([^"]+)"|"@([^"]+)"|@([^\s"]+))/g;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// Writes the database of DataFlow from the database of UBT, and removes the file of UBT. Returns the number of copies of
// response files. UBT writes the response files of the commands into the build folders of the modules, for example
// Intermediate/Build/Win64/x64/UnrealEditor/Development/<module>/<file>.cpp.obj.rsp. With an installed engine, a normal
// build writes the same files again, with the options of its compiler and of its precompiled headers, and a parse with
// these options fails. Only a source build of the engine gives the database a folder of its own (UnrealEditorGCD). Thus
// the database of DataFlow uses copies of the response files in the folder rsp next to it. The forced include
// Definitions.h stays: a build with precompiled headers writes Definitions.<module>.h, and a build with none writes the
// same Definitions.h
export async function writeUnrealDatabase(ubtFile: string, dbFile: string): Promise<number> {
	const entries = JSON.parse(await readFile(ubtFile, 'utf8')) as DbEntry[];
	const dir = path.join(path.dirname(dbFile), UNREAL_RSP_FOLDER);
	await mkdir(dir, { recursive: true });
	const copies = new Map<string, string>(); // the key of a response file -> its copy

	// copies a response file and the response files in it. A relative path starts at the folder of the response file that
	// contains it, else at the folder of the command. Undefined if the file does not exist
	const copy = async (ref: string, bases: readonly string[]): Promise<string | undefined> => {
		const file = bases.map((b) => path.resolve(b, ref)).find(isFile);
		if (!file) {
			return undefined;
		}
		const key = keyOf(file);
		const known = copies.get(key);
		if (known) {
			return known;
		}
		const target = path.join(dir, `${createHash('sha1').update(key).digest('hex').slice(0, 10)}-${path.basename(file)}`);
		copies.set(key, target);
		const data = await readFile(file);
		// a response file in UTF-16 goes as it is: its response files stay the files of UBT
		if (data[0] === 0xff && data[1] === 0xfe) {
			await writeFile(target, data);
			return target;
		}
		const bom = data.subarray(0, 3).equals(UTF8_BOM) ? UTF8_BOM : Buffer.alloc(0);
		const text = await replaceResponseFiles(data.subarray(bom.length).toString('utf8'), (r) => copy(r, [path.dirname(file), ...bases]));
		await writeFile(target, Buffer.concat([bom, Buffer.from(text, 'utf8')]));
		return target;
	};

	for (const entry of entries) {
		const bases = [entry.directory];
		if (typeof entry.command === 'string') {
			entry.command = await replaceResponseFiles(entry.command, (r) => copy(r, bases));
		}
		if (Array.isArray(entry.arguments)) {
			const args: string[] = [];
			for (const arg of entry.arguments) {
				const target = arg.startsWith('@') ? await copy(arg.slice(1), bases) : undefined;
				args.push(target ? `@${slashes(target)}` : arg);
			}
			entry.arguments = args;
		}
	}

	// the copies of an earlier database that this database does not use
	const used = new Set([...copies.values()].map((f) => path.basename(f).toLowerCase()));
	for (const name of await readdir(dir)) {
		if (!used.has(name.toLowerCase())) {
			await rm(path.join(dir, name), { recursive: true, force: true });
		}
	}
	await writeFile(dbFile, JSON.stringify(entries, null, '\t'));
	await rm(ubtFile, { force: true });
	return copies.size;
}

// Puts the copy of each response file into a text. A response file with no copy stays
async function replaceResponseFiles(text: string, copy: (ref: string) => Promise<string | undefined>): Promise<string> {
	let out = '';
	let last = 0;
	for (const m of text.matchAll(RESPONSE_FILE)) {
		const target = await copy(m[2] ?? m[3] ?? m[4]);
		if (target) {
			const start = (m.index ?? 0) + m[1].length;
			out += `${text.slice(last, start)}@"${slashes(target)}"`;
			last = (m.index ?? 0) + m[0].length;
		}
	}
	return out + text.slice(last);
}

// UBT writes paths with forward slashes. A backslash before a quote is an escape in a command of Windows
const slashes = (file: string) => file.split(path.sep).join('/');
const keyOf = (file: string) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
