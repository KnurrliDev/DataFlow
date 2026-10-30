import { Dirent } from 'fs';
import { readdir } from 'fs/promises';
import * as path from 'path';
import { isCppFile } from '../review/git';

// A project that is not open in VS Code: DataFlow uses its compile database, and VS Code opens only its files. Its folder
// is not a workspace folder, so the extensions that start for a folder, for example CMake Tools and the Qt extensions,
// do not start for it, and they do not configure or build it.

// The list of files of a project has a maximum of this number of files
export const MAX_PROJECT_FILES = 20000;

// The names of the folders that the list of files skips: hidden folders, build folders, and the packages that CMake
// gets. The setting dataflow.project.skipFolders has the same default. A * is any text and a ? is one character
export const SKIP_FOLDERS = [
	'.*', 'node_modules', '_deps', 'out', 'build', 'builds', 'build-*', 'build_*', 'build.*', 'cmake-build-*',
	// the folders of an Unreal project with built and generated files
	'Binaries', 'DerivedDataCache', 'Intermediate', 'Saved',
];
// qmake writes the files of an in-source build into these folders, next to its Makefiles
const QMAKE_OUTPUT = /^(debug|release)$/i;

const sameName = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// The test for the names of the folders that the list skips. The case of the letters is not important
export function folderMatcher(patterns: readonly string[]): (name: string) => boolean {
	const sources = patterns.filter((p) => typeof p === 'string' && p.trim() !== '')
		.map((p) => p.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'));
	if (sources.length === 0) {
		return () => false;
	}
	const regex = new RegExp(`^(?:${sources.join('|')})$`, 'i');
	return (name) => regex.test(name);
}

// The C and C++ files of a project, in the sequence of their paths. The search skips the folders of skipFolders.
export async function findProjectFiles(root: string, limit = MAX_PROJECT_FILES, skipFolders: readonly string[] = SKIP_FOLDERS): Promise<string[]> {
	const isSkipped = folderMatcher(skipFolders);
	const out: string[] = [];
	const queue = [root];
	while (queue.length > 0 && out.length < limit) {
		const dir = queue.shift()!;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		const isQmakeBuild = entries.some((e) => /^Makefile\.(Debug|Release)$/.test(e.name));
		for (const e of entries) {
			if (e.isDirectory()) {
				if (!isSkipped(e.name) && !(isQmakeBuild && QMAKE_OUTPUT.test(e.name))) {
					queue.push(path.join(dir, e.name));
				}
			} else if (e.isFile() && isCppFile(e.name)) {
				out.push(path.join(dir, e.name));
			}
		}
	}
	return out.slice(0, limit).sort((a, b) => a.localeCompare(b));
}

// The deepest folder that contains all files, or undefined if only the root of the drive contains them
export function commonRoot(files: string[]): string | undefined {
	if (files.length === 0) {
		return undefined;
	}
	const folders = files.map((f) => path.dirname(path.resolve(f)).split(/[\\/]/).filter((p, i) => p !== '' || i === 0));
	let count = folders[0].length;
	for (const parts of folders) {
		let i = 0;
		while (i < count && i < parts.length && sameName(parts[i], folders[0][i])) {
			i++;
		}
		count = i;
	}
	return count > 1 ? folders[0].slice(0, count).join(path.sep) || path.sep : undefined;
}

// A build folder of a project file of Qt Creator: the folder itself, or with a prefix, each subfolder whose name starts
// with the prefix
export interface QtCreatorBuildFolder {
	folder: string;
	prefix?: string;
}

const BUILD_DIRECTORY = /<value type="QString" key="ProjectExplorer\.BuildConfiguration\.BuildDirectory">([^<]*)<\/value>/g;
const PROJECT_PATH = /%\{(?:ActiveProject|CurrentProject|Project):(?:NativePath|Path)\}/g;
const PROJECT_NAME = /%\{(?:ActiveProject|CurrentProject|Project):Name\}/g;

const decodeXml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
	.replace(/&amp;/g, '&');

// The build folders in a project file of Qt Creator, for example App.pro.user. Each build configuration has a
// template of its folder, for example "%{ActiveProject:NativePath}/builds/%{Project:Name}-%{Kit:FileSystemName}-Debug".
// The project gives its folder and its name. The part before the first other macro is a folder and the start of the
// names of its build folders. A relative folder is relative to the project folder.
export function qtCreatorBuildFolders(userFile: string, root: string, projectName: string): QtCreatorBuildFolder[] {
	const out: QtCreatorBuildFolder[] = [];
	for (const match of userFile.matchAll(BUILD_DIRECTORY)) {
		const template = decodeXml(match[1]).replace(PROJECT_PATH, root).replace(PROJECT_NAME, projectName).trim();
		const cut = template.indexOf('%{');
		const fixed = cut >= 0 ? template.slice(0, cut) : template;
		if (fixed === '') {
			continue;
		}
		if (cut < 0) {
			out.push({ folder: path.resolve(root, fixed) });
		} else if (/[\\/]$/.test(fixed)) {
			out.push({ folder: path.resolve(root, fixed), prefix: '' });
		} else {
			const at = path.resolve(root, fixed);
			out.push({ folder: path.dirname(at), prefix: path.basename(at) });
		}
	}
	const seen = new Set<string>();
	return out.filter((f) => {
		const key = `${f.folder}|${f.prefix ?? '='}`;
		return !seen.has(key) && seen.add(key);
	});
}

// True if the file is in the folder or in a folder below it
export function isInside(file: string, folder: string): boolean {
	const rel = path.relative(folder, file);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
