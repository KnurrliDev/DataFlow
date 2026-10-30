import * as path from 'path';

// Makes compile_commands.json entries from a Makefile that qmake wrote.
// qmake has no compile database of its own. Its Makefiles keep the flags in variables.

export interface CompileEntry {
	directory: string;
	file: string;
	arguments: string[];
}

// Reads "NAME = value" lines. A line that ends with a backslash continues on the next line.
export function readMakefileVariables(text: string): Map<string, string> {
	const vars = new Map<string, string>();
	const joined = text.replace(/\\\r?\n/g, ' ');
	for (const line of joined.split(/\r?\n/)) {
		const match = /^([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
		if (match) {
			vars.set(match[1], match[2].trim());
		}
	}
	return vars;
}

// Replaces $(NAME) with the value of NAME. The depth limit stops a loop of references.
export function expandVariables(value: string, vars: Map<string, string>, depth = 0): string {
	if (depth > 10) {
		return value;
	}
	return value.replace(/\$\((\w+)\)/g, (_, name: string) => expandVariables(vars.get(name) ?? '', vars, depth + 1));
}

// Splits a command line into arguments. A quoted part can be in the middle of an argument,
// for example -I"C:\Qt Dir\include". The quotes are removed.
export function splitArguments(value: string): string[] {
	return [...value.matchAll(/(?:"[^"]*"|[^\s"])+/g)].map((m) => m[0].replace(/"/g, ''));
}

export function qmakeEntries(makefileText: string, buildDir: string): CompileEntry[] {
	const vars = readMakefileVariables(makefileText);
	const compiler = vars.get('CXX') ?? 'cl';
	const flags = splitArguments(expandVariables(vars.get('CXXFLAGS') ?? '', vars));
	const includes = splitArguments(expandVariables(vars.get('INCPATH') ?? '', vars));
	const sources = splitArguments(expandVariables(vars.get('SOURCES') ?? '', vars));
	return sources.map((source) => {
		const file = path.resolve(buildDir, source);
		return { directory: buildDir, file, arguments: [compiler, ...flags, ...includes, '-c', file] };
	});
}

// The Makefile with the flags. With debug_and_release, qmake writes Makefile.Release and Makefile.Debug.
export const QMAKE_MAKEFILES = ['Makefile.Release', 'Makefile.Debug', 'Makefile'];
