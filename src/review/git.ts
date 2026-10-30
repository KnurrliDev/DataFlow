import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

// The parts of the API of the git extension of VS Code that DataFlow uses.
// The full API is in extensions/git/src/api/git.d.ts in the source code of VS Code.
interface GitChange {
	readonly uri: vscode.Uri;
	readonly status: number;
}

interface GitRef {
	readonly type: number; // RefType in git.d.ts
	readonly name?: string;
}

interface GitRepository {
	readonly rootUri: vscode.Uri;
	getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
	getRefs(query: { pattern?: string[]; sort?: 'alphabetically' | 'committerdate' }): Promise<GitRef[]>;
	diffWith(ref: string): Promise<GitChange[]>;
	diffWith(ref: string, path: string): Promise<string>;
}

type GitApiState = 'uninitialized' | 'initialized';

interface GitApi {
	readonly git: { readonly path: string };
	readonly state: GitApiState;
	readonly onDidChangeState: vscode.Event<GitApiState>;
	getRepository(uri: vscode.Uri): GitRepository | null;
	openRepository(root: vscode.Uri): Promise<GitRepository | null>;
	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

interface GitExtension {
	getAPI(version: 1): GitApi;
}

// Status.INDEX_DELETED and Status.DELETED in git.d.ts
const DELETED = new Set([2, 6]);

// RefType.Head and RefType.RemoteHead in git.d.ts
const LOCAL_BRANCH = 0;
const REMOTE_BRANCH = 1;

const execFileAsync = promisify(execFile);

// The git extension finds the repositories of the workspace after it starts. This is the maximum wait.
const GIT_START_MS = 10000;

// The maximum size of the output of git, for example the text of a large file at the base
const GIT_MAX_OUTPUT = 64 * 1024 * 1024;

// The extensions of C and C++ files. An .inc file has code that a different file includes, for example a part of a
// unity build.
const CPP_FILE = /\.(c|cc|cpp|cxx|c\+\+|cu|h|hh|hpp|hxx|h\+\+|cuh|inl|ipp|tpp|ixx|cppm|inc)$/i;

// The C and C++ files that VS Code opens as plain text
export const INCLUDE_FILE = /\.inc$/i;

export function isCppFile(file: string): boolean {
	return CPP_FILE.test(file);
}

// The key of a path for a comparison. The paths of Windows do not use the case of the letters
const pathKey = (file: string): string => (process.platform === 'win32' ? file.toLowerCase() : file);

// The changes of a unified diff, in the lines of the new file. Lines start at 1.
// A run of deleted lines with no added lines after it is a deleted block. It maps to the line after it in the
// new file, and it keeps its old text. Deleted lines with added lines after them are a change of the added lines.
export interface DiffChanges {
	lines: number[];
	deleted: { line: number; text: string }[];
}

export function parseDiff(patch: string): DiffChanges {
	const lines = new Set<number>();
	const deleted: { line: number; text: string }[] = [];
	let removed: string[] = [];
	let next = 0; // the next line of the new file
	let isInHunk = false;
	const endRemoved = (isReplaced: boolean): void => {
		if (removed.length > 0 && !isReplaced) {
			deleted.push({ line: next, text: removed.join('\n') });
		}
		removed = [];
	};

	for (const text of patch.split(/\r?\n/)) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
		if (hunk) {
			endRemoved(false);
			// a hunk with no lines in the new file starts after the line in its header
			next = Number(hunk[1]) + (hunk[2] === '0' ? 1 : 0);
			isInHunk = true;
		} else if (!isInHunk || text.startsWith('\\')) {
			continue;
		} else if (text.startsWith('+')) {
			endRemoved(true);
			lines.add(next++);
		} else if (text.startsWith('-')) {
			removed.push(text.slice(1));
		} else if (text.startsWith(' ') || text === '') {
			endRemoved(false);
			next++;
		} else {
			// the header of the next file
			endRemoved(false);
			isInHunk = false;
		}
	}
	endRemoved(false);
	return { lines: [...lines].sort((a, b) => a - b), deleted };
}

// A line of a hunk of a unified diff. Lines start at 1. A removed line has its line in the old file, and the line of
// the new file at its position. An added line has no line in the old file.
export interface DiffLine {
	kind: 'context' | 'removed' | 'added';
	text: string;
	oldLine?: number;
	newLine: number;
}

// The hunks of a unified diff with their context lines, for the diff of the review story
export function diffHunks(patch: string): DiffLine[][] {
	const out: DiffLine[][] = [];
	let hunk: DiffLine[] | undefined;
	let oldLine = 0;
	let newLine = 0;
	let oldLeft = 0; // the lines of the hunk that did not come yet
	let newLeft = 0;
	for (const text of patch.split(/\r?\n/)) {
		const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
		if (head) {
			oldLeft = Number(head[2] ?? 1);
			newLeft = Number(head[4] ?? 1);
			// a range with no lines starts after the line in the header
			oldLine = Number(head[1]) + (oldLeft === 0 ? 1 : 0);
			newLine = Number(head[3]) + (newLeft === 0 ? 1 : 0);
			hunk = [];
			out.push(hunk);
		} else if (!hunk || text.startsWith('\\') || (oldLeft === 0 && newLeft === 0)) {
			continue;
		} else if (text.startsWith('+')) {
			hunk.push({ kind: 'added', text: text.slice(1), newLine: newLine++ });
			newLeft--;
		} else if (text.startsWith('-')) {
			hunk.push({ kind: 'removed', text: text.slice(1), oldLine: oldLine++, newLine });
			oldLeft--;
		} else {
			hunk.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
			oldLeft--;
			newLeft--;
		}
	}
	return out.filter((h) => h.length > 0);
}

export interface ReviewFile {
	uri: vscode.Uri;
	changes: DiffChanges;
	hunks: DiffLine[][];
}

export interface ReviewDiff {
	base: string; // the commit of the base: the merge base of HEAD and the target branch
	target: string; // the target branch, for example origin/dev
	label: string; // for example "main (merge base 1a2b3c4)"
	files: ReviewFile[];
	baseUri(uri: vscode.Uri): vscode.Uri; // the file at the base, for the diff editor
}

// The git repository of a folder, for a review
export async function openReviewRepository(folder: vscode.Uri): Promise<ReviewRepository> {
	const api = await gitApi();
	// openRepository asks git for the root of the folder, so it also finds a repository in a folder of a different
	// repository. getRepository alone can give the outer repository.
	const repo = await api.openRepository(folder) ?? api.getRepository(folder);
	if (!repo) {
		throw new Error(`${folder.fsPath} is not in a git repository.`);
	}
	return new ReviewRepository(api, repo);
}

// A review compares the active branch with its target branch: the branch that the active branch merges into. Git does
// not record the branch that a branch comes from, so the target branch comes from the user or from a guess.
export class ReviewRepository {
	constructor(private readonly api: GitApi, private readonly repo: GitRepository) {}

	get root(): string {
		return this.repo.rootUri.fsPath;
	}

	// The active branch. A detached HEAD has no branch. The git extension reads the state of a repository after it
	// opens the repository, so DataFlow asks git.
	async activeBranch(): Promise<string | undefined> {
		return (await this.git(['symbolic-ref', '--short', '-q', 'HEAD'])) || undefined;
	}

	mergeBase(target: string): Promise<string | undefined> {
		return this.repo.getMergeBase('HEAD', target).catch(() => undefined);
	}

	// The branch that the active branch comes from, if VS Code made the branch: VS Code writes it to the git configuration
	// branch.<name>.vscode-merge-base. Undefined for a branch with no such entry and for a detached HEAD
	async branchBase(): Promise<string | undefined> {
		const branch = await this.activeBranch();
		return branch ? (await this.git(['config', '--get', `branch.${branch}.vscode-merge-base`])) || undefined : undefined;
	}

	// The local and the remote branches. The branch with the newest commit comes first. <remote>/HEAD is not a branch.
	async branches(): Promise<{ local: string[]; remote: string[] }> {
		const refs = await this.repo.getRefs({ pattern: ['refs/heads', 'refs/remotes'], sort: 'committerdate' });
		const names = (type: number) => refs.filter((r) => r.type === type && r.name && !r.name.endsWith('/HEAD')).map((r) => r.name!);
		return { local: names(LOCAL_BRANCH), remote: names(REMOTE_BRANCH) };
	}

	// The default branch of the remote origin, or of a different remote. A clone sets refs/remotes/<remote>/HEAD to it.
	// The API of the git extension does not give this branch, so DataFlow asks git.
	async defaultBranch(): Promise<string | undefined> {
		const heads = (await this.git(['for-each-ref', '--format=%(symref:short)', 'refs/remotes/*/HEAD'])).split(/\r?\n/).filter(Boolean);
		return heads.find((h) => h.startsWith('origin/')) ?? heads[0];
	}

	// The output of a git command that only reads, or '' if git fails
	private async git(args: string[]): Promise<string> {
		return (await this.gitOutput(args))?.trim() ?? '';
	}

	// The full output of a git command that only reads, or undefined if git fails. A command can also end with a
	// different exit code if it succeeds, for example git diff --no-index with 1 for different files
	private async gitOutput(args: string[], codes: number[] = [0]): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync(this.api.git.path, args, { cwd: this.root, windowsHide: true, maxBuffer: GIT_MAX_OUTPUT });
			return stdout;
		} catch (error) {
			const e = error as { code?: unknown; stdout?: unknown };
			return typeof e.code === 'number' && codes.includes(e.code) && typeof e.stdout === 'string' ? e.stdout : undefined;
		}
	}

	// The unified diff of the text of an editor against the file at a commit. Undefined if the file is not in the commit
	// and _isNew is false. The line ends of both texts become \n, as git does for the files on the disk.
	private async diffText(commit: string, file: string, text: string, isNew: boolean): Promise<string | undefined> {
		const relative = path.relative(this.root, file).split(path.sep).join('/');
		const base = await this.gitOutput(['show', `${commit}:${relative}`]);
		if (base === undefined && !isNew) {
			return undefined;
		}
		const dir = await mkdtemp(path.join(os.tmpdir(), 'dataflow-review-'));
		try {
			const before = path.join(dir, 'base');
			const after = path.join(dir, 'editor');
			await writeFile(before, (base ?? '').replace(/\r\n/g, '\n'));
			await writeFile(after, text.replace(/\r\n/g, '\n'));
			return await this.gitOutput(['diff', '--no-index', '--no-color', '--no-ext-diff', '--', before, after], [0, 1]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	// The C and C++ files that changed against the merge base of HEAD and the target branch, with their changes. The
	// changes include the changes that are not committed. With the target HEAD, only these changes are in the diff.
	// The engine slices the text of the editors, so a file with changes that are not saved gets the diff of the text
	// of its editor. A file of the base also gets a diff if only its editor has changes.
	async diff(target: string): Promise<ReviewDiff> {
		const mergeBase = await this.mergeBase(target);
		if (!mergeBase) {
			throw new Error(`The target branch ${target} does not exist, or it has no commit in common with HEAD. `
				+ 'Click Target in the Change Ripple bar, and select a different branch.');
		}
		const unsaved = new Map<string, vscode.TextDocument>();
		for (const doc of vscode.workspace.textDocuments) {
			const relative = path.relative(this.root, doc.uri.fsPath);
			if (doc.isDirty && doc.uri.scheme === 'file' && isCppFile(doc.uri.fsPath) && relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
				unsaved.set(pathKey(doc.uri.fsPath), doc);
			}
		}

		const files: ReviewFile[] = [];
		const add = (uri: vscode.Uri, patch: string | undefined): void => {
			const changes = parseDiff(patch ?? '');
			if (changes.lines.length > 0 || changes.deleted.length > 0) {
				files.push({ uri, changes, hunks: diffHunks(patch ?? '') });
			}
		};
		for (const change of await this.repo.diffWith(mergeBase)) {
			if (DELETED.has(change.status) || !isCppFile(change.uri.fsPath)) {
				continue;
			}
			const doc = unsaved.get(pathKey(change.uri.fsPath));
			unsaved.delete(pathKey(change.uri.fsPath));
			add(change.uri, doc ? await this.diffText(mergeBase, doc.uri.fsPath, doc.getText(), true) : await this.repo.diffWith(mergeBase, change.uri.fsPath));
		}
		for (const doc of unsaved.values()) {
			add(doc.uri, await this.diffText(mergeBase, doc.uri.fsPath, doc.getText(), false));
		}
		return {
			base: mergeBase, target, label: `${target} (merge base ${mergeBase.slice(0, 7)})`, files,
			baseUri: (uri) => this.api.toGitUri(uri, mergeBase),
		};
	}
}

async function gitApi(): Promise<GitApi> {
	const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!ext) {
		throw new Error('The git extension of VS Code is not available.');
	}
	const api = (await ext.activate()).getAPI(1);
	if (api.state !== 'initialized') {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => { listener.dispose(); resolve(); }, GIT_START_MS);
			const listener = api.onDidChangeState((state) => {
				if (state === 'initialized') {
					clearTimeout(timer);
					listener.dispose();
					resolve();
				}
			});
		});
	}
	return api;
}
