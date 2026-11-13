import { createHash } from 'crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { diffHunks, diffTexts, parseDiff, type ReviewFile } from './git';

// A mark keeps the text of the text files under its paths at one time, so get_diff and start_ripple can compare the
// files with it later, for example the changes of one step of a task with no commit. Each client has its own marks. A
// folder of the workspace storage keeps them, so they stay after a reload of the window:
//   > <storage>/<client>/<name>/mark.json: the name, the paths, the time and the list of the files
//   > <storage>/<client>/<name>/<n>.txt: the text of file n of the list

export const MAX_MARK_FILES = 500;
export const MAX_MARK_BYTES = 20 * 1024 * 1024;
export const MAX_MARKS = 20; // for each client
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

// The base of get_diff and start_ripple for a mark: mark:<name>
export const MARK_BASE = 'mark:';

export interface MarkInfo {
	name: string;
	client: string;
	paths: string[]; // the absolute paths of the files and the folders of the mark
	root: string; // the folder of the relative paths, for the facts
	time: number; // the time of the mark in ms
	bytes: number; // the size of the texts in UTF-8
	files: { file: string; copy: string }[]; // copy: the name of the copy of the text in the folder of the mark
}

// The files and the texts of a mark
export interface MarkSource {
	// the files under a path: a file, or the files of a folder with no build folders. Undefined if the path is not there
	files(full: string): Promise<string[] | undefined>;
	// the text of a file: the text of the editor, else the text on the disk. Undefined for a file that is not a text file
	text(file: string): Promise<string | undefined>;
}

// A key for a folder name: the name in lowercase with only safe characters, and a short hash, because the file systems
// of Windows and macOS do not use the case of the letters
const keyOf = (text: string): string =>
	`${text.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 40)}-${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;

// True for a text that is not a text file: a text with a zero character, as git decides
export const isBinaryText = (text: string): boolean => text.includes('\u0000');

export class MarkStore {
	constructor(private readonly dir: string) {}

	// The marks of a client, the newest first
	async list(client: string): Promise<MarkInfo[]> {
		const folder = path.join(this.dir, keyOf(client));
		let names: string[];
		try {
			names = await readdir(folder);
		} catch {
			return [];
		}
		const out: MarkInfo[] = [];
		for (const name of names) {
			const info = await readInfo(path.join(folder, name));
			if (info && info.client === client) {
				out.push(info);
			}
		}
		return out.sort((a, b) => b.time - a.time);
	}

	async get(client: string, name: string): Promise<MarkInfo | undefined> {
		return readInfo(this.folderOf(client, name));
	}

	// Makes a mark of the text files under the paths. A mark with the same name of the client goes away. A path that is
	// not there, too many files, too much text and too many marks give an error, and no mark changes
	async create(client: string, name: string, paths: readonly string[], root: string, source: MarkSource): Promise<MarkInfo> {
		if (!NAME.test(name)) {
			throw new Error('"name" must have 1 to 64 letters, digits, "_", "-" or ".", for example step-5.');
		}
		if (paths.length === 0) {
			throw new Error('Give "paths": the files and the folders of the mark.');
		}
		const old = await this.get(client, name);
		if (!old && (await this.list(client)).length >= MAX_MARKS) {
			throw new Error(`Your client has ${MAX_MARKS} marks, the maximum. Remove a mark with delete_mark first.`);
		}
		const files = new Map<string, string>();
		const missing: string[] = [];
		for (const p of paths) {
			const found = await source.files(p);
			if (!found) {
				missing.push(p);
				continue;
			}
			for (const f of found) {
				files.set(process.platform === 'win32' ? f.toLowerCase() : f, f);
			}
			if (files.size > MAX_MARK_FILES) {
				throw new Error(`The paths have more than ${MAX_MARK_FILES} files. Give paths with fewer files. No mark changed.`);
			}
		}
		if (missing.length > 0) {
			throw new Error(`These paths are not there: ${missing.join(', ')}. No mark changed.`);
		}
		// the texts: a file that is not a text file is not in the mark
		const texts: { file: string; text: string }[] = [];
		let bytes = 0;
		for (const file of [...files.values()].sort()) {
			const text = await source.text(file);
			if (text === undefined || isBinaryText(text)) {
				continue;
			}
			bytes += Buffer.byteLength(text, 'utf8');
			if (bytes > MAX_MARK_BYTES) {
				throw new Error(`The text files under the paths have more than ${MAX_MARK_BYTES / 1024 / 1024} MB. Give paths with fewer files. No mark changed.`);
			}
			texts.push({ file, text });
		}
		// the new mark goes into a new folder first, so an error keeps the old mark
		const folder = this.folderOf(client, name);
		const next = `${folder}.new`;
		await rm(next, { recursive: true, force: true });
		await mkdir(next, { recursive: true });
		const info: MarkInfo = {
			name, client, paths: [...paths], root, time: Date.now(), bytes, files: texts.map((t, i) => ({ file: t.file, copy: `${i + 1}.txt` })),
		};
		try {
			for (const [i, t] of texts.entries()) {
				await writeFile(path.join(next, `${i + 1}.txt`), t.text, 'utf8');
			}
			await writeFile(path.join(next, 'mark.json'), JSON.stringify(info), 'utf8');
			await rm(folder, { recursive: true, force: true });
			await renameFolder(next, folder);
		} catch (error) {
			await rm(next, { recursive: true, force: true });
			throw error;
		}
		return info;
	}

	// Removes a mark of a client. False if the client has no mark with the name
	async remove(client: string, name: string): Promise<boolean> {
		const folder = this.folderOf(client, name);
		if (!await readInfo(folder)) {
			return false;
		}
		await rm(folder, { recursive: true, force: true });
		return true;
	}

	// The text of each file of a mark at the time of the mark
	async texts(info: MarkInfo): Promise<Map<string, string>> {
		const folder = this.folderOf(info.client, info.name);
		const out = new Map<string, string>();
		for (const f of info.files) {
			out.set(f.file, await readFile(path.join(folder, f.copy), 'utf8'));
		}
		return out;
	}

	// The copy of the text of a file of a mark, for the diff editor. Undefined if the mark has no such file
	copyOf(info: MarkInfo, file: string): string | undefined {
		const key = (f: string) => (process.platform === 'win32' ? f.toLowerCase() : f);
		const entry = info.files.find((f) => key(f.file) === key(file));
		return entry && path.join(this.folderOf(info.client, info.name), entry.copy);
	}

	private folderOf(client: string, name: string): string {
		return path.join(this.dir, keyOf(client), keyOf(name));
	}
}

// The changes since a mark: the text of each file now against its text in the mark. A file under the paths of the mark
// that is not in the mark is a new file. A file of the mark that is not there now is a deleted file. isWanted selects the
// files, for example the C and C++ files
export async function markDiff(info: MarkInfo, before: ReadonlyMap<string, string>, source: MarkSource, isWanted: (file: string) => boolean):
	Promise<{ files: ReviewFile[]; deleted: string[]; other: string[] }> {
	const key = (f: string) => (process.platform === 'win32' ? f.toLowerCase() : f);
	const marked = new Map([...before].map(([file, text]) => [key(file), { file, text }]));
	const now = new Map<string, string>();
	for (const p of info.paths) {
		for (const f of (await source.files(p)) ?? []) {
			now.set(key(f), f);
		}
	}
	const files: ReviewFile[] = [];
	const other: string[] = [];
	for (const [k, file] of [...now].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const old = marked.get(k);
		const text = await source.text(file);
		if (text === undefined || isBinaryText(text) || text === old?.text) {
			continue;
		}
		if (!isWanted(file)) {
			other.push(file);
			continue;
		}
		const patch = await diffTexts(old?.text ?? '', text);
		const changes = parseDiff(patch ?? '');
		if (changes.lines.length > 0 || changes.deleted.length > 0) {
			files.push({ uri: vscode.Uri.file(file), changes, hunks: diffHunks(patch ?? ''), isNew: !old });
		}
	}
	const deleted = [...marked].filter(([k, m]) => !now.has(k) && isWanted(m.file)).map(([, m]) => m.file);
	return { files, deleted, other };
}

async function readInfo(folder: string): Promise<MarkInfo | undefined> {
	try {
		const info = JSON.parse(await readFile(path.join(folder, 'mark.json'), 'utf8')) as MarkInfo;
		return typeof info.name === 'string' && Array.isArray(info.files) ? info : undefined;
	} catch {
		return undefined;
	}
}

// A rename of a folder. A virus scanner can lock a new file for a short time on Windows, so a failed rename tries again
async function renameFolder(from: string, to: string): Promise<void> {
	const { rename } = await import('fs/promises');
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (attempt >= 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
		}
	}
}
