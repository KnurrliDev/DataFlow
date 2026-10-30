// The search for the other source files of a member, for Flow Lens on a data member, a static data member or a global
// variable: the files of the project that define a member function of the class, for example with "WorkerPool::", and
// the files that include the header of the member and name it. This module does not use the VS Code API, so the unit
// tests can call it directly.

// The source files: no headers. An .inc file of a unity build is a source file
const SOURCE_FILE = /\.(c|cc|cpp|cxx|c\+\+|inc|ipp|tpp|tcc|inl)$/i;

export function isSourceFile(file: string): boolean {
	return SOURCE_FILE.test(file);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseName = (file: string) => file.split(/[/\\]/).pop() ?? file;

// An #include of a file with this name, also with a folder before the name
const includeOf = (file: string) => new RegExp(`#\\s*include\\s*[<"]([^>"]*[/\\\\])?${escape(baseName(file))}[>"]`);

// A file of the search, and the number of mentions of the member in it
export interface ClassFile {
	file: string;
	mentions: number;
}

// Reads the files, limit at the same time, and keeps the files that match. read gives the text of a file, or undefined
// if it cannot read the file. The result is sorted by the path.
async function filterFiles(files: string[], read: (file: string) => Promise<string | undefined>,
	match: (text: string) => ClassFile['mentions'] | undefined, limit: number): Promise<ClassFile[]> {
	const out: ClassFile[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < files.length) {
			const file = files[next++];
			const text = await read(file);
			const mentions = text !== undefined ? match(text) : undefined;
			if (mentions !== undefined) {
				out.push({ file, mentions });
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

// A name with no letter, digit or underscore before and after it
const wordRe = (word: string, flags = '') => new RegExp(`(^|[^A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`, flags);

// The namespaces and the outer classes of a class, from its qualified name, for example ["electricity"] for
// electricity::WorkerPool. An anonymous namespace has no name in the text, and the template arguments do not count
export function classScope(qualifiedClass: string, className: string): string[] {
	if (!className) {
		return [];
	}
	const parts: string[] = [];
	let depth = 0;
	let part = '';
	for (let i = 0; i < qualifiedClass.length; i++) {
		const c = qualifiedClass[i];
		depth += c === '<' ? 1 : c === '>' ? -1 : 0;
		if (depth === 0 && qualifiedClass.startsWith('::', i)) {
			parts.push(part);
			part = '';
			i++;
		} else {
			part += c;
		}
	}
	return parts.map((p) => p.replace(/<.*$/, '').trim()).filter((p) => /^[A-Za-z_]\w*$/.test(p));
}

// The files that contain the name of the class before "::", with no letter, digit or underscore before the name. A
// class template can have its arguments before "::", for example Pool<T>::push. Such a file must also contain each name
// of the scope of the class, for example "electricity" in "namespace electricity {", "electricity::WorkerPool::" or
// "using namespace electricity;". Thus a class with the same name in a different namespace does not come. A public
// member can also have accesses in a file that defines no function of the class, so a file that includes the header of
// the member and names the member also comes. With no class name, for a global variable, only this second search runs.
export async function searchClassFiles(files: string[], read: (file: string) => Promise<string | undefined>, className: string, member: string,
	header?: string, limit = 16, scope: readonly string[] = []): Promise<ClassFile[]> {
	const classRe = className ? new RegExp(`(^|[^A-Za-z0-9_])${escape(className)}\\s*(<[^;{}]*?>)?\\s*::`) : undefined;
	const scopeRes = scope.map((s) => wordRe(s));
	const includeRe = header ? includeOf(header) : undefined;
	const memberRe = wordRe(member, 'g');
	return filterFiles(files, read, (text) => {
		const mentions = text.match(memberRe)?.length ?? 0;
		const isClassFile = !!classRe?.test(text) && scopeRes.every((re) => re.test(text));
		return isClassFile || (includeRe?.test(text) && mentions > 0) ? mentions : undefined;
	}, limit);
}

// The line of the first #include of a file in a text, from 1. 0 if the text has none
export function includeLine(text: string, file: string): number {
	const includeRe = includeOf(file);
	return text.split(/\r?\n/).findIndex((line) => includeRe.test(line)) + 1;
}

// The source file that includes a file, for example the .cpp file of a unity build that includes an .inc file. The
// engine parses that file, because the included file alone has no context. The first file by its path, or undefined
export async function findIncluder(files: string[], read: (file: string) => Promise<string | undefined>, file: string,
	limit = 16): Promise<string | undefined> {
	const includeRe = includeOf(file);
	const key = (f: string) => f.replace(/\\/g, '/').toLowerCase();
	const candidates = files.filter((f) => key(f) !== key(file) && !/\.inc$/i.test(f));
	const found = await filterFiles(candidates, read, (text) => (includeRe.test(text) ? 0 : undefined), limit);
	return found[0]?.file;
}
