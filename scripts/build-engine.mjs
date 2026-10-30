// Builds the engine in build/engine with CMake and Ninja: node scripts/build-engine.mjs [--jobs <n>]
// > If build/engine has no CMake cache, the script configures the build first. The environment variable
//   DATAFLOW_DEPS_DIR gives the folder with the LLVM, zlib and zstd builds. The default is ~/.cache/dataflow.
// > The build uses a maximum of 80% of the processor cores. The option --jobs sets a different number.
// > On Windows, the script uses the environment of vcvars64.bat if cl is not in the PATH.
// > On Windows, a running engine locks dataflow-engine.exe, and the linker cannot write it. Thus the script renames
//   the file before the build. The running engine continues with the renamed file. A later run of the script removes
//   the renamed files that no process runs. If the build fails, the file gets its name back.
// > On Windows, the script stops the helper processes of MSVC that started during the build.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findVcvars, helperProcesses, stopNewHelpers, vcvarsEnv } from './msvc.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(repo, 'build', 'engine');
const isWindows = process.platform === 'win32';

const args = process.argv.slice(2);
const jobsAt = args.indexOf('--jobs');
const jobs = jobsAt >= 0 ? Number(args[jobsAt + 1]) : Math.max(1, Math.floor(os.availableParallelism() * 0.8));
if (!Number.isInteger(jobs) || jobs < 1) {
	console.error('The option --jobs needs a positive number.');
	process.exit(2);
}

// true if a process runs the file. Windows does not let a program open a running program for writing
function isRunning(file) {
	try {
		closeSync(openSync(file, 'r+'));
		return false;
	} catch (e) {
		return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
	}
}

// the renamed engines of earlier builds that no process runs, then the running engine
const exe = path.join(buildDir, 'dataflow-engine.exe');
let renamed;
if (isWindows && existsSync(buildDir)) {
	for (const name of readdirSync(buildDir)) {
		if (!/^dataflow-engine\.in-use-\d+\.exe$/.test(name)) {
			continue;
		}
		try {
			unlinkSync(path.join(buildDir, name));
			console.log(`Removed ${name}.`);
		} catch {
			// a process runs it
		}
	}
	if (existsSync(exe) && isRunning(exe)) {
		renamed = path.join(buildDir, `dataflow-engine.in-use-${Date.now()}.exe`);
		renameSync(exe, renamed);
		console.log(`A process runs the engine. The script renamed the file to ${path.basename(renamed)}.`);
	}
}

const commands = [];
if (!existsSync(path.join(buildDir, 'CMakeCache.txt'))) {
	const deps = (process.env.DATAFLOW_DEPS_DIR ?? path.join(os.homedir(), '.cache', 'dataflow')).replaceAll('\\', '/');
	commands.push(['cmake', '-S', 'engine', '-B', 'build/engine', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DDATAFLOW_DEPS_DIR=${deps}`]);
}
commands.push(['cmake', '--build', 'build/engine', '-j', String(jobs)]);
console.log(`The build uses ${jobs} jobs.`);

const helpers = helperProcesses();
let status = 0;
const vcvars = isWindows && !process.env.VCINSTALLDIR ? findVcvars() : undefined;
if (vcvars) {
	const quote = (s) => (/[\s"&|<>^]/.test(s) ? `"${s}"` : s);
	const line = [`call ${quote(vcvars)} >nul`, ...commands.map((c) => c.map(quote).join(' '))].join(' && ');
	status = spawnSync(line, { cwd: repo, stdio: 'inherit', shell: true, env: vcvarsEnv() }).status ?? 1;
} else {
	for (const [command, ...rest] of commands) {
		status = spawnSync(command, rest, { cwd: repo, stdio: 'inherit' }).status ?? 1;
		if (status !== 0) {
			break;
		}
	}
}
for (const p of stopNewHelpers(helpers)) {
	console.log(`Stopped ${p}.`);
}

if (renamed && !existsSync(exe)) {
	renameSync(renamed, exe);
	console.log('The build failed. The engine file has its name again.');
} else if (renamed && status === 0) {
	console.log('Run "DataFlow: Restart Engine" in VS Code to use the new engine.');
}
process.exit(status);
