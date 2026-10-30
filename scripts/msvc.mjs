// The helpers of the scripts for MSVC on Windows.
// > findVcvars: the vcvars64.bat of Visual Studio 2022. A command that runs cl needs its environment.
// > helperProcesses and stopNewHelpers: cl and link start vctip.exe and mspdbsrv.exe. These processes stay alive for
//   some minutes after the command. A script stops the processes that started while it ran, and no other processes.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HELPERS = ['vctip.exe', 'mspdbsrv.exe'];
const INSTALLER = path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft Visual Studio', 'Installer');

// The environment for a command that calls vcvars64.bat. The scripts of vcvars64.bat find vswhere.exe through the PATH
export function vcvarsEnv() {
	const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
	return { ...process.env, [key]: `${INSTALLER};${process.env[key] ?? ''}` };
}

// The vcvars64.bat of Visual Studio 2022, or undefined
export function findVcvars() {
	const vswhere = path.join(INSTALLER, 'vswhere.exe');
	if (process.platform !== 'win32' || !existsSync(vswhere)) {
		return undefined;
	}
	const dir = execFileSync(vswhere, ['-version', '[17.0,18.0)', '-products', '*', '-requires',
		'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
	const bat = dir ? path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat') : '';
	return existsSync(bat) ? bat : undefined;
}

// The helper processes of MSVC that run now: the process id and the name. Empty on other platforms
export function helperProcesses() {
	const out = new Map();
	if (process.platform !== 'win32') {
		return out;
	}
	for (const name of HELPERS) {
		const list = execFileSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8', windowsHide: true });
		for (const line of list.split(/\r?\n/)) {
			const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
			if (cells.length >= 2 && cells[0].toLowerCase() === name) {
				out.set(Number(cells[1]), name);
			}
		}
	}
	return out;
}

// Stops the helper processes of MSVC that are not in the result of an earlier call of helperProcesses. Returns the
// stopped processes, for example "vctip.exe 1234".
export function stopNewHelpers(before) {
	const stopped = [];
	for (const [id, name] of helperProcesses()) {
		if (before.has(id)) {
			continue;
		}
		try {
			process.kill(id);
			stopped.push(`${name} ${id}`);
		} catch {
			// the process stopped by itself
		}
	}
	return stopped;
}
