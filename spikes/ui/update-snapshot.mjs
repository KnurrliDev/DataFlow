// Tests a real update in the test build of VS Code. The script makes packages of three versions from the VSIX package of
// the repository, and a release server on this computer gives them to an installed package of DataFlow:
// > The installed package gets a new version with a correct signature, and it offers a reload. The old version runs
//   until the reload, and the new version runs after it.
// > Then the server gives the signed package of the second version as a third version. DataFlow refuses it.
// The packages use a key pair of this run. The script replaces the address of the releases, the public key and the delay
// of the first check only in the unpacked copy of the package.
// Usage: node spikes/ui/update-snapshot.mjs <output folder>
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { signVsix } from '../../scripts/sign-vsix.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.argv[2]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9372;
const base = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const [major, minor, patch] = base.split('.').map(Number);
const versions = { old: base, next: `${major}.${minor}.${patch + 1}`, replay: `${major}.${minor}.${patch + 2}` };
const packageName = (version) => `dataflow-win32-x64-${version}.vsix`;
const folderOf = (version) => `knurrlidev.dataflow-${version}`;
const result = { versions };

// the newest test build of VS Code
const build = path.join(repo, '.vscode-test', readdirSync(path.join(repo, '.vscode-test'))
	.filter((d) => d.startsWith('vscode-win32-x64-archive')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1));
const ext = path.join(out, 'ext');
const user = path.join(out, 'user');
const packages = path.join(out, 'packages');
const unpacked = path.join(out, 'unpacked');
mkdirSync(packages, { recursive: true });
mkdirSync(path.join(user, 'User'), { recursive: true });
writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
	'workbench.startupEditor': 'none', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'chat.disableAIFeatures': true,
	'git.enabled': false, 'extensions.ignoreRecommendations': true, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
	'security.workspace.trust.enabled': false,
}));

// The release server: the latest release, and its files. latest is the release that the server gives now
let latest;
const served = [];
const server = http.createServer((req, res) => {
	served.push(req.url);
	if (req.url === '/latest') {
		const etag = `"${latest.json.tag_name}"`;
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304).end();
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag }).end(JSON.stringify(latest.json));
		return;
	}
	const file = latest?.files.get(req.url);
	if (!file) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { 'Content-Length': statSync(file).size });
	createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;

// A release of the server with a package and a signature file
function releaseOf(version, vsix, signature) {
	const name = packageName(version);
	const asset = (assetName, file) => ({
		name: assetName, size: statSync(file).size, state: 'uploaded', browser_download_url: `${address}/files/${assetName}`,
		digest: `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`,
	});
	return {
		json: { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `https://releases.test/v${version}`, assets: [asset(name, vsix), asset(`${name}.sig`, signature)] },
		files: new Map([[`/files/${name}`, vsix], [`/files/${name}.sig`, signature]]),
	};
}

const powershell = (command) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const zipLibrary = 'Add-Type -AssemblyName System.IO.Compression.FileSystem;';

// Replaces a text in a file of the unpacked package. The text must be there
function replaceIn(file, from, to) {
	const full = path.join(unpacked, file);
	const text = readFileSync(full, 'utf8');
	if (!text.includes(from)) {
		throw new Error(`${file} does not contain ${from}`);
	}
	writeFileSync(full, text.split(from).join(to));
}

// The packages: the old version with this key and this server, and the next version with a correct signature. The test
// does not use the private key of the releases
function makePackages() {
	execFileSync(process.execPath, [path.join(repo, 'scripts', 'package-vsix.mjs'), packages],
		{ cwd: repo, stdio: 'pipe', env: { ...process.env, DATAFLOW_SIGNING_KEY: path.join(out, 'no-key.pem') } });
	const source = path.join(packages, packageName(base));
	powershell(`${zipLibrary} [IO.Compression.ZipFile]::ExtractToDirectory('${source}', '${unpacked}')`);
	const keys = generateKeyPairSync('ed25519');
	const realKey = /UPDATE_PUBLIC_KEY = '([^']+)'/.exec(readFileSync(path.join(unpacked, 'extension', 'out', 'update', 'release.js'), 'utf8'))[1];
	replaceIn('extension/out/update/release.js', realKey, keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
	replaceIn('extension/out/update/release.js', 'https://api.github.com/repos/KnurrliDev/DataFlow/releases/latest', `${address}/latest`);
	replaceIn('extension/out/update/start.js', 'START_DELAY_MS = 60000', 'START_DELAY_MS = 1500');

	const made = {};
	let current = base;
	for (const version of [versions.old, versions.next]) {
		if (version !== current) {
			replaceIn('extension/package.json', `"version": "${current}"`, `"version": "${version}"`);
			replaceIn('extension.vsixmanifest', `Version="${current}"`, `Version="${version}"`);
			current = version;
		}
		const file = path.join(packages, `made-${version}`, packageName(version));
		mkdirSync(path.dirname(file), { recursive: true });
		powershell(`${zipLibrary} [IO.Compression.ZipFile]::CreateFromDirectory('${unpacked}', '${file}')`);
		made[version] = file;
	}
	const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
	const signature = signVsix(made[versions.next], versions.next, privatePem);

	// the signed package of the next version, with the name of a higher version and its old signature
	const replay = path.join(packages, 'made-replay', packageName(versions.replay));
	mkdirSync(path.dirname(replay), { recursive: true });
	copyFileSync(made[versions.next], replay);
	copyFileSync(signature, `${replay}.sig`);
	return { old: made[versions.old], next: releaseOf(versions.next, made[versions.next], signature), replay: releaseOf(versions.replay, replay, `${replay}.sig`) };
}

async function connect(url) {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let id = 0;
	const pending = new Map();
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data);
		if (m.id && pending.has(m.id)) {
			pending.get(m.id)(m);
			pending.delete(m.id);
		}
	};
	const send = (method, params = {}) => new Promise((r) => {
		const n = ++id;
		pending.set(n, r);
		ws.send(JSON.stringify({ id: n, method, params }));
	});
	const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
	return { ws, send, evaluate };
}

async function workbench() {
	for (let i = 0; i < 120; i++) {
		try {
			const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('workbench'));
			if (page) {
				return await connect(page.webSocketDebuggerUrl);
			}
		} catch { /* not ready */ }
		await sleep(500);
	}
	throw new Error('the window of VS Code did not start');
}

// the folders of the installed versions of DataFlow
const installed = () => readdirSync(ext).filter((d) => d.startsWith('knurrlidev.dataflow-')).sort();
// the folder of the package of the engine that runs now
const engineFolders = () => powershell("Get-CimInstance Win32_Process -Filter \"Name='dataflow-engine.exe'\" | ForEach-Object { $_.ExecutablePath }")
	.split(/\r?\n/).filter((p) => p.toLowerCase().startsWith(ext.toLowerCase())).map((p) => path.relative(ext, p).split(path.sep)[0]);

async function waitFor(what, read, seconds = 120) {
	for (let i = 0; i < seconds * 2; i++) {
		const value = await read().catch(() => undefined);
		if (value) {
			return value;
		}
		await sleep(500);
	}
	throw new Error(`no ${what}`);
}

let proc;
try {
	const made = makePackages();
	const cli = path.join(build, 'bin', 'code.cmd');
	execFileSync('cmd.exe', ['/c', cli, '--extensions-dir', ext, '--user-data-dir', user, '--install-extension', made.old], { stdio: 'pipe' });
	result.before = installed();

	latest = made.next;
	const fixture = path.join(repo, 'test', 'fixtures', 'battery');
	proc = spawn(path.join(build, 'Code.exe'), [`--extensions-dir=${ext}`, `--user-data-dir=${user}`, `--remote-debugging-port=${port}`,
		'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', fixture, '--goto', `${path.join(fixture, 'src', 'battery.cpp')}:85:1`],
	{ stdio: 'ignore', env: { ...process.env, DATAFLOW_MCP_REGISTRY: path.join(out, 'mcp'), CLAUDE_CONFIG_DIR: path.join(out, 'claude') } });
	let wb = await workbench();

	const toast = (text) => wb.evaluate(`(() => { const t = [...document.querySelectorAll('.notifications-toasts .notification-toast')]
		.find((x) => x.textContent.includes(${JSON.stringify(text)}));
		return t ? { text: t.querySelector('.notification-list-item-message')?.textContent ?? '', buttons: [...t.querySelectorAll('.monaco-button')].map((b) => b.textContent) } : null; })()`);
	const clickButton = (text, button) => wb.evaluate(`(() => { const t = [...document.querySelectorAll('.notifications-toasts .notification-toast')]
		.find((x) => x.textContent.includes(${JSON.stringify(text)}));
		const b = t && [...t.querySelectorAll('.monaco-button')].find((x) => x.textContent === ${JSON.stringify(button)});
		if (b) { b.click(); } return !!b; })()`);

	// the window installs the new version by itself, and the old version still runs
	const installedText = `DataFlow ${versions.next} is installed`;
	result.offer = await waitFor('offer of a reload', () => toast(installedText));
	result.afterInstall = { folders: installed(), engine: await waitFor('engine of the old version', async () => engineFolders()[0]) };
	const shot = await wb.send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(path.join(out, 'update-offer.png'), Buffer.from(shot.result.data, 'base64'));

	// the reload starts the new version
	await clickButton(installedText, 'Reload');
	wb.ws.close();
	result.afterReload = { engine: await waitFor('engine of the new version', async () => engineFolders().find((f) => f === folderOf(versions.next))) };
	wb = await workbench();
	await waitFor('workbench after the reload', () => wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")'));
	await sleep(3000);

	// the command finds the higher version. The package is signed, but not for this version
	latest = made.replay;
	const key = async (k, code, vk, modifiers = 0) => {
		await wb.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
		await wb.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
	};
	const box = await wb.evaluate(`(() => { const r = [...document.querySelectorAll('.part.editor .monaco-editor')].map((e) => e.getBoundingClientRect())
		.find((b) => b.width > 200 && b.height > 200); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	for (const type of ['mousePressed', 'mouseReleased']) {
		await wb.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
	}
	await sleep(300);
	await key('P', 'KeyP', 80, 10); // ctrl+shift+p
	await waitFor('command palette (the command palette did not open)',
		() => wb.evaluate(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none' && w.contains(document.activeElement); })()`), 10);
	await wb.send('Input.insertText', { text: 'DataFlow: Check for Updates' });
	await sleep(700);
	await key('Enter', 'Enter', 13);

	const askText = `DataFlow ${versions.replay} is available`;
	result.ask = await waitFor('question for the update', () => toast(askText), 30);
	await clickButton(askText, 'Update');
	const refusedText = `did not install version ${versions.replay}`;
	result.refused = await waitFor('warning for the signature', () => toast(refusedText), 60);
	result.afterRefusal = { folders: installed(), engine: engineFolders()[0] };
	result.served = [...new Set(served)];
	wb.ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	if (proc) {
		try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
	}
	server.close();
	server.closeAllConnections();
}
console.log(JSON.stringify(result, null, 2));
process.exit(0);
