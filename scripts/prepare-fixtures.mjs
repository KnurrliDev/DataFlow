// Prepares the build data of the test fixtures. The extension must find this data by itself.
// > CMake fixture: build/compile_commands.json with a clang command that works on all platforms
// > qmake fixture: build-qmake/ with the Makefiles of a real qmake run. DATAFLOW_QMAKE selects qmake.
//   Without qmake, the qmake tests are skipped.
// > engine tests: build/fixtures/battery-qmake/compile_commands.json, made from the Makefile of the qmake fixture
// > review fixture: build/fixtures/battery-review/, a git repository with a copy of the CMake fixture on the
//   branch main, and the change of acceptance scenario 4 on the branch review
// > remote fixture: build/fixtures/remote-default/, a git repository as a clone of a remote with the default branch
//   dev, and a change on the branch feature. It has no branch main and no branch master
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { findVcvars, helperProcesses, stopNewHelpers, vcvarsEnv } from './msvc.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const cmakeRoot = path.join(repo, 'test', 'fixtures', 'battery');
const qmakeRoot = path.join(repo, 'test', 'fixtures', 'battery-qmake');

// cmake fixture: the sources of the library. WorkerPool has its member functions in two source files
const buildDir = path.join(cmakeRoot, 'build');
mkdirSync(buildDir, { recursive: true });
writeFileSync(path.join(buildDir, 'compile_commands.json'), JSON.stringify(['battery.cpp', 'worker_pool.cpp', 'worker_pool_state.cpp'].map((name) => {
	const source = path.join(cmakeRoot, 'src', name);
	return { directory: buildDir, file: source, arguments: ['clang++', '-std=c++20', `-I${path.join(cmakeRoot, 'include')}`, '-c', source] };
}), null, 2));
console.log('cmake fixture: build/compile_commands.json');

// qmake fixture. A qmake kit for MSVC runs cl, so it needs the environment of vcvars64.bat. cl starts helper processes
// that stay alive after qmake, so the script stops them
const qmake = process.env.DATAFLOW_QMAKE ?? 'C:\\Qt\\6.11.2\\msvc2022_64\\bin\\qmake.exe';
const qmakeBuild = path.join(qmakeRoot, 'build-qmake');
const pro = path.join(qmakeRoot, 'battery.pro');
if (!existsSync(qmake)) {
	console.log(`qmake fixture: skipped, no qmake at ${qmake}`);
} else if (process.platform === 'win32' && /msvc/i.test(qmake)) {
	const vcvars = findVcvars();
	if (vcvars) {
		mkdirSync(qmakeBuild, { recursive: true });
		const helpers = helperProcesses();
		try {
			execSync(`call "${vcvars}" >nul && "${qmake}" "${pro}"`, { cwd: qmakeBuild, stdio: 'inherit', shell: 'cmd.exe', env: vcvarsEnv() });
		} finally {
			stopNewHelpers(helpers);
		}
		console.log(`qmake fixture: build-qmake/ with ${qmake}`);
	} else {
		console.log('qmake fixture: skipped, no Visual Studio 2022 for the MSVC kit');
	}
} else {
	mkdirSync(qmakeBuild, { recursive: true });
	execFileSync(qmake, [pro], { cwd: qmakeBuild, stdio: 'inherit' });
	console.log(`qmake fixture: build-qmake/ with ${qmake}`);
}

// The engine tests also need the database of the qmake fixture. The Makefile reader of the extension makes it.
// The database must not be in the fixture. If it is there, the extension uses it and does not read the Makefile.
rmSync(path.join(qmakeBuild, 'compile_commands.json'), { force: true });
const makefile = ['Makefile.Release', 'Makefile'].map((m) => path.join(qmakeBuild, m)).find((m) => existsSync(m));
if (makefile) {
	const { qmakeEntries } = createRequire(import.meta.url)(path.join(repo, 'out', 'cdb', 'qmake.js'));
	const entries = qmakeEntries(readFileSync(makefile, 'utf8'), qmakeBuild);
	const dbDir = path.join(repo, 'build', 'fixtures', 'battery-qmake');
	mkdirSync(dbDir, { recursive: true });
	writeFileSync(path.join(dbDir, 'compile_commands.json'), JSON.stringify(entries, null, 2));
	console.log(`engine tests: build/fixtures/battery-qmake/compile_commands.json with ${entries.length} entries`);
}

// review fixture. The compile database is in build/, and build/ is not a part of the repository.
const reviewRoot = path.join(repo, 'build', 'fixtures', 'battery-review');
rmSync(reviewRoot, { recursive: true, force: true });
for (const item of ['CMakeLists.txt', 'include', 'src', '.vscode']) {
	cpSync(path.join(cmakeRoot, item), path.join(reviewRoot, item), { recursive: true });
}
writeFileSync(path.join(reviewRoot, '.gitignore'), 'build/\n');
const reviewSettings = path.join(reviewRoot, '.vscode', 'settings.json');
writeFileSync(reviewSettings, JSON.stringify({ ...JSON.parse(readFileSync(reviewSettings, 'utf8')), 'dataflow.ripple.baseRef': 'main' }, null, 2));

const git = (...args) => execFileSync('git', ['-c', 'user.name=DataFlow', '-c', 'user.email=dataflow@example.invalid', ...args],
	{ cwd: reviewRoot, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');
git('add', '-A');
git('commit', '-q', '-m', 'Add the fixture');
git('checkout', '-q', '-b', 'review');
const reviewSource = path.join(reviewRoot, 'src', 'battery.cpp');
writeFileSync(reviewSource, readFileSync(reviewSource, 'utf8').replace('if (cost < 1e-5)', 'if (cost < 1e-4)'));
git('commit', '-q', '-am', 'Change the threshold of the optimization');

const reviewBuild = path.join(reviewRoot, 'build');
mkdirSync(reviewBuild, { recursive: true });
writeFileSync(path.join(reviewBuild, 'compile_commands.json'), JSON.stringify(['battery.cpp', 'main.cpp'].map((name) => {
	const file = path.join(reviewRoot, 'src', name);
	return { directory: reviewBuild, file, arguments: ['clang++', '-std=c++20', `-I${path.join(reviewRoot, 'include')}`, '-c', file] };
}), null, 2));
console.log('review fixture: build/fixtures/battery-review/ with the branches main and review');

// late database fixture: build/fixtures/late-db/, a copy of the sources of the CMake fixture with no compile database.
// The test writes the database after the start
const lateRoot = path.join(repo, 'build', 'fixtures', 'late-db');
rmSync(lateRoot, { recursive: true, force: true });
// the test also makes a build folder of Qt Creator next to the fixture
for (const name of readdirSync(path.dirname(lateRoot))) {
	if (name.startsWith('build-late-db')) {
		rmSync(path.join(path.dirname(lateRoot), name), { recursive: true, force: true });
	}
}
for (const item of ['CMakeLists.txt', 'include', 'src']) {
	cpSync(path.join(cmakeRoot, item), path.join(lateRoot, item), { recursive: true });
}
console.log('late database fixture: build/fixtures/late-db/ with no compile database');

// remote fixture. The remote has no URL that works, so nothing fetches from it. A clone sets refs/remotes/origin/HEAD
const remoteRoot = path.join(repo, 'build', 'fixtures', 'remote-default');
rmSync(remoteRoot, { recursive: true, force: true });
const calc = path.join(remoteRoot, 'src', 'calc.cpp');
mkdirSync(path.dirname(calc), { recursive: true });
writeFileSync(path.join(remoteRoot, 'CMakeLists.txt'), 'project(Calc CXX)\n');
writeFileSync(path.join(remoteRoot, '.gitignore'), 'build/\n');
writeFileSync(calc, 'int add(int a, int b) {\n\treturn a + b;\n}\n');
const remoteGit = (...args) => execFileSync('git', ['-c', 'user.name=DataFlow', '-c', 'user.email=dataflow@example.invalid', ...args],
	{ cwd: remoteRoot, stdio: 'pipe' });
remoteGit('init', '-q', '-b', 'dev');
remoteGit('config', 'core.autocrlf', 'false');
remoteGit('add', '-A');
remoteGit('commit', '-q', '-m', 'Add the project');
remoteGit('remote', 'add', 'origin', 'https://example.invalid/calc.git');
remoteGit('update-ref', 'refs/remotes/origin/dev', 'HEAD');
remoteGit('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev');
remoteGit('checkout', '-q', '-b', 'feature');
writeFileSync(calc, 'int add(int a, int b) {\n\treturn a + b + 1;\n}\n');
remoteGit('commit', '-q', '-am', 'Change add');
const remoteBuild = path.join(remoteRoot, 'build');
mkdirSync(remoteBuild, { recursive: true });
writeFileSync(path.join(remoteBuild, 'compile_commands.json'), JSON.stringify([
	{ directory: remoteBuild, file: calc, arguments: ['clang++', '-std=c++20', '-c', calc] },
], null, 2));
console.log('remote fixture: build/fixtures/remote-default/ with the default branch dev of origin and the branch feature');
