// Spike P0 (b): make compile_commands.json from a Makefile that qmake wrote for MSVC.
// Usage: node spikes/qmake/make-cdb.mjs <build folder> [Makefile.Release]
// The script reads CXX, CXXFLAGS, DEFINES, INCPATH and SOURCES, and expands $(VAR) references.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const buildDir = path.resolve(process.argv[2]);
const makefile = path.join(buildDir, process.argv[3] ?? 'Makefile.Release');

// join lines that end with a backslash, then read "NAME = value" lines
const text = readFileSync(makefile, 'utf8').replace(/\\\r?\n/g, ' ');
const vars = {};
for (const line of text.split(/\r?\n/)) {
	const m = /^([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
	if (m) {
		vars[m[1]] = m[2].trim();
	}
}
const expand = (value, depth = 0) =>
	depth > 10 ? value : value.replace(/\$\((\w+)\)/g, (_, name) => expand(vars[name] ?? '', depth + 1));

// split a command line into arguments, and keep quoted parts together
const split = (value) => [...value.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

const compiler = vars.CXX ?? 'cl';
const flags = split(expand(vars.CXXFLAGS ?? ''));
const includes = split(expand(vars.INCPATH ?? '')).map((arg) => arg.replace(/^-I"?(.*?)"?$/, '-I$1'));
const sources = split(expand(vars.SOURCES ?? ''));

const entries = sources.map((src) => {
	const file = path.resolve(buildDir, src);
	return { directory: buildDir, file, arguments: [compiler, ...flags, ...includes, '-c', file] };
});
writeFileSync(path.join(buildDir, 'compile_commands.json'), JSON.stringify(entries, null, 2));
console.log(JSON.stringify({ makefile, compiler, flags: flags.length, includes: includes.length, files: entries.map((e) => e.file) }, null, 2));
