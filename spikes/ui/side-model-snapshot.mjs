// Shows the layers of a language model in the side view of the VS Code test build: blocks in five levels, and comments
// in colors. The script connects DataFlow to Claude Code with the settings of Claude Code in the output folder, so the
// MCP server writes its token file there. Then it calls the tools of the server over HTTP, reads the side view and
// takes screenshots.
// Usage: node spikes/ui/side-model-snapshot.mjs <output folder> [dark|light|hc|hclight]
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
const port = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const registry = path.join(out, 'mcp-registry');
const text = readFileSync(file, 'utf8').split(/\r?\n/);
const lineOf = (s) => text.findIndex((l) => l.includes(s)) + 1;

const userData = path.join(out, `user-data-model-${theme}`);
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

const chain = lineOf('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)');
const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`,
	`--extensions-dir=${path.join(out, 'extensions')}`, `--remote-debugging-port=${port}`,
	'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${chain}:1`,
], {
	stdio: 'ignore',
	// the MCP registry and the settings of Claude Code of the window are in the output folder, not in the home folder
	env: { ...process.env, DATAFLOW_MCP_REGISTRY: registry, CLAUDE_CONFIG_DIR: path.join(out, 'claude-config') },
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

const result = { pid: proc.pid, theme };
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
		writeFileSync(path.join(out, `${theme}-model-${label}.png`), Buffer.from(res.result.data, 'base64'));
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
	const lnWidth = (line) => inSide(`const ln = doc.querySelector('.rows > .row[data-line="${line}"] .ln'); return ln ? Math.round(ln.getBoundingClientRect().width) : -1;`);
	const converged = lineOf('if (converged) {');
	const deep = converged + 3;
	result.lnWidthBefore = await lnWidth(deep);

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

	// five levels of blocks in the planning branch of process(), and three comments
	const ready = lineOf('if (home_battery_ctl.charging_future && FINISHED(');
	const again = lineOf('// with no converged schedule, try the next price slot') - 1;
	const moving = lineOf('HOMEPOWER_CHARGE_ACTIVE) {');
	const end = lineOf('return requests;');
	await tool('show_blocks', {
		function: 'process',
		blocks: [{
			lines: [chain, end - 1], title: 'Run the current state', children: [{
				lines: [chain, moving - 1], title: 'Planning', children: [
					{ lines: [ready + 1, ready + 2], title: 'Take the result of the solver' },
					{
						lines: [converged, moving - 2], title: 'Use the result', children: [
							{ lines: [converged, again - 1], title: 'Converged', children: [{ lines: [converged + 2, converged + 6], title: 'Make the commands' }] },
							{ lines: [again, moving - 2], title: 'Plan again' },
						],
					},
				],
			}],
		}],
	});
	await tool('comment_lines', {
		comments: [
			{ line: ready + 1, text: 'waits for the result of the solver', color: 'purple' },
			{ line: deep, text: 'the inverter runs these requests next', color: 'green' },
			{ line: again + 2, text: 'picks a new price slot and plans again' },
		],
	});
	await sleep(1500);

	result.bars = await inSide(`return [...doc.querySelectorAll('.rows > .row[data-line="${deep}"] .ln .mbar')].map((b) => b.className);`);
	result.lnWidth = await lnWidth(deep);
	// the color of a comment, and the color that it must have
	const commentOf = (line, color) => inSide(`
		const tag = doc.querySelector('.rows > .row[data-line="${line}"] .hint.model-tag.k-comment');
		if (!tag) { return null; }
		const probe = doc.createElement('span');
		probe.style.color = 'var(${color})';
		doc.body.appendChild(probe);
		const want = doc.defaultView.getComputedStyle(probe).color;
		probe.remove();
		return { text: tag.textContent, color: doc.defaultView.getComputedStyle(tag).color, want };`);
	result.purple = await commentOf(ready + 1, '--vscode-charts-purple');
	result.green = await commentOf(deep, '--vscode-charts-green');
	result.plain = await commentOf(again + 2, '--vscode-dataflow-modelComment');
	result.details = await inSide(`return { comments: doc.querySelectorAll('.mcomment').length, deepest: doc.querySelectorAll('.mblock.lvl-4').length };`);

	// the cursor on the line of the purple comment: the bar MODEL shows the blocks and the comment
	await inSide(`const span = [...doc.querySelectorAll('.rows > .row[data-line="${ready + 1}"] .code span')].find((s) => s.textContent === 'auto');
		const r = span.getBoundingClientRect();
		span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 2, clientY: r.top + r.height / 2 }));
		return true;`);
	await sleep(1000);
	result.modelBar = await inSide(`return doc.querySelector('.modelbar')?.textContent ?? '';`);
	await shot('layers');

	// the comments after the code: the details column closes, and the view scrolls to the end of the line of a comment
	await inSide(`doc.querySelector('.toolbar button[title="Show or hide the details column"]')?.click(); return true;`);
	await sleep(500);
	await inSide(`doc.querySelector('.rows > .row[data-line="${deep}"] .hint.model-tag.k-comment')?.scrollIntoView({ block: 'center', inline: 'end' }); return true;`);
	await sleep(800);
	await shot('comments');

	// a selection of code in the side view goes to the text editor, so get_view gives it
	const selectLine = lineOf('auto converged = home_battery_ctl.charging_future->get();');
	await inSide(`doc.querySelector('.scroller').scrollLeft = 0; doc.querySelector('.rows > .row[data-line="${selectLine}"]')?.scrollIntoView({ block: 'center' }); return true;`);
	await sleep(500);
	await inSide(`const span = [...doc.querySelectorAll('.rows > .row[data-line="${selectLine}"] .code span')].find((s) => s.textContent === 'converged');
		const range = doc.createRange();
		range.selectNodeContents(span);
		const selection = doc.defaultView.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
		const r = span.getBoundingClientRect();
		span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.right - 1, clientY: r.top + r.height / 2 }));
		return true;`);
	await sleep(1000);
	result.selection = (await tool('get_view', {})).selection;

	// a detail on an expression: a symbol at the end of the line. The mouse on the code opens no card. The mouse on the
	// symbol opens the card with the text, and the code of the detail gets a background while the card shows
	await tool('add_detail', {
		line: converged, expression: 'converged', title: 'Examples of converged',
		text: 'The result of the solver:\n\n- `true`: the plan is ready, and the battery charges.\n- `false`: DataFlow plans again with a **new price slot**.',
	});
	await sleep(1500);
	await inSide(`const span = [...doc.querySelectorAll('.rows > .row[data-line="${converged}"] .code span')].find((s) => s.textContent === 'converged');
		span.scrollIntoView({ block: 'center' });
		const r = span.getBoundingClientRect();
		span.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + 2, clientY: r.top + r.height / 2 }));
		return true;`);
	await sleep(600);
	result.cardOnCode = await inSide(`return !!doc.querySelector('.detail-card');`);
	// the line has the titles of two blocks, so its end is outside of the view, and the symbol stays at the right edge
	result.detailMark = await inSide(`
		const mark = doc.querySelector('.rows > .row[data-line="${converged}"] .detail-mark');
		if (!mark) { return null; }
		const r = mark.getBoundingClientRect();
		mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
		const view = doc.querySelector('.scroller').getBoundingClientRect();
		return { text: mark.textContent.trim(), isVisible: r.left >= view.left && r.right <= view.right + 1 };`);
	await sleep(600);
	result.detailCard = await inSide(`const card = doc.querySelector('.detail-card');
		return card ? { title: card.querySelector('.detail-title')?.textContent, items: card.querySelectorAll('li').length, bold: card.querySelector('strong')?.textContent } : null;`);
	result.activeCode = await inSide(`return [...doc.querySelectorAll('.mdetail')].map((e) => e.textContent).join('|');`);
	await shot('detail');
	// the mouse goes from the symbol to the code: the card closes, and the code has no background
	await inSide(`const mark = doc.querySelector('.rows > .row[data-line="${converged}"] .detail-mark');
		const span = doc.querySelector('.rows > .row[data-line="${converged}"] .code');
		mark.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: span }));
		return true;`);
	await sleep(600);
	result.cardAfterLeave = await inSide(`return !!doc.querySelector('.detail-card') || doc.querySelectorAll('.mdetail').length > 0;`);

	// the switch Model in the toolbar hides the layers of the model in the code and the bar MODEL, and shows them again
	const modelSwitch = `[...doc.querySelectorAll('.toolbar button.lens')].find((x) => x.textContent.trim() === 'Model')`;
	const layerCount = () => inSide(`return doc.querySelectorAll('.mbar, .detail-mark, .model-tag, .modelbar').length;`);
	result.switch = {
		before: await layerCount(),
		// the switch shows in the toolbar of a narrow side view, which cuts the last lens buttons
		isVisible: await inSide(`const r = ${modelSwitch}?.getBoundingClientRect(); const t = doc.querySelector('.toolbar').getBoundingClientRect();
			return !!r && r.left >= t.left && r.right <= t.right;`),
	};
	await inSide(`${modelSwitch}?.click(); return true;`);
	await sleep(800);
	result.switch.hidden = await layerCount();
	result.switch.pressed = await inSide(`return ${modelSwitch}?.getAttribute('aria-pressed') ?? null;`);
	await shot('hidden');
	await inSide(`${modelSwitch}?.click(); return true;`);
	await sleep(800);
	result.switch.shown = await layerCount();

	// blocks for a second function: the blocks of process() stay, and the tab Model shows the blocks of the function at the
	// cursor
	const solve = lineOf('std::optional<double> solve_power_plan(');
	await tool('show_blocks', { function: 'solve_power_plan', blocks: [{ lines: [solve + 1, solve + 2], title: 'Prepare the solver' }] });
	await sleep(1000);
	await inSide(`const b = doc.querySelector('.toolbar button[title="Show or hide the details column"]');
		if (b && b.getAttribute('aria-pressed') !== 'true') { b.click(); }
		return true;`);
	await sleep(500);
	await inSide(`[...doc.querySelectorAll('.details .tab')].find((t) => t.textContent === 'Model')?.click(); return true;`);
	// the side view renders only the rows near the visible part, so the view scrolls to the line first
	const clickLine = async (line) => {
		await inSide(`const s = doc.querySelector('.scroller'); s.scrollTop = ${line - 10} * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
		await sleep(500);
		return inSide(`const code = doc.querySelector('.rows > .row[data-line="${line}"] .code');
			const r = code.getBoundingClientRect();
			code.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 1, clientY: r.top + r.height / 2 }));
			return true;`);
	};
	const tabState = () => inSide(`const body = doc.querySelector('.details-body.model');
		return body ? { fn: body.querySelector('.flow-title strong')?.textContent, blocks: body.querySelectorAll('.mblock').length,
			fns: [...body.querySelectorAll('.mfn')].map((b) => b.textContent) } : null;`);
	await clickLine(solve + 1);
	await sleep(1500);
	result.tabInSolve = await tabState();
	await shot('functions');
	await clickLine(chain + 1);
	await sleep(1500);
	result.tabInProcess = await tabState();
	side.ws.close();
	wb.ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
}
console.log(JSON.stringify(result, null, 2));
