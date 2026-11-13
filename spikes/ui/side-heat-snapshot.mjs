// The lens Heat in the side view of the VS Code test build, on the review fixture: a git repository, so the history of
// git counts. The script turns on Heat with its command, waits for the heat of the functions, and reads the flames and
// the strips in the code and the tab Heat: the functions of the file and the reasons of the function at the cursor.
// Then it clicks a function of the list and turns Heat off. It takes screenshots.
// Usage: node spikes/ui/side-heat-snapshot.mjs <output folder>
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.argv[2]);
const workspace = path.join(repo, 'build', 'fixtures', 'battery-review');
const file = path.join(workspace, 'src', 'battery.cpp');
const version = (d) => d.replace(/^\D+/, '').split('.').map(Number);
const build = readdirSync(path.join(repo, '.vscode-test')).filter((d) => d.startsWith('vscode-win32-x64-archive'))
	.sort((a, b) => { const [x, y] = [version(a), version(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).at(-1);
const port = 9349;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = readFileSync(file, 'utf8').split(/\r?\n/);
const lineOf = (s) => text.findIndex((l) => l.includes(s)) + 1;

const userData = path.join(out, 'user-data-heat');
mkdirSync(path.join(userData, 'User'), { recursive: true });
writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
	'workbench.colorTheme': 'Dark Modern',
	'workbench.startupEditor': 'none',
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'workbench.activityBar.location': 'hidden',
	'window.titleBarStyle': 'native',
	'window.menuBarVisibility': 'hidden',
	'breadcrumbs.enabled': false,
	'chat.disableAIFeatures': true,
	'extensions.ignoreRecommendations': true,
	'git.openRepositoryInParentFolders': 'never',
	'editor.minimap.enabled': false,
	'editor.hover.enabled': false,
	'files.hotExit': 'off',
	'window.zoomLevel': 0,
}));

// the cursor in process()
const fire = lineOf('fire_transition(home_battery_ctl, "", true);');
const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`, `--extensions-dir=${path.join(out, 'extensions')}`,
	`--remote-debugging-port=${port}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${fire}:1`,
], { stdio: 'ignore', env: { ...process.env, DATAFLOW_MCP_REGISTRY: path.join(out, 'mcp-registry'), CLAUDE_CONFIG_DIR: path.join(out, 'claude-config') } });

async function connect(url) {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let id = 0;
	const pending = new Map();
	ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
	const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
	const evaluate = async (expression) => {
		const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
		if (reply.result?.exceptionDetails) {
			throw new Error(`script error: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
		}
		return reply.result?.result?.value;
	};
	return { ws, send, evaluate };
}

const result = {};
try {
	let page;
	for (let i = 0; i < 120 && !page; i++) {
		try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('workbench')); } catch { /* not ready */ }
		if (!page) { await sleep(500); }
	}
	const wb = await connect(page.webSocketDebuggerUrl);
	await wb.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
	const key = async (k, code, vk, modifiers = 0) => {
		await wb.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
		await wb.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
	};
	const mouse = (type, x, y, extra = {}) => wb.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
	const focusEditor = async () => {
		const tab = await wb.evaluate(`(() => { const t = [...document.querySelectorAll('.part.editor .tab')].find((x) => /\\.cpp$/.test(x.querySelector('.label-name')?.textContent ?? ''));
			const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		for (const type of ['mousePressed', 'mouseReleased']) { await mouse(type, tab.x, tab.y, { button: 'left', clickCount: 1 }); }
		await sleep(300);
	};
	const isQuickInputOpen = () => wb.evaluate(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none' && w.contains(document.activeElement); })()`);
	const command = async (title) => {
		await focusEditor();
		await key('P', 'KeyP', 80, 10);
		for (let i = 0; i < 25; i++) {
			if (await isQuickInputOpen()) {
				await wb.send('Input.insertText', { text: title });
				await sleep(600);
				await key('Enter', 'Enter', 13);
				await sleep(400);
				return;
			}
			await sleep(200);
		}
		throw new Error(`the command palette did not open for ${title}`);
	};
	const until = async (check, what, tries = 120) => {
		for (let i = 0; i < tries; i++) { if (await check()) { return; } await sleep(250); }
		throw new Error(`no ${what}`);
	};
	let side;
	const SIDE_DOC = `(document.querySelector('iframe#active-frame')?.contentDocument ?? document)`;
	const inSide = (code) => side.evaluate(`(() => { const doc = ${SIDE_DOC}; ${code} })()`);
	const findSide = async () => {
		const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
		for (const t of targets.filter((x) => x.webSocketDebuggerUrl && x.url.includes('vscode-webview'))) {
			const c = await connect(t.webSocketDebuggerUrl);
			if (await c.evaluate(`!!${SIDE_DOC}.querySelector('.app .status')`)) { return c; }
			c.ws.close();
		}
		return undefined;
	};
	const sideBox = () => wb.evaluate(`(() => {
		const r = [...document.querySelectorAll('.part.editor .editor-group-container')].map((g) => g.getBoundingClientRect()).filter((b) => b.width > 200).sort((a, b) => b.left - a.left)[0];
		return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scale: 1 };
	})()`);
	const shot = async (label, clip) => {
		await wb.evaluate(`document.querySelectorAll('.notifications-toasts .notification-toast-container').forEach((t) => t.remove())`);
		const res = await wb.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
		writeFileSync(path.join(out, `heat-${label}.png`), Buffer.from(res.result.data, 'base64'));
	};
	// the heat in the side view: the flames and the strips of the rendered rows, and the tab Heat
	const heatState = () => inSide(`return {
		flames: [...doc.querySelectorAll('.rows > .row')].filter((r) => r.querySelector('.heat-hint')).map((r) => {
			const hint = r.querySelector('.heat-hint');
			return { line: Number(r.dataset.line), count: hint.querySelectorAll('.flame').length, band: [...hint.classList].find((c) => c.startsWith('b-')), title: hint.title };
		}),
		bars: doc.querySelectorAll('.rows > .row .heat-bar').length,
		busy: !!doc.querySelector('.heat-busy'),
		items: [...doc.querySelectorAll('.heat-list .heat-item')].map((b) => ({ line: Number(b.dataset.line), name: b.querySelector('.mono')?.textContent ?? '',
			flames: b.querySelectorAll('.flame').length, score: Number(b.querySelector('.heat-score')?.textContent) })),
		current: doc.querySelector('.heat-current') && {
			name: doc.querySelector('.heat-current .mono')?.textContent ?? null,
			score: doc.querySelector('.heat-score-line')?.textContent ?? null,
			groups: [...doc.querySelectorAll('.heat-current .heat-group-title')].map((t) => t.firstChild?.textContent?.trim() ?? ''),
			reasons: [...doc.querySelectorAll('.heat-current .heat-reasons li')].map((l) => l.textContent),
		},
		notices: [...doc.querySelectorAll('.heat-details > p.sub')].map((p) => p.textContent),
		scan: doc.querySelector('.heat-scan')?.textContent ?? null,
		graph: doc.querySelector('.heat-graph summary')?.textContent ?? null,
		graphText: doc.querySelector('.heat-graph')?.textContent ?? null,
	};`);

	await until(() => wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")'), 'editor');
	await sleep(1000);
	if (await wb.evaluate(`(() => { const p = document.querySelector('.part.sidebar'); return !!p && p.offsetWidth > 0; })()`)) {
		await command('View: Close Primary Side Bar');
	}
	await sleep(3000);
	await command('DataFlow: Open Side View');
	for (let i = 0; i < 60 && !side; i++) { side = await findSide(); if (!side) { await sleep(250); } }
	if (!side) { throw new Error('the side view was not found'); }
	await until(() => inSide(`return /Engine: ready/.test(doc.querySelector('.status')?.textContent ?? '');`), 'ready engine', 200);

	// Heat on: the side view shows the tab Heat and the busy mark until the heat is ready. The scan of the call graph
	// starts, and at its end the function at the cursor gets its callers
	await command('DataFlow: Toggle Heat');
	let sawScan = false;
	await until(async () => {
		const s = await heatState();
		if (s.scan && !sawScan) {
			sawScan = true;
			await shot('scan', await sideBox());
		}
		return !s.busy && !!s.graph && (s.current?.reasons ?? []).some((t) => /calls it/.test(t));
	}, 'heat with the callers', 240);
	await sleep(800);
	result.heat = await heatState();
	result.sawScan = sawScan;
	await shot('on', await sideBox());

	// a click on a function of the list shows the function in the code
	const target = result.heat.items.find((i) => !result.heat.flames.some((f) => f.line === i.line));
	if (target) {
		await inSide(`doc.querySelector('.heat-item[data-line="${target.line}"]')?.click(); return true;`);
		await until(() => inSide(`return !!doc.querySelector('.rows > .row[data-line="${target.line}"] .heat-hint');`), 'revealed function', 80);
		result.revealed = target.line;
	}

	// Heat off: no flames, no strips
	await command('DataFlow: Toggle Heat');
	await until(() => inSide(`return !doc.querySelector('.heat-hint') && !doc.querySelector('.heat-bar');`), 'heat off');
	result.off = true;
	side.ws.close();
	wb.ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
}
console.log(JSON.stringify(result, null, 2));
