// Change Ripple in the side view on the review fixture: acceptance scenario 4 in the story. The script reviews the
// changes and makes screenshots of the wave, of the story after the wave, of the end of the chain, of
// the story in a wide side view with two columns, and of the file view after a click on a card. The Explorer closes,
// so the side view has more space.
// Usage: node spikes/ui/side-ripple-snapshot.mjs <output folder> [dark|light|hc|hclight]
// scripts/prepare-fixtures.mjs makes the review fixture in build/fixtures/battery-review.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const [outArg, theme = 'dark'] = process.argv.slice(2);
const out = path.resolve(outArg);
const workspace = path.join(repo, 'build', 'fixtures', 'battery-review');
const file = path.join(workspace, 'src', 'battery.cpp');
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
const themes = { dark: 'Dark Modern', light: 'Light Modern', hc: 'Default High Contrast', hclight: 'Default High Contrast Light' };
const build = readdirSync(path.join(repo, '.vscode-test')).find((d) => d.startsWith('vscode-win32-x64-archive'));
const port = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = path.join(out, `user-data-side-ripple-${theme}`);
const settingsFile = path.join(userData, 'User', 'settings.json');
const settings = {
	'workbench.colorTheme': themes[theme],
	'workbench.startupEditor': 'none',
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'chat.disableAIFeatures': true,
	'editor.minimap.enabled': false,
	'window.zoomLevel': 0,
};
mkdirSync(path.dirname(settingsFile), { recursive: true });
writeFileSync(settingsFile, JSON.stringify(settings));

const changeLine = lineOf('if (cost < 1e-4)');
const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`,
	`--extensions-dir=${path.join(out, 'extensions')}`, `--remote-debugging-port=${port}`,
	'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${changeLine}:5`,
], {
	stdio: 'ignore',
	// the MCP registry and the settings of Claude Code of the window are in the output folder, not in the home folder
	env: { ...process.env, DATAFLOW_MCP_REGISTRY: path.join(out, 'mcp-registry'), CLAUDE_CONFIG_DIR: path.join(out, 'claude-config') },
});

// a connection to one target of the remote debugging protocol
async function connect(url) {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let nextId = 0;
	const pending = new Map();
	ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
	const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
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
	const quickInput = async (text) => {
		for (let i = 0; i < 20; i++) {
			if (await wb.evaluate(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none' && w.contains(document.activeElement); })()`)) {
				await wb.send('Input.insertText', { text });
				await sleep(700);
				await key('Enter', 'Enter', 13);
				return true;
			}
			await sleep(200);
		}
		return false;
	};
	// a click on a tab gives the focus to its editor group. The first tab is the tab of the text editor
	const focusTab = async (label) => {
		const tab = await wb.evaluate(`(() => {
			const tabs = [...document.querySelectorAll('.part.editor .tab')];
			const t = ${JSON.stringify(label)} ? tabs.find((x) => (x.getAttribute('aria-label') ?? x.textContent).includes(${JSON.stringify(label)})) : document.querySelector('.part.editor .tab.active');
			const r = t.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		})()`);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await wb.send('Input.dispatchMouseEvent', { type, x: tab.x, y: tab.y, button: 'left', clickCount: 1 });
		}
		await sleep(300);
	};
	const command = async (text, tab = '') => {
		await focusTab(tab);
		await key('P', 'KeyP', 80, 10); // ctrl+shift+p
		if (!await quickInput(text)) { throw new Error(`the command palette did not open for ${text}`); }
	};
	const shot = async (label, clip) => {
		const res = await wb.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
		writeFileSync(path.join(out, `${theme}-ripple-${label}.png`), Buffer.from(res.result.data, 'base64'));
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
	const storyState = () => inSide(`
		const texts = (sel) => [...doc.querySelectorAll(sel)].map((e) => e.textContent.trim());
		return {
			bar: doc.querySelector('.lensbar[aria-label="Change Ripple"]')?.textContent,
			toolbar: doc.querySelector('.toolbar')?.textContent,
			notes: texts('.story-note'),
			diff: [...doc.querySelectorAll('.sdiff .srow')].map((r) => r.className.replace('srow ', '') + ' ' + r.textContent.trim()),
			changedText: texts('.sdiff .chg-text'),
			stats: texts('.stat'),
			cards: [...doc.querySelectorAll('.scard')].map((c) => ({
				where: c.querySelector('.where').textContent.trim(),
				rows: [...c.querySelectorAll('.srow')].map((r) => r.querySelector('.ln').textContent + (r.classList.contains('lit') ? '*' : '')),
				notes: [...c.querySelectorAll('.note')].map((n) => n.textContent),
				under: [...c.querySelectorAll('.srow.note-under')].map((r) => r.dataset.line),
				exits: [...c.querySelectorAll('.exits .badge')].map((b) => b.textContent),
				lit: c.classList.contains('lit'),
			})),
			links: texts('.slink'),
			front: doc.querySelectorAll('.srow.front').length,
			lit: doc.querySelectorAll('.srow.lit').length,
			tokens: doc.querySelectorAll('.scard .code span[class^="t"]').length,
			columns: getComputedStyle(doc.querySelector('.story-grid')).gridTemplateColumns,
		};`);
	// the webview is not in the DOM of the editor group, so the box is the content of the editor group at the right
	const sideBox = () => wb.evaluate(`(() => {
		const groups = [...document.querySelectorAll('.part.editor .editor-group-container .editor-container')]
			.map((g) => g.getBoundingClientRect()).filter((r) => r.width > 200);
		const r = groups.sort((a, b) => b.left - a.left)[0];
		return r && { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
	})()`);
	const clickIn = (selector, label) => inSide(`[...doc.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))?.click(); return true;`);

	for (let i = 0; i < 60; i++) {
		if (await wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")')) { break; }
		await sleep(500);
	}
	await sleep(4000); // the start of the engine and of the git extension

	// a review in the side mode opens the side view with the story
	await command('DataFlow: Review Changes');
	for (let i = 0; i < 40 && !side; i++) { side = await findSide(); if (!side) { await sleep(250); } }
	if (!side) { throw new Error('the side view was not found'); }
	const isVisible = (selector) => wb.evaluate(`(() => { const p = document.querySelector('${selector}'); return !!p && p.offsetWidth > 0; })()`);
	if (await isVisible('.part.sidebar')) {
		await focusTab('');
		await key('b', 'KeyB', 66, 2);
	}
	if (await isVisible('.part.auxiliarybar')) {
		await focusTab('');
		await key('b', 'KeyB', 66, 3);
	}
	// the wave starts when the story comes. The screenshot shows the wave after its third step
	let start = 0;
	for (let i = 0; i < 240 && !start; i++) {
		if (await inSide(`return doc.querySelectorAll('.scard').length >= 3 && doc.querySelectorAll('.scard .code span[class^="t"]').length > 0;`)) {
			start = Date.now();
		} else {
			await sleep(100);
		}
	}
	if (!start) { throw new Error('the story did not come'); }
	await sleep(Math.max(0, 250 + 2 * 420 + 200 - (Date.now() - start)));
	result.wave = await inSide(`return { front: [...doc.querySelectorAll('.srow.front .ln')].map((l) => l.textContent), lit: doc.querySelectorAll('.srow.lit').length };`);
	await shot('wave', await sideBox());

	await sleep(4500);
	result.story = await storyState();
	await shot('story', await sideBox());
	await inSide(`const s = doc.querySelector('.story'); s.scrollTop = s.scrollHeight; return true;`);
	await sleep(400);
	await shot('story-end', await sideBox());
	await inSide(`const s = doc.querySelector('.story'); s.scrollTop = 0; return true;`);

	// a wide side view shows the diff at the left and the chain at the right
	await command('View: Toggle Maximize Editor Group', 'DataFlow');
	await sleep(1500);
	result.wide = await inSide(`return getComputedStyle(doc.querySelector('.story-grid')).gridTemplateColumns;`);
	await shot('wide');
	await command('View: Toggle Maximize Editor Group', 'DataFlow');
	await sleep(1000);

	// "Replay ripple" plays the wave again
	await clickIn('.panel-title button', 'Replay ripple');
	await sleep(250 + 420 + 150);
	result.replay = await inSide(`return { front: doc.querySelectorAll('.srow.front').length, lit: doc.querySelectorAll('.srow.lit').length };`);
	await sleep(4500);

	// a click on the row of the value of the future shows the line in the file view and in the editor
	const futureLine = lineOf('auto converged = ');
	await inSide(`doc.querySelector('.scard .srow[data-line="${futureLine}"] .code').click(); return true;`);
	await sleep(1500);
	result.fileView = await inSide(`return {
		mode: doc.querySelector('.story') ? 'story' : 'file',
		bar: doc.querySelector('.lensbar[aria-label="Change Ripple"]')?.textContent,
		reached: doc.querySelectorAll('.row.rp-reached').length,
		estimated: doc.querySelectorAll('.row.rp-est').length,
		changed: [...doc.querySelectorAll('.row.rp-change')].map((r) => r.dataset.line),
		hints: [...doc.querySelectorAll('.hint.ripple')].map((h) => h.closest('.row').dataset.line + ': ' + h.textContent),
	};`);
	result.cursor = await wb.evaluate(`document.querySelector('.part.editor .editor-group-container .monaco-editor .cursors-layer') ? 'ok' : 'none'`);
	await shot('file-view', await sideBox());
	await shot('window');

	// the button of the bar goes back to the story
	await clickIn('.lensbar button', 'Story');
	await sleep(800);
	result.back = await inSide(`return !!doc.querySelector('.story .scard');`);

	// a click on the added line of the diff shows the changed line in the file view
	await inSide(`doc.querySelector('.sdiff .srow.d-added .code').click(); return true;`);
	await sleep(1500);
	result.changeView = await inSide(`return {
		changed: [...doc.querySelectorAll('.row.rp-change')].map((r) => r.dataset.line),
		bar: doc.querySelector('.lensbar[aria-label="Change Ripple"]')?.getBoundingClientRect().height,
	};`);
	await shot('file-view-change', await sideBox());

	// "Open the diff editor" opens the diff in the group of the text editor, not over the side view
	await clickIn('.lensbar button', 'Story');
	await sleep(800);
	await clickIn('.sdiff-bar button', 'Open the diff editor');
	await sleep(2500);
	result.diffEditor = await wb.evaluate(`[...document.querySelectorAll('.part.editor .editor-group-container')].map((g) =>
		[...g.querySelectorAll('.tab')].map((t) => (t.getAttribute('aria-label') ?? t.textContent).split(',')[0]).join(' | '))`);
	await shot('diff-editor');

	result.dirty = await wb.evaluate(`!!document.querySelector('.tab.dirty')`);
	wb.ws.close();
	side.ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
}
console.log(JSON.stringify(result, null, 2));
