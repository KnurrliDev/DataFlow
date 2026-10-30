// Makes the VSIX package of the extension for Windows x64: node scripts/package-vsix.mjs
// > The package contains the engine. The script copies build/engine/dataflow-engine.exe and the builtin headers of
//   Clang into engine/bin, where the extension looks for its engine. Run "npm run build:engine" first.
// > vsce compiles the extension (vscode:prepublish) and writes dataflow-win32-x64-<version>.vsix into the root folder.
//   The package has no node_modules, because the extension has no runtime dependencies.
// > After the package, the script removes engine/bin. Without this step, the development host would use this copy of
//   the engine, and not a new build in build/engine.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(repo, 'build', 'engine');
const binDir = path.join(repo, 'engine', 'bin');
const exe = path.join(buildDir, 'dataflow-engine.exe');
const headers = path.join(buildDir, 'lib', 'clang');
const target = 'win32-x64';

if (process.platform !== 'win32') {
	console.error('The package contains the engine for Windows. Make the package on Windows.');
	process.exit(2);
}
for (const item of [exe, headers]) {
	if (!existsSync(item)) {
		console.error(`${path.relative(repo, item)} does not exist. Run "npm run build:engine" first.`);
		process.exit(2);
	}
}

// the engine and the builtin headers of Clang, at the place of an installed extension
rmSync(binDir, { recursive: true, force: true });
cpSync(exe, path.join(binDir, 'dataflow-engine.exe'));
cpSync(headers, path.join(binDir, 'lib', 'clang'), { recursive: true });

let status = 1;
try {
	const vsce = path.join(repo, 'node_modules', '@vscode', 'vsce', 'vsce');
	status = spawnSync(process.execPath, [vsce, 'package', '--target', target, '--no-dependencies'], { cwd: repo, stdio: 'inherit' }).status ?? 1;
} finally {
	rmSync(binDir, { recursive: true, force: true });
}

const { version } = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
if (status === 0) {
	console.log(`The package is dataflow-${target}-${version}.vsix.`);
}
process.exit(status);
