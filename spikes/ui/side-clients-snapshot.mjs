// Shows the layers of two clients in the side view of the VS Code test build: an MCP client and an extension with the API
// of DataFlow. The extension of spikes/ui/client-extension adds a note, a detail and a step with buttons. The script
// reads the bars of the two clients, the groups of the tab Model, and the clicks that the extension gets. It also takes
// screenshots.
// Usage: node spikes/ui/side-clients-snapshot.mjs <output folder> [dark|light|hc|hclight]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const [outArg, theme = 'dark'] = process.argv.slice(2);
const out = path.resolve(outArg);
const workspace = path.join(repo, 'test', 'fixtures', 'battery');
const file = path.join(workspace, 'src', 'battery.cpp');
const themes = { dark: 'Dark Modern', light: 'Light Modern', hc: 'Default High Contrast', hclight: 'Default High Contrast Light' };
const build = readdirSync(path.join(repo, '.vscode-test')).find((d) => d.startsWith('vscode-win32-x64-archive'));
const port = 9346;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const registry = path.join(out, 'mcp-registry');
const text = readFileSync(file, 'utf8').split(/\r?\n/);
const lineOf = (s) => text.findIndex((l) => l.includes(s)) + 1;

const userData = path.join(out, `user-data-clients-${theme}`);
mkdirSync(path.join(userData, 'User'), { recursive: true });
writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
	'workbench.colorTheme': themes[theme],
	'workbench.startupEditor': 'none',
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'chat.disableAIFeatures': true,
	'git.openRepositoryInParentFolders': 'never',
	'editor.minimap.enabled': false,
	'window.zoomLevel': 0,
}));

// the plan of the extension, and the file of its results and clicks
const chain = lineOf('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)');
const ready = lineOf('if (home_battery_ctl.charging_future && FINISHED(');
const moving = lineOf('HOMEPOWER_CHARGE_ACTIVE) {');
const converged = lineOf('if (converged) {');
const end = lineOf('return requests;');
const planFile = path.join(out, `client-plan-${theme}.json`);
const logFile = path.join(out, `client-log-${theme}.jsonl`);
writeFileSync(logFile, '');
writeFileSync(planFile, JSON.stringify({
	blocks: {
		file, function: 'process',
		blocks: [{ lines: [chain, end - 1], title: 'Run the state machine', children: [{ lines: [chain, moving - 1], title: 'Plan the charge' }] }],
	},
	notes: { file, ranges: [{ lines: [ready + 1, ready + 1], kind: 'warning', note: 'Waits for the solver', actions: [{ id: 'fix', title: 'Fix it' }, { id: 'skip', title: 'Skip' }] }] },
	detail: { file, line: converged, expression: 'converged', title: 'The result of the solver', text: 'The plan is ready.', actions: [{ id: 'open', title: 'Open the plan' }] },
	review: {
		title: 'Check the plan',
		steps: [{ title: 'The wait for the solver', file, lines: [ready + 1, ready + 2], text: 'Check the wait.', actions: [{ id: 'run', title: 'Run the check' }] }],
	},
	tab: {
		options: { id: 'plan', title: 'Plan' },
		content: {
			sections: [
				{
					title: 'Steps',
					rows: [
						{ id: 'r1', text: 'Check the wait for the solver', detail: 'The **solver** runs on a worker thread.', badge: 'risk 3', place: { file, line: converged }, actions: [{ id: 'accept', title: 'Accept' }] },
						{ text: 'Write the tests' },
					],
				},
				{ title: 'Notes', rows: [] },
			],
		},
	},
}));
const logged = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const clicks = () => logged().filter((x) => x.click).map((x) => ({ ...x.click, file: path.basename(x.click.file ?? '') }));

const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--extensionDevelopmentPath=${path.join(repo, 'spikes', 'ui', 'client-extension')}`,
	`--user-data-dir=${userData}`, `--extensions-dir=${path.join(out, 'extensions')}`, `--remote-debugging-port=${port}`,
	'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${chain}:1`,
], {
	stdio: 'ignore',
	// the MCP registry and the settings of Claude Code of the window are in the output folder, not in the home folder
	env: {
		...process.env, DATAFLOW_MCP_REGISTRY: registry, CLAUDE_CONFIG_DIR: path.join(out, 'claude-config'),
		DATAFLOW_UI_CLIENT_PLAN: planFile, DATAFLOW_UI_CLIENT_LOG: logFile,
	},
});

// a connection to one target of the remote debugging protocol
async function connect(url) {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let id = 0;
	const pending = new Map();
	ws.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
		}
	};
	const send = (method, params = {}) => new Promise((resolve) => {
		const n = ++id;
		pending.set(n, resolve);
		ws.send(JSON.stringify({ id: n, method, params }));
	});
	const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
	return { ws, send, evaluate };
}

const result = { pid: proc.pid, theme, lines: { note: ready + 1, detail: converged } };
try {
	let page;
	for (let i = 0; i < 120 && !page; i++) {
		try {
			page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('workbench'));
		} catch { /* not ready */ }
		if (!page) { await sleep(500); }
	}
	const wb = await connect(page.webSocketDebuggerUrl);
	const key = async (k, code, vk, modifiers = 0) => {
		await wb.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
		await wb.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
	};
	const quickInput = async (input) => {
		for (let i = 0; i < 20; i++) {
			if (await wb.evaluate(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none' && w.contains(document.activeElement); })()`)) {
				await wb.send('Input.insertText', { text: input });
				await sleep(500);
				await key('Enter', 'Enter', 13);
				return true;
			}
			await sleep(200);
		}
		return false;
	};
	// the visible text editor. A hidden editor has no size
	const editorBox = () => wb.evaluate(`(() => { const r = [...document.querySelectorAll('.part.editor .monaco-editor')].map((e) => e.getBoundingClientRect())
		.find((b) => b.width > 200 && b.height > 200); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	const focusEditor = async () => {
		const box = await editorBox();
		for (const type of ['mousePressed', 'mouseReleased']) {
			await wb.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
		}
		await sleep(300);
	};
	const command = async (input) => {
		await focusEditor();
		await key('P', 'KeyP', 80, 10); // ctrl+shift+p
		if (!await quickInput(input)) { throw new Error(`the command palette did not open for ${input}`); }
	};
	const shot = async (label) => {
		const res = await wb.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(path.join(out, `${theme}-clients-${label}.png`), Buffer.from(res.result.data, 'base64'));
	};

	// the side view is a webview in its own target. Its code runs in the frame "active-frame"
	let side;
	const inSide = (code) => side.evaluate(`(() => { const doc = document.querySelector('iframe#active-frame')?.contentDocument ?? document; ${code} })()`);
	const findSide = async () => {
		const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
		for (const t of targets.filter((x) => x.webSocketDebuggerUrl && x.url.includes('vscode-webview'))) {
			const c = await connect(t.webSocketDebuggerUrl);
			if (await c.evaluate(`!!(document.querySelector('iframe#active-frame')?.contentDocument ?? document).querySelector('.app .status')`)) {
				return c;
			}
			c.ws.close();
		}
		return undefined;
	};

	for (let i = 0; i < 60; i++) {
		if (await wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")')) { break; }
		await sleep(500);
	}
	await sleep(4000); // the start of the engine
	await command('DataFlow: Open Side View');
	for (let i = 0; i < 40 && !side; i++) { side = await findSide(); if (!side) { await sleep(250); } }
	if (!side) { throw new Error('the side view was not found'); }
	for (let i = 0; i < 120; i++) {
		if (await inSide(`return doc.querySelectorAll('.code span[class^="t"]').length;`)) { break; }
		await sleep(250);
	}

	// the MCP server: the connection to Claude Code starts it and writes the token file
	await command('DataFlow: Connect to Claude Code');
	let token;
	let url;
	for (let i = 0; i < 60 && !(token && url); i++) {
		const tokenFile = path.join(registry, 'token');
		token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined;
		const win = existsSync(registry) ? readdirSync(registry).find((f) => /^window-\d+\.json$/.test(f)) : undefined;
		url = win ? JSON.parse(readFileSync(path.join(registry, win), 'utf8')).url : undefined;
		if (!(token && url)) { await sleep(250); }
	}
	if (!token || !url) { throw new Error('the MCP server did not start'); }
	let id = 0;
	const rpc = async (method, params = {}) => (await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
	})).json();
	const tool = async (name, args) => {
		const reply = await rpc('tools/call', { name, arguments: args });
		if (!reply.result || reply.result.isError) {
			throw new Error(`${name}: ${reply.result?.content?.[0]?.text ?? JSON.stringify(reply.error)}`);
		}
		return JSON.parse(reply.result.content[0].text);
	};
	await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ui-test', version: '1' } });

	// the first client: two levels of blocks in process() and a comment
	await tool('show_blocks', {
		function: 'process',
		blocks: [{ lines: [chain, end - 1], title: 'Run the current state', children: [{ lines: [chain, moving - 1], title: 'Planning' }] }],
	});
	await tool('comment_lines', { comments: [{ line: chain, text: 'the state machine' }] });

	// the second client: the extension adds its blocks on the same lines, a note, a detail and a step with buttons
	await command('DataFlow UI Client: Show Items');
	for (let i = 0; i < 120 && !logged().some((x) => x.results || x.error); i++) { await sleep(250); }
	const done = logged().find((x) => x.results || x.error);
	if (!done?.results) { throw new Error(`the extension did not show its items: ${JSON.stringify(done ?? null)}`); }
	result.ids = { notes: done.results.notes.notes.map((n) => n.id), detail: done.results.detail.id };
	await sleep(1500);

	// the bars of the two clients side by side on one line, and the colors that they must have
	const probe = (variable) => `(() => { const p = doc.createElement('span'); p.style.color = 'var(${variable})'; doc.body.appendChild(p);
		const c = doc.defaultView.getComputedStyle(p).color; p.remove(); return c; })()`;
	const barsOf = (line) => inSide(`const row = doc.querySelector('.rows > .row[data-line="${line}"]');
		return row ? [...row.querySelectorAll('.ln .mbar')].map((b) => ({ cls: b.className.replace(/ (first|last)/g, ''), left: b.style.left,
			color: doc.defaultView.getComputedStyle(b).backgroundColor })) : null;`);
	result.bars = await barsOf(ready + 1);
	result.want = await inSide(`return { model: ${probe('--vscode-dataflow-model')}, blue: ${probe('--vscode-charts-blue')} };`);

	// the details column with the tab Model, and the cursor on the line of the note: the bar MODEL shows the note with its
	// buttons, and the tab Model has one group for each client
	await inSide(`const b = doc.querySelector('.toolbar button[title="Show or hide the details column"]');
		if (b && b.getAttribute('aria-pressed') !== 'true') { b.click(); }
		return true;`);
	await sleep(500);
	await inSide(`[...doc.querySelectorAll('.details .tab')].find((t) => t.textContent === 'Model')?.click(); return true;`);
	const clickLine = async (line) => {
		await inSide(`const s = doc.querySelector('.scroller'); s.scrollTop = ${line - 10} * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
		await sleep(500);
		return inSide(`const code = doc.querySelector('.rows > .row[data-line="${line}"] .code');
			const r = code.getBoundingClientRect();
			code.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 1, clientY: r.top + r.height / 2 }));
			return true;`);
	};
	await clickLine(ready + 1);
	await sleep(1500);
	result.modelBar = await inSide(`const bar = doc.querySelector('.modelbar');
		return bar ? { note: bar.querySelector('.mbar-note')?.textContent, buttons: [...bar.querySelectorAll('.item-action')].map((b) => b.textContent) } : null;`);
	result.noteTag = await inSide(`return doc.querySelector('.rows > .row[data-line="${ready + 1}"] .hint.model-tag.k-warning')?.title ?? null;`);
	result.groups = await inSide(`const body = doc.querySelector('.details-body.model');
		return body ? [...body.querySelectorAll('.mgroup')].map((g) => ({ client: g.querySelector('.mgroup-title')?.textContent,
			blocks: [...g.querySelectorAll('.mblock .mnum')].map((n) => n.textContent), buttons: [...g.querySelectorAll('.item-action')].map((b) => b.textContent) })) : null;`);
	await shot('layers');
	await inSide(`[...doc.querySelectorAll('.modelbar .item-action')].find((b) => b.textContent === 'Fix it')?.click(); return true;`);
	await sleep(1000);

	// the card of the detail names its client and has its button. The side view renders only the rows near the visible
	// part, so the view scrolls to the line first
	await inSide(`const s = doc.querySelector('.scroller'); s.scrollTop = ${converged - 10} * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
	await sleep(500);
	await inSide(`const mark = doc.querySelector('.rows > .row[data-line="${converged}"] .detail-mark');
		if (!mark) { return false; }
		const r = mark.getBoundingClientRect();
		mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
		return true;`);
	await sleep(600);
	result.card = await inSide(`const card = doc.querySelector('.detail-card');
		return card ? { client: card.querySelector('.mclient')?.textContent, buttons: [...card.querySelectorAll('.item-action')].map((b) => b.textContent) } : null;`);
	await shot('detail');
	await inSide(`doc.querySelector('.detail-card .item-action')?.click(); return true;`);
	await sleep(1000);

	// the step of the guide of the extension has its button in the tab Guide
	await inSide(`[...doc.querySelectorAll('.details .tab')].find((t) => t.textContent === 'Guide')?.click(); return true;`);
	await sleep(800);
	result.step = await inSide(`return [...doc.querySelectorAll('.rg-body .item-action')].map((b) => b.textContent);`);
	await shot('guide');
	await inSide(`doc.querySelector('.rg-body .item-action')?.click(); return true;`);
	await sleep(1000);

	// the tab of the extension comes after the tabs of DataFlow. A click on the text of a row with a place shows the line,
	// and its button goes to the extension
	result.tabNames = await inSide(`return [...doc.querySelectorAll('.details .tab')].map((t) => t.textContent);`);
	await inSide(`[...doc.querySelectorAll('.details .tab')].find((t) => t.textContent === 'Plan')?.click(); return true;`);
	await sleep(800);
	result.tab = await inSide(`const body = doc.querySelector('.details-body.ext-tab');
		return body ? { client: body.dataset.client, sections: [...body.querySelectorAll('.tab-section')].map((s) => ({
			title: s.querySelector('.tab-section-title')?.textContent,
			rows: [...s.querySelectorAll('.tab-row')].map((r) => ({ text: r.querySelector('.tab-text')?.textContent, isLink: !!r.querySelector('button.tab-place'),
				badge: r.querySelector('.tab-badge')?.textContent, detail: r.querySelector('.tab-detail')?.textContent, bold: r.querySelector('.tab-detail strong')?.textContent,
				buttons: [...r.querySelectorAll('.item-action')].map((b) => b.textContent) })),
			empty: s.querySelector(':scope > p.sub')?.textContent })) } : null;`);
	await shot('tab');
	await inSide(`doc.querySelector('.ext-tab button.tab-place')?.click(); return true;`);
	await sleep(1500);
	result.tabPlace = await inSide(`return Number(doc.querySelector('.rows > .row.cursor')?.dataset.line ?? 0);`);
	await inSide(`doc.querySelector('.ext-tab .item-action')?.click(); return true;`);
	await sleep(1000);
	result.clicks = clicks();

	// clear of the MCP client removes only its layer. The bars of the extension go to the first columns
	result.cleared = (await tool('clear', {})).removed;
	await sleep(1500);
	result.barsAfterClear = await barsOf(ready + 1);
	side.ws.close();
	wb.ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
}
console.log(JSON.stringify(result, null, 2));
