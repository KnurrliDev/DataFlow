// Makes the VSIX package of the extension for Windows x64: node scripts/package-vsix.mjs [folder of the package]
// > The package contains the engine. The script copies build/engine/dataflow-engine.exe and the builtin headers of
//   Clang into engine/bin, where the extension looks for its engine. Run "npm run build:engine" first.
// > vsce compiles the extension (vscode:prepublish) and writes dataflow-win32-x64-<version>.vsix. The default folder of
//   the package is the root folder.
//   The package has no node_modules, because the extension has no runtime dependencies.
// > After the package, the script removes engine/bin. Without this step, the development host would use this copy of
//   the engine, and not a new build in build/engine.
// > With the private key of scripts/make-signing-key.mjs, the script writes the signature <package>.sig. The updater of
//   DataFlow installs only a package with a correct signature.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { signingKeyFile, signVsix } from './sign-vsix.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(repo, 'build', 'engine');
const binDir = path.join(repo, 'engine', 'bin');
const exe = path.join(buildDir, 'dataflow-engine.exe');
const headers = path.join(buildDir, 'lib', 'clang');
const target = 'win32-x64';
const { version } = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const vsix = path.join(path.resolve(process.argv[2] ?? repo), `dataflow-${target}-${version}.vsix`);

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
	status = spawnSync(process.execPath, [vsce, 'package', '--target', target, '--no-dependencies', '--out', vsix], { cwd: repo, stdio: 'inherit' }).status ?? 1;
} finally {
	rmSync(binDir, { recursive: true, force: true });
}

if (status === 0) {
	console.log(`The package is ${path.basename(vsix)}.`);
	const keyFile = signingKeyFile();
	if (existsSync(keyFile)) {
		console.log(`The signature is ${path.basename(signVsix(vsix, version, readFileSync(keyFile, 'utf8')))}.`);
	} else {
		rmSync(`${vsix}.sig`, { force: true });
		console.warn(`${keyFile} does not exist, so the package has no signature. The updater of DataFlow does not install this package.`);
	}
}
process.exit(status);
