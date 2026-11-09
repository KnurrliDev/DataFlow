// The guided review in the side view of the VS Code test build, on the review fixture. The script acts as the language
// model: it gets the files of the folder src through the MCP server, sends a plan of four steps, and goes through the
// plan with the buttons of the side view and with the tool review_step. Change Ripple stays off. It reads the side view
// and takes screenshots.
// Usage: node spikes/ui/side-guide-snapshot.mjs <output folder>
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
const port = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const registry = path.join(out, 'mcp-registry');
const text = readFileSync(file, 'utf8').split(/\r?\n/);
const lineOf = (s) => text.findIndex((l) => l.includes(s)) + 1;

const userData = path.join(out, 'user-data-guide');
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
	'window.zoomLevel': 0,
}));

const changed = lineOf('if (cost < 1e-4)');
const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`, `--extensions-dir=${path.join(out, 'extensions')}`,
	`--remote-debugging-port=${port}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${changed}:1`,
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
	let wb = await connect(page.webSocketDebuggerUrl);
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
	const command = async (title) => {
		await focusEditor();
		await key('P', 'KeyP', 80, 10);
		for (let i = 0; i < 25; i++) {
			if (await wb.evaluate(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none' && w.contains(document.activeElement); })()`)) {
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
		writeFileSync(path.join(out, `guide-${label}.png`), Buffer.from(res.result.data, 'base64'));
	};
	// the state of the guide in the side view
	const guideState = () => inSide(`return {
		bar: doc.querySelector('.rg-bar')?.textContent ?? null,
		current: [...doc.querySelectorAll('.rg-step')].findIndex((s) => s.classList.contains('current')) + 1,
		statuses: [...doc.querySelectorAll('.rg-step')].map((s) => [...s.classList].find((c) => c.startsWith('st-'))),
		lines: [...doc.querySelectorAll('.rows > .row.rg-line')].map((r) => Number(r.dataset.line)),
		tag: doc.querySelector('.rg-tag')?.textContent ?? null,
		note: doc.querySelector('.rg-step.current .rg-note')?.textContent ?? null,
		checks: [...doc.querySelectorAll('.rg-step.current .rg-checks li')].map((l) => l.textContent),
		progress: doc.querySelector('.rg-progress .sub')?.textContent ?? null,
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
	// the text editor gets 600 px, the side view the rest
	const sash = await wb.evaluate(`(() => { const r = [...document.querySelectorAll('.part.editor .monaco-sash.vertical')].map((e) => e.getBoundingClientRect())
		.find((b) => b.height > 200 && b.left > 100); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	if (sash) {
		await mouse('mouseMoved', sash.x, sash.y);
		await mouse('mousePressed', sash.x, sash.y, { button: 'left', clickCount: 1 });
		for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', sash.x + ((600 - sash.x) * i) / 12, sash.y, { button: 'left', buttons: 1 }); await sleep(30); }
		await mouse('mouseReleased', 600, sash.y, { button: 'left', clickCount: 1 });
		await sleep(800);
	}

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

	// the files that the user names: the folder src, and a path that does not exist. No ripple runs
	const facts = await tool('get_review', { paths: ['src', 'tests'] });
	result.facts = {
		target: facts.target, notFound: facts.notFound,
		files: facts.files.map((f) => `${f.file} ${f.lines}${f.isChanged ? ` changed ${f.changedLines}` : ''}`),
		diff: facts.files.find((f) => f.isChanged)?.diff.split('\n').filter((l) => /^[+-]/.test(l)),
	};
	result.noRipple = await inSide(`const b = [...doc.querySelectorAll('.toolbar button.lens')].find((x) => x.textContent.trim() === 'Change Ripple');
		return { ripplePressed: b?.getAttribute('aria-pressed') ?? null, story: !!doc.querySelector('.story') };`);
	// a plan that a model makes from these facts
	const plan = {
		title: 'Review of the new cost limit',
		summary: 'The solver now accepts a plan with a cost under 1e-4 instead of 1e-5. The result goes through the executor to process(), which makes the charge requests.',
		steps: [
			{
				title: 'Check the new limit', file: 'src/battery.cpp', lines: [changed, changed + 2], kind: 'change',
				text: 'The solver now accepts a plan with a cost under `1e-4`, ten times the old limit. A plan converges earlier, but it can be **less exact**.',
				checks: ['Is 1e-4 small enough for the price data?', 'Does a test cover a cost between 1e-5 and 1e-4?'],
			},
			{
				title: 'Follow the result out of the solver', lines: [lineOf('opt.last_cost = cost;'), lineOf('return res;')], kind: 'ripple',
				text: '`res` gets the cost only on the path of the limit. The function returns it to the lambda in `process()`, which runs on the executor.',
				checks: ['Can the loop end with an empty res?'],
			},
			{
				title: 'See where process() uses the result', lines: [lineOf('if (home_battery_ctl.charging_future && FINISHED('), lineOf('fire_transition(home_battery_ctl, "_planned");')],
				kind: 'ripple',
				text: '`process()` gets the result through `charging_future`. With the new limit, more plans converge, so this branch makes **requests** more often.',
				checks: ['Does make_requests() accept a less exact plan?'],
			},
			{
				title: 'Check the shared state of the solver', lines: [lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)'), lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)') + 2],
				kind: 'risk',
				text: 'The solver runs on a worker thread and writes `charge.is_dirty`. `process()` reads it before it checks the future.',
				checks: ['Is the access to is_dirty safe?'],
			},
		],
	};
	result.plan = await tool('show_review_plan', plan);
	await until(() => inSide(`return !!doc.querySelector('.rg-bar') && doc.querySelectorAll('.rows > .row.rg-line').length > 0;`), 'guide in the side view');
	await sleep(1200);
	result.step1 = await guideState();
	await shot('plan', await sideBox());

	// the user: OK for step 1, then Next
	await clickBar('Mark the step: OK');
	await sleep(500);
	await clickBar('Next');
	await until(async () => (await guideState()).current === 2, 'step 2');
	await sleep(800);
	result.step2 = await guideState();

	// the model answers the question of step 2, then the user goes to step 4
	await tool('review_step', { step: 2, status: 'question', note: 'The loop ends with an empty `res` if the cost stays at or above `1e-4`. Then `process()` takes the branch of no converged schedule.' });
	await sleep(600);
	result.afterNote = await guideState();
	await clickBar('Next');
	await sleep(600);
	await clickBar('Next');
	await until(async () => (await guideState()).current === 4, 'step 4');
	// the model marks the risk as an issue
	await tool('review_step', {
		step: 4, status: 'issue',
		note: 'The worker thread writes `charge.is_dirty` on line 76, and `process()` reads it on line 94 with no lock. **Swap the conditions** to check the future first.',
	});
	await sleep(1200);
	result.step4 = await guideState();
	await shot('issue', await sideBox());
	await shot('window');
	result.view = (await tool('get_view')).review;

	// the command Previous Guide Step goes to step 3
	await command('DataFlow: Previous Guide Step');
	await until(async () => (await guideState()).current === 3, 'step 3 after the command');
	result.afterCommand = (await guideState()).current;
	await sleep(1500); // the state of the workspace keeps the guide after a short pause

	// a reload of the window: the guide comes back with its current step and its marks
	await command('Developer: Reload Window');
	wb.ws.close();
	side.ws.close();
	side = undefined;
	await sleep(3000);
	for (let i = 0; i < 80 && !side; i++) {
		try { side = await findSide(); } catch { /* the window starts again */ }
		if (!side) { await sleep(500); }
	}
	if (!side) { throw new Error('the side view did not come back after the reload'); }
	const page2 = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('workbench'));
	wb = await connect(page2.webSocketDebuggerUrl);
	await wb.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
	await until(async () => !!(await guideState()).bar, 'guide after the reload', 160);
	await sleep(800);
	result.afterReload = await guideState();

	// the button Copy summary, then Close review removes the guide. The title in the bar opens the tab Guide
	await inSide(`doc.querySelector('.rg-bar .rg-title')?.click(); return true;`);
	await until(() => inSide(`return !!doc.querySelector('.rg-details');`), 'tab Guide');
	await inSide(`[...doc.querySelectorAll('.rg-footer button')].find((b) => b.textContent.includes('Copy summary'))?.click(); return true;`);
	await sleep(500);
	await inSide(`[...doc.querySelectorAll('.rg-details button')].find((b) => b.textContent.includes('Close review'))?.click(); return true;`);
	await sleep(800);
	result.closed = await inSide(`return !doc.querySelector('.rg-bar') && doc.querySelectorAll('.row.rg-line').length === 0;`);
	side.ws.close();
	wb.ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
}
console.log(JSON.stringify(result, null, 2));
