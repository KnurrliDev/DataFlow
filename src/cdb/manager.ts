import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { mkdir, open, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { commonRoot, isInside, qtCreatorBuildFolders } from './project';
import { QMAKE_MAKEFILES, qmakeEntries } from './qmake';
import { findUnrealProject, UNREAL_DB_FOLDER } from './unreal';

export interface CompileDbInfo {
	path: string;
	source: 'setting' | 'cmake-tools' | 'qmake' | 'qt-creator' | 'unreal' | 'found';
	folder: string;
	makefile?: string; // the qmake Makefile that the database comes from
}

// A project that is not open in VS Code: its folder and the compile database that DataFlow uses for it. cdb/project.ts
// tells why DataFlow does not open the folder.
export interface ProjectInfo {
	root: string; // the folder of the sources
	name: string;
	db: CompileDbInfo;
}

// The part of the CMake Tools API that DataFlow uses. The API object comes from the exports of the extension.
interface CMakeToolsApi {
	getProject(uri: vscode.Uri): Promise<{ getBuildDirectory(): Promise<string | undefined> } | undefined>;
}

const DB_FILE = 'compile_commands.json';
const SELECTION_KEY = 'dataflow.compileCommands.selection';
// The project of the window, and the last projects of all windows
const PROJECT_KEY = 'dataflow.project';
const RECENT_KEY = 'dataflow.recentProjects';
const MAX_RECENT = 5;

export class CompileDbManager implements vscode.Disposable {
	private watchers: vscode.FileSystemWatcher[] = [];
	private searchWatchers: vscode.FileSystemWatcher[] = [];
	private searchFolders: vscode.WorkspaceFolder[] = []; // the workspace folders with no compile database
	private searchDebounce?: NodeJS.Timeout;
	private debounce?: NodeJS.Timeout;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;
	private current: CompileDbInfo[] = [];

	constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
		void this.setContextKey();
	}

	get databases(): CompileDbInfo[] {
		return this.current;
	}

	// The project of this window, if the user selected one
	get project(): ProjectInfo | undefined {
		return this.context.workspaceState.get<ProjectInfo>(PROJECT_KEY);
	}

	// The last projects, also of other windows. The newest comes first.
	get recentProjects(): ProjectInfo[] {
		return this.context.globalState.get<ProjectInfo[]>(RECENT_KEY, []).filter((p) => existsSync(p.root));
	}

	// Finds the compile databases of the project and of all workspace folders, and watches them.
	async discover(): Promise<CompileDbInfo[]> {
		const found: CompileDbInfo[] = [];
		const project = this.project;
		if (project) {
			const info = await this.fromPath(project.db.makefile ? path.dirname(project.db.makefile) : project.db.path, project.root);
			if (info) {
				found.push(info);
			} else {
				this.log.warn(`The project ${project.root} has no compile database at ${project.db.makefile ?? project.db.path}.`);
			}
		}
		const empty: vscode.WorkspaceFolder[] = [];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const dbs = await this.forFolder(folder);
			if (dbs.length === 0) {
				empty.push(folder);
			}
			found.push(...dbs);
		}
		const unique = [...new Map(found.map((db) => [pathKey(db.path), db])).values()];
		this.current = unique;
		this.watch(unique);
		this.watchSearch(empty);
		return unique;
	}

	// The compile databases of a folder that is not a workspace folder: the folder as a build folder, and its build
	// folders. The newest comes first.
	async candidatesOf(folder: string): Promise<CompileDbInfo[]> {
		return newestFirst(await this.fromBuildFolders(folder));
	}

	// Makes a folder the project of DataFlow. With more than one compile database, pick selects one. The engine starts
	// again with the database of the project.
	async useProject(folder: string, pick: (candidates: CompileDbInfo[]) => Thenable<CompileDbInfo | undefined>): Promise<ProjectInfo | undefined> {
		const candidates = await this.candidatesOf(folder);
		if (candidates.length === 0) {
			const unreal = findUnrealProject(folder);
			vscode.window.showWarningMessage(unreal
				? `${unreal.name} is an Unreal project with no compile database. Open its folder in VS Code, and run "DataFlow: Make Unreal Compile Database".`
				: `DataFlow found no compile_commands.json and no qmake build folder in ${folder}. Select the folder of the project or its build folder.`);
			return undefined;
		}
		const db = candidates.length === 1 ? candidates[0] : await pick(candidates);
		if (!db) {
			return undefined;
		}
		const root = await this.sourceRoot(folder, db);
		const project = { root, name: path.basename(root), db: { ...db, folder: root } };
		await this.setProject(project);
		return project;
	}

	async setProject(project: ProjectInfo): Promise<void> {
		await this.context.workspaceState.update(PROJECT_KEY, project);
		const recent = [project, ...this.context.globalState.get<ProjectInfo[]>(RECENT_KEY, []).filter((p) => p.root !== project.root)];
		await this.context.globalState.update(RECENT_KEY, recent.slice(0, MAX_RECENT));
		await this.setContextKey();
		this.changeEmitter.fire();
	}

	async closeProject(): Promise<void> {
		if (this.project) {
			await this.context.workspaceState.update(PROJECT_KEY, undefined);
			await this.setContextKey();
			this.changeEmitter.fire();
		}
	}

	// Shows all candidates of the first workspace folder, or of the project, and keeps the selection.
	async select(): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const project = this.project;
		if (!folder && project) {
			const candidates = await this.candidatesOf(project.root);
			const pick = await vscode.window.showQuickPick(
				candidates.map((c) => ({ label: path.relative(project.root, c.makefile ?? c.path) || c.path, description: c.source, info: c })),
				{ placeHolder: `Select the compile database of ${project.name}` });
			if (pick) {
				await this.setProject({ ...project, db: { ...pick.info, folder: project.root } });
			}
			return;
		}
		if (!folder) {
			await vscode.commands.executeCommand('dataflow.openProject');
			return;
		}
		const candidates = newestFirst(await this.fromBuildFolders(folder.uri.fsPath));
		if (candidates.length === 0) {
			vscode.window.showWarningMessage('DataFlow found no compile_commands.json and no qmake build folder.');
			return;
		}
		const pick = await vscode.window.showQuickPick(
			candidates.map((c) => ({ label: path.relative(folder.uri.fsPath, c.makefile ?? c.path) || c.path, description: c.source, info: c })),
			{ placeHolder: 'Select the compile database for DataFlow' });
		if (pick) {
			await this.context.workspaceState.update(SELECTION_KEY, pick.info);
			this.changeEmitter.fire();
		}
	}

	dispose(): void {
		this.watchers.forEach((w) => w.dispose());
		this.searchWatchers.forEach((w) => w.dispose());
		this.changeEmitter.dispose();
		clearTimeout(this.debounce);
		clearTimeout(this.searchDebounce);
	}

	private async forFolder(folder: vscode.WorkspaceFolder): Promise<CompileDbInfo[]> {
		const root = folder.uri.fsPath;

		// 1. the setting: a file, a folder with compile_commands.json, or a qmake build folder
		const setting = vscode.workspace.getConfiguration('dataflow', folder.uri).get<string | string[]>('compileCommands');
		const entries = (Array.isArray(setting) ? setting : setting ? [setting] : []).map((p) => path.resolve(root, p));
		if (entries.length > 0) {
			const out: CompileDbInfo[] = [];
			for (const entry of entries) {
				const info = await this.fromPath(entry, root);
				if (info) {
					out.push({ ...info, source: 'setting' });
				} else {
					this.log.warn(`dataflow.compileCommands: no compile database at ${entry}`);
				}
			}
			return out;
		}

		// 2. a selection from the "Select Compile Database" command
		const selected = this.context.workspaceState.get<CompileDbInfo>(SELECTION_KEY);
		if (selected && selected.folder === root) {
			const info = await this.fromPath(selected.makefile ? path.dirname(selected.makefile) : selected.path, root);
			if (info) {
				return [info];
			}
		}

		// 3. the build folder of CMake Tools
		const cmake = await this.fromCMakeTools(folder);
		if (cmake) {
			return [cmake];
		}

		// 4. the build folders. The newest database wins.
		const candidates = newestFirst(await this.fromBuildFolders(root));
		if (candidates.length > 1) {
			this.log.info(`${candidates.length} compile databases for ${root}. DataFlow uses the newest. Run "DataFlow: Select Compile Database" to change it.`);
		}
		return candidates.slice(0, 1);
	}

	// A compile_commands.json file, a folder with one, or a qmake build folder.
	private async fromPath(entry: string, root: string): Promise<CompileDbInfo | undefined> {
		if (!existsSync(entry)) {
			return undefined;
		}
		if (statSync(entry).isFile()) {
			return { path: entry, source: 'found', folder: root };
		}
		if (existsSync(path.join(entry, DB_FILE))) {
			return { path: path.join(entry, DB_FILE), source: 'found', folder: root };
		}
		// Qt Creator writes a database for clangd into each build folder
		if (existsSync(path.join(entry, '.qtc_clangd', DB_FILE))) {
			return { path: path.join(entry, '.qtc_clangd', DB_FILE), source: 'qt-creator', folder: root };
		}
		return this.convertQmake(entry, root);
	}

	// The build folder of CMake Tools. DataFlow asks CMake Tools only if it runs already, because an activation of CMake
	// Tools can make it configure the project.
	private async fromCMakeTools(folder: vscode.WorkspaceFolder): Promise<CompileDbInfo | undefined> {
		const ext = vscode.extensions.getExtension('ms-vscode.cmake-tools');
		if (!ext?.isActive) {
			return undefined;
		}
		try {
			const api = ext.exports?.getApi?.(1) as CMakeToolsApi | undefined;
			const dir = await (await api?.getProject(folder.uri))?.getBuildDirectory();
			const file = dir ? path.join(dir, DB_FILE) : undefined;
			if (file && existsSync(file)) {
				return { path: file, source: 'cmake-tools', folder: folder.uri.fsPath };
			}
			if (dir) {
				this.log.warn(`CMake Tools uses ${dir}, but it has no ${DB_FILE}. Configure with CMAKE_EXPORT_COMPILE_COMMANDS=ON and the Ninja or Makefile generator.`);
			}
		} catch (error) {
			this.log.warn(`The CMake Tools API is not available: ${error}`);
		}
		return undefined;
	}

	// The databases of the build folders of a project. An Unreal project also has the database that UnrealBuildTool
	// writes for DataFlow. The databases of the VS Code project files of Unreal (.vscode/compileCommands_<name>.json) do
	// not count: their commands are for IntelliSense, with no source file and no C++ standard
	private async fromBuildFolders(root: string): Promise<CompileDbInfo[]> {
		const out: CompileDbInfo[] = [];
		const unrealFolder = findUnrealProject(root) ? pathKey(path.join(root, UNREAL_DB_FOLDER)) : undefined;
		for (const dir of this.buildFolders(root)) {
			const info = await this.fromPath(dir, root);
			if (info) {
				out.push(pathKey(dir) === unrealFolder ? { ...info, source: 'unreal' } : info);
			}
		}
		return [...new Map(out.map((db) => [pathKey(db.makefile ?? db.path), db])).values()];
	}

	// The folders where a build of a project can be:
	// > the project folder, for a build in the sources
	// > its build folders: the folders with a name that starts with build, cmake-build-* and out/build, and their
	//   subfolders, for example build/Desktop_Qt_6_8_MSVC2022_64bit-Debug of Qt Creator or out/build/x64-debug of a
	//   CMake preset
	// > the build folders of Qt Creator next to the project: build-<name>-<kit>-<configuration>, with the name of the
	//   folder or of a .pro file
	// > the build folders in the project files of Qt Creator (*.user), also outside of the project
	// > for an Unreal project, the folder Intermediate/DataFlow, where UnrealBuildTool writes the database for DataFlow
	private buildFolders(root: string): string[] {
		const parent = path.dirname(root);
		const names = [path.basename(root), ...readdirSafe(root).filter((n) => n.endsWith('.pro')).map((n) => n.slice(0, -'.pro'.length))]
			.map((n) => `build-${n.toLowerCase()}`);
		const top = [
			...readdirSafe(root).filter((n) => /^(build.*|cmake-build-.*)$/i.test(n)).map((n) => path.join(root, n)),
			path.join(root, 'out', 'build'),
			...readdirSafe(parent).filter((n) => names.some((b) => n.toLowerCase().startsWith(b))).map((n) => path.join(parent, n)),
		].filter(isFolder);
		const nested = top.flatMap((dir) => readdirSafe(dir).map((n) => path.join(dir, n)).filter(isFolder));
		const unreal = findUnrealProject(root) ? [path.join(root, UNREAL_DB_FOLDER)] : [];
		return [...new Map([root, ...top, ...nested, ...this.qtCreatorFolders(root), ...unreal].map((dir) => [pathKey(dir), dir])).values()];
	}

	// The build folders of the project files of Qt Creator in the project folder and in its folder .qtcreator
	private qtCreatorFolders(root: string): string[] {
		const files = [
			...readdirSafe(root).filter((n) => n.endsWith('.user')).map((n) => path.join(root, n)),
			...readdirSafe(path.join(root, '.qtcreator')).filter((n) => n.endsWith('.user')).map((n) => path.join(root, '.qtcreator', n)),
		];
		const out: string[] = [];
		for (const file of files) {
			// App.pro.user is the file of App.pro. The name of a CMake project is the name of its folder
			const base = path.basename(file).replace(/\.user$/, '');
			const name = base.endsWith('.pro') ? base.slice(0, -'.pro'.length) : path.basename(root);
			let text: string;
			try {
				text = readFileSync(file, 'utf8');
			} catch {
				continue;
			}
			for (const f of qtCreatorBuildFolders(text, root, name)) {
				if (f.prefix === undefined) {
					out.push(f.folder);
				} else {
					const prefix = f.prefix.toLowerCase();
					out.push(...readdirSafe(f.folder).filter((n) => n.toLowerCase().startsWith(prefix)).map((n) => path.join(f.folder, n)));
				}
			}
		}
		return out.filter(isFolder);
	}

	// The folder of the sources of a project: the selected folder if it has a CMake or qmake project file, else a folder
	// above it with one, else the deepest folder that contains the files of the compile database.
	private async sourceRoot(folder: string, db: CompileDbInfo): Promise<string> {
		const isProject = (dir: string) => existsSync(path.join(dir, 'CMakeLists.txt')) || readdirSafe(dir).some((n) => n.endsWith('.pro'));
		for (let dir = folder, up = 0; up <= 3; dir = path.dirname(dir), up++) {
			if (isProject(dir)) {
				return dir;
			}
			if (path.dirname(dir) === dir) {
				break;
			}
		}
		try {
			const entries = JSON.parse(await readFile(db.path, 'utf8')) as { directory: string; file: string }[];
			return commonRoot(entries.map((e) => path.resolve(e.directory, e.file))) ?? folder;
		} catch {
			return folder;
		}
	}

	private async setContextKey(): Promise<void> {
		await vscode.commands.executeCommand('setContext', 'dataflow.hasProject', !!this.project);
	}

	// Writes compile_commands.json for a qmake build folder into the storage of the extension.
	private async convertQmake(buildDir: string, root: string): Promise<CompileDbInfo | undefined> {
		const makefile = QMAKE_MAKEFILES.map((m) => path.join(buildDir, m)).find((m) => existsSync(m));
		if (!makefile || !(await isQmakeMakefile(makefile))) {
			return undefined;
		}
		const entries = qmakeEntries(await readFile(makefile, 'utf8'), buildDir);
		if (entries.length === 0) {
			return undefined;
		}
		const storage = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
		const dir = path.join(storage, 'qmake', createHash('sha1').update(buildDir.toLowerCase()).digest('hex').slice(0, 12));
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, DB_FILE);
		await writeFile(file, JSON.stringify(entries, null, 2));
		this.log.info(`qmake: ${entries.length} entries from ${makefile}`);
		return { path: file, source: 'qmake', folder: root, makefile };
	}

	// Looks for the compile databases again after a short pause, for example after a tool wrote a new database. A watcher
	// event of the new file in the pause gives no second change, so the engine starts only one time
	refresh(): void {
		this.fireChange();
	}

	private fireChange(): void {
		clearTimeout(this.debounce);
		this.debounce = setTimeout(() => this.changeEmitter.fire(), 1000);
	}

	private watch(dbs: CompileDbInfo[]): void {
		this.watchers.forEach((w) => w.dispose());
		this.watchers = dbs.map((db) => {
			const file = db.makefile ?? db.path;
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
			const fire = () => this.fireChange();
			watcher.onDidChange(fire);
			watcher.onDidCreate(fire);
			watcher.onDidDelete(fire);
			return watcher;
		});
	}

	// The workspace folders with no compile database: DataFlow watches the places of the search. Thus a database that comes
	// later, for example from a CMake preset, starts the engine. The places are the folder, its build folders, also the build
	// folders next to it, and a new build folder next to it, for example ../build-App-Desktop-Debug of Qt Creator.
	private watchSearch(folders: vscode.WorkspaceFolder[]): void {
		this.searchFolders = folders;
		this.searchWatchers.forEach((w) => w.dispose());
		this.searchWatchers = [];
		const files = `**/{${[DB_FILE, ...QMAKE_MAKEFILES].join(',')}}`;
		const watch = (base: vscode.WorkspaceFolder | vscode.Uri, pattern: string, fire: (uri: vscode.Uri) => void, isCreateOnly = false) => {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern), false, isCreateOnly, true);
			watcher.onDidCreate(fire);
			watcher.onDidChange(fire);
			this.searchWatchers.push(watcher);
		};
		for (const folder of folders) {
			const root = folder.uri.fsPath;
			const onFile = (uri: vscode.Uri) => {
				if (this.isSearchPlace(folder, uri.fsPath)) {
					this.log.info(`${uri.fsPath} changed. DataFlow looks for the compile database again.`);
					this.fireChange();
				}
			};

			// the folder, and the build folders outside of it, for example ../build-App-Desktop-Debug of Qt Creator
			watch(folder, files, onFile);
			for (const dir of this.outsideBuildFolders(root)) {
				watch(vscode.Uri.file(dir), files, onFile);
			}

			// a new build folder next to the folder: a watcher of the parent folder with no subfolders. The new folder gets
			// its own watcher. A build can write the database before that watcher starts, so DataFlow also looks for it
			const parent = path.dirname(root);
			if (parent === root) {
				continue;
			}
			watch(vscode.Uri.file(parent), '{build-*,Build-*}', (uri) => {
				if (!this.buildFolders(root).some((dir) => pathKey(dir) === pathKey(uri.fsPath))) {
					return;
				}
				clearTimeout(this.searchDebounce);
				this.searchDebounce = setTimeout(() => {
					this.watchSearch(this.searchFolders);
					void this.fromBuildFolders(root).then((dbs) => {
						if (dbs.length > 0) {
							this.log.info(`${uri.fsPath} has a compile database. DataFlow starts the engine again.`);
							this.fireChange();
						}
					});
				}, 500);
			}, true);
		}
	}

	// The build folders of a folder that are outside of it, with no folder that is inside a different one of them
	private outsideBuildFolders(root: string): string[] {
		const outside = this.buildFolders(root).filter((dir) => pathKey(dir) !== pathKey(root) && !isInside(dir, root));
		return outside.filter((dir) => !outside.some((other) => other !== dir && isInside(dir, other)));
	}

	// true if the search of a workspace folder looks at the file: a file of the setting dataflow.compileCommands, or a file
	// in the folder, in one of its build folders or in the folder .qtc_clangd of a build folder
	private isSearchPlace(folder: vscode.WorkspaceFolder, file: string): boolean {
		const root = folder.uri.fsPath;
		const setting = vscode.workspace.getConfiguration('dataflow', folder.uri).get<string | string[]>('compileCommands');
		const entries = (Array.isArray(setting) ? setting : setting ? [setting] : []).map((p) => path.resolve(root, p));
		let dir = path.dirname(file);
		if (path.basename(dir) === '.qtc_clangd') {
			dir = path.dirname(dir);
		}
		const places = entries.length > 0 ? entries : this.buildFolders(root);
		return places.some((p) => pathKey(p) === pathKey(dir) || pathKey(p) === pathKey(file));
	}
}

// The paths of Windows can have a different case
const pathKey = (file: string) => (process.platform === 'win32' ? file.toLowerCase() : file);

const newestFirst = (dbs: CompileDbInfo[]) => [...dbs].sort((a, b) => mtime(b.makefile ?? b.path) - mtime(a.makefile ?? a.path));

function isFolder(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

// qmake writes "Generated by qmake" in the first lines of its Makefiles. A Makefile of CMake does not have it.
async function isQmakeMakefile(file: string): Promise<boolean> {
	try {
		const handle = await open(file, 'r');
		try {
			const buffer = Buffer.alloc(1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.toString('utf8', 0, bytesRead).includes('Generated by qmake');
		} finally {
			await handle.close();
		}
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

function mtime(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}
