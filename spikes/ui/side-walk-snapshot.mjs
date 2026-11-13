// The diff walk in the side view of the VS Code test build, on the review fixture. The script adds a line to process()
// in the text editor and does not save it. Then it starts the walk against the branch main with the command of DataFlow
// and its list of branches: the committed change in solve_power_plan() and the new line. It reads the marks of the diff
// in the code, the card of the removed line and the diff in the tab Guide, opens the diff editor, and then acts as the
// language model: get_diff, show_diff_walk and review_step. It takes screenshots.
// Usage: node spikes/ui/side-walk-snapshot.mjs <output folder>
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.argv[2]);
const workspace = path.join(repo, 'build', 'fixtures', 'battery-review');
const file = path.join(workspace, 'src', 'battery.cpp');
const version = (d) => d.replace(/^\D+/, '').split('.').map(Number);
const build = readdirSync(path.join(repo, '.vscode-test')).filter((d) => d.startsWith('vscode-win32-x64-archive'))
	.sort((a, b) => { const [x, y] = [version(a), version(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).at(-1);
const port = 9348;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const registry = path.join(out, 'mcp-registry');
const text = readFileSync(file, 'utf8').split(/\r?\n/);
const lineOf = (s) => text.findIndex((l) => l.includes(s)) + 1;

const userData = path.join(out, 'user-data-walk');
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

const changed = lineOf('if (cost < 1e-4)');
const fire = lineOf('fire_transition(home_battery_ctl, "", true);');
const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`, `--extensions-dir=${path.join(out, 'extensions')}`,
	`--remote-debugging-port=${port}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${fire}:1`,
], { stdio: 'ignore', env: { ...process.env, DATAFLOW_MCP_REGISTRY: registry, CLAUDE_CONFIG_DIR: path.join(out, 'claude-config') } });

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
		writeFileSync(path.join(out, `walk-${label}.png`), Buffer.from(res.result.data, 'base64'));
	};
	const linesOf = (selector) => `[...doc.querySelectorAll('.rows > .row${selector}')].map((r) => Number(r.dataset.line))`;
	// the state of the walk in the side view
	const walkState = () => inSide(`return {
		pill: doc.querySelector('.rg-bar .rg-pill')?.textContent ?? null,
		title: doc.querySelector('.rg-bar .rg-title')?.textContent ?? null,
		guideTitle: doc.querySelector('.rg-details .flow-title strong')?.textContent ?? null,
		stats: doc.querySelector('.rg-bar .df-stats')?.textContent ?? null,
		current: [...doc.querySelectorAll('.rg-step')].findIndex((s) => s.classList.contains('current')) + 1,
		steps: [...doc.querySelectorAll('.rg-step .rg-step-title')].map((t) => t.textContent),
		statuses: [...doc.querySelectorAll('.rg-step')].map((s) => [...s.classList].find((c) => c.startsWith('st-'))),
		frame: ${linesOf('.rg-line')},
		added: ${linesOf('.df-add')},
		removedAt: ${linesOf('.df-del')},
		otherAdded: ${linesOf('.df-add-x')},
		chip: doc.querySelector('.df-chip')?.textContent ?? null,
		changedText: [...doc.querySelectorAll('.rows > .row.df-add .df-chg')].map((c) => c.textContent),
		tag: doc.querySelector('.rg-tag')?.textContent ?? null,
		source: doc.querySelector('.rg-details > .sub')?.textContent ?? null,
		modelPill: !!doc.querySelector('.rg-details > .sub .mpill'),
		diffRows: [...doc.querySelectorAll('.rg-step.current .rg-diff .srow')].map((r) => (r.classList.contains('d-added') ? '+' : r.classList.contains('d-removed') ? '-' : ' ')
			+ (r.querySelector('.code')?.textContent ?? '')),
		changedInDiff: [...doc.querySelectorAll('.rg-step.current .rg-diff .chg-text')].map((c) => c.textContent),
		note: doc.querySelector('.rg-step.current .rg-note')?.textContent ?? null,
	};`);
	const clickBar = (label) => inSide(`const b = [...doc.querySelectorAll('.rg-bar button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) || x.title === ${JSON.stringify(label)});
		b?.click(); return !!b;`);

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
	// the text editor gets 560 px, the side view the rest
	const sash = await wb.evaluate(`(() => { const r = [...document.querySelectorAll('.part.editor .monaco-sash.vertical')].map((e) => e.getBoundingClientRect())
		.find((b) => b.height > 200 && b.left > 100); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	if (sash) {
		await mouse('mouseMoved', sash.x, sash.y);
		await mouse('mousePressed', sash.x, sash.y, { button: 'left', clickCount: 1 });
		for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', sash.x + ((560 - sash.x) * i) / 12, sash.y, { button: 'left', buttons: 1 }); await sleep(30); }
		await mouse('mouseReleased', 560, sash.y, { button: 'left', clickCount: 1 });
		await sleep(800);
	}

	// a new line after line "fire" in process(), not saved
	// the key Enter makes no new line in the text editor of the test build, so the new line comes with the text
	await focusEditor();
	await key('End', 'End', 35);
	await wb.send('Input.insertText', { text: '\n  int cycle = 0;' });
	await until(() => wb.evaluate(`!!document.querySelector('.part.editor .tab.dirty')`), 'unsaved edit');
	try {
		await until(() => inSide(`return [...doc.querySelectorAll('.rows > .row')].some((r) => Number(r.dataset.line) === ${fire + 1} && r.textContent.includes('int cycle = 0;'));`),
			'new line in the side view');
	} catch (err) {
		result.rows = await inSide(`return [...doc.querySelectorAll('.rows > .row')].map((r) => r.dataset.line + ': ' + r.querySelector('.code')?.textContent).slice(0, 80);`);
		await shot('error');
		throw err;
	}

	// the command: the changes against the branch main, from the list of branches
	const labels = `[...document.querySelectorAll('.quick-input-list .monaco-list-row .label-name')].map((l) => l.textContent.trim())`;
	await command('DataFlow: Walk Through the Changes');
	await until(async () => (await isQuickInputOpen()) && (await wb.evaluate(labels)).includes('Changes against a branch…'), 'list of the changes');
	result.items = await wb.evaluate(labels);
	await wb.send('Input.insertText', { text: 'Changes against a branch' });
	await sleep(500);
	await key('Enter', 'Enter', 13);
	await until(async () => (await isQuickInputOpen()) && await wb.evaluate(`(document.querySelector('.quick-input-title')?.textContent ?? '').includes('Changes against a branch')`)
		&& (await wb.evaluate(labels)).includes('main'), 'list of the branches');
	result.branches = await wb.evaluate(labels);
	await wb.send('Input.insertText', { text: 'main' });
	await sleep(500);
	await key('Enter', 'Enter', 13);
	await until(() => inSide(`return !!doc.querySelector('.rg-bar') && doc.querySelectorAll('.rows > .row.df-add').length > 0 && !!doc.querySelector('.rg-diff');`), 'diff walk in the side view', 200);
	await sleep(1200);
	result.step1 = await walkState();

	// the card of the removed line
	await inSide(`doc.querySelector('.df-chip')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true;`);
	await until(() => inSide(`return !!doc.querySelector('.df-card');`), 'card of the removed line');
	await sleep(400);
	result.card = await inSide(`return { title: doc.querySelector('.df-card .card-title')?.textContent ?? null,
		rows: [...doc.querySelectorAll('.df-card .df-card-row')].map((r) => r.textContent), spans: doc.querySelectorAll('.df-card .df-card-row span').length };`);
	await shot('step1', await sideBox());
	await inSide(`doc.querySelector('.df-chip')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: doc.body })); return true;`);
	await sleep(500);

	// Next: the new line in process()
	await clickBar('Next');
	await until(async () => (await walkState()).current === 2, 'step 2');
	await sleep(1000);
	result.step2 = await walkState();
	await shot('step2', await sideBox());

	// the button Diff editor of the step opens the diff editor of VS Code
	await inSide(`[...doc.querySelectorAll('.rg-step.current .rg-actions button')].find((b) => b.textContent.trim() === 'Diff editor')?.click(); return true;`);
	await until(() => wb.evaluate(`[...document.querySelectorAll('.part.editor .tab .label-name')].some((l) => l.textContent.includes('to working tree'))`), 'diff editor', 80);
	result.diffEditor = await wb.evaluate(`[...document.querySelectorAll('.part.editor .tab .label-name')].map((l) => l.textContent).find((t) => t.includes('to working tree'))`);
	await sleep(800);

	// the MCP server, with the name of the client of Claude Code
	await command('DataFlow: Connect to Claude Code');
	let token;
	let url;
	for (let i = 0; i < 80 && !(token && url); i++) {
		token = existsSync(path.join(registry, 'token')) ? readFileSync(path.join(registry, 'token'), 'utf8').trim() : undefined;
		const win = existsSync(registry) ? readdirSync(registry).find((f) => /^window-\d+\.json$/.test(f)) : undefined;
		url = win ? JSON.parse(readFileSync(path.join(registry, win), 'utf8')).url : undefined;
		if (!(token && url)) { await sleep(250); }
	}
	if (!token || !url) { throw new Error('the MCP server did not start'); }
	let rpcId = 0;
	const rpc = async (method, params = {}) => (await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
	})).json();
	await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
	const tool = async (name, args = {}) => {
		const reply = await rpc('tools/call', { name, arguments: args });
		if (!reply.result || reply.result.isError) { throw new Error(`${name}: ${reply.result?.content?.[0]?.text ?? JSON.stringify(reply.error)}`); }
		return JSON.parse(reply.result.content[0].text);
	};
	result.prompts = (await rpc('prompts/list')).result.prompts.map((p) => p.name);
	const facts = await tool('get_diff', { base: 'target' });
	result.hunks = facts.files.flatMap((f) => f.hunks.map((h) => `${f.file} ${h.id} ${h.lines.join('-')} ${(h.functions ?? []).join(',')}`));
	result.hottest = (facts.hottestChanges ?? []).map((c) => c.function);
	result.plan = await tool('show_diff_walk', {
		title: 'A cycle counter and a larger limit',
		summary: 'process() gets a counter for the cycles, and the solver accepts a cost under 1e-4.',
		steps: [
			{ title: 'Add the counter of the cycles', hunks: ['h2'], kind: 'change', text: 'The new variable `cycle` starts at 0. **No code reads it yet.**', checks: ['Does a later change read cycle?'] },
			{ title: 'Loosen the limit of the cost', hunks: ['h1'], kind: 'risk', text: 'The solver accepts a plan with a cost under `1e-4`, ten times the old limit.' },
		],
	});
	await until(async () => (await walkState()).title === 'Add the counter of the cycles', 'plan of the model');
	await sleep(1000);
	result.model1 = await walkState();
	await tool('review_step', { step: 2, status: 'issue', note: 'A plan with a cost between `1e-5` and `1e-4` now converges. **Check the tests of the prices.**' });
	await until(async () => (await walkState()).current === 2, 'step 2 of the model');
	await sleep(1000);
	result.model2 = await walkState();
	await shot('model', await sideBox());
	await shot('window');
	result.view = (await tool('get_view')).review;

	// Heat on: each step of the tab Guide gets the flames of its hottest function. The lens shows its own tab, thus the
	// script selects the tab Guide again
	await command('DataFlow: Toggle Heat');
	await until(() => inSide(`return !!doc.querySelector('.details .tabs');`), 'tabs of the details column');
	await inSide(`[...doc.querySelectorAll('.details .tabs .tab')].find((t) => t.textContent.trim() === 'Guide')?.click(); return true;`);
	await until(() => inSide(`return doc.querySelectorAll('.rg-step .rg-heat').length === 2;`), 'heat of the steps', 200);
	await sleep(800);
	result.stepHeat = await inSide(`return [...doc.querySelectorAll('.rg-step')].map((s) => {
		const h = s.querySelector('.rg-heat');
		return h && { text: h.textContent, flames: h.querySelectorAll('.flame').length, band: [...h.classList].find((c) => c.startsWith('b-')), title: h.title };
	});`);
	await shot('heat-steps', await sideBox());
	await command('DataFlow: Toggle Heat');
	await until(() => inSide(`return !doc.querySelector('.rg-heat');`), 'heat off');

	// Close walk removes the bar and the marks of the diff
	await inSide(`[...doc.querySelectorAll('.rg-details button')].find((b) => b.textContent.includes('Close walk'))?.click(); return true;`);
	await sleep(800);
	result.closed = await inSide(`return !doc.querySelector('.rg-bar') && doc.querySelectorAll('.row.rg-line, .row.df-add, .row.df-del').length === 0;`);
	side.ws.close();
	wb.ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
}
console.log(JSON.stringify(result, null, 2));
