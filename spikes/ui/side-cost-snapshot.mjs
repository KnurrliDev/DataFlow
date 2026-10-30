// Hidden C++ in the side view on the CMake fixture: acceptance scenario 3 in stable_readings(). The script turns on
// Hidden C++ and makes screenshots of the marks and the chips, of the hover card of the lookups with
// their connector, of the card of a chip, of a category switch, of "Not useful", and of Flow Lens and Hidden C++
// together. The Explorer closes, so the side view has space for the details column.
// Usage: node spikes/ui/side-cost-snapshot.mjs <output folder> [dark|light|hc|hclight] [workspace folder file line]
// With a workspace, a file and a line, the script turns on Hidden C++ with the cursor on the line and makes one
// screenshot.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const [outArg, theme = 'dark', workspaceArg, fileArg, lineArg] = process.argv.slice(2);
const out = path.resolve(outArg);
const workspace = path.resolve(workspaceArg ?? path.join(repo, 'test', 'fixtures', 'battery'));
const file = path.resolve(fileArg ?? path.join(workspace, 'src', 'battery.cpp'));
const isCustom = !!lineArg;
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const lineOf = (text, from = 0) => lines.findIndex((l, i) => i >= from && l.includes(text)) + 1;
const themes = { dark: 'Dark Modern', light: 'Light Modern', hc: 'Default High Contrast', hclight: 'Default High Contrast Light' };
const build = readdirSync(path.join(repo, '.vscode-test')).find((d) => d.startsWith('vscode-win32-x64-archive'));
const port = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = path.join(out, `user-data-side-cost-${theme}`);
const settingsFile = path.join(userData, 'User', 'settings.json');
const settings = {
	'workbench.colorTheme': themes[theme],
	'workbench.startupEditor': 'none',
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'chat.disableAIFeatures': true,
	'git.openRepositoryInParentFolders': 'never',
	'editor.minimap.enabled': false,
	'window.zoomLevel': 0,
};
mkdirSync(path.dirname(settingsFile), { recursive: true });
writeFileSync(settingsFile, JSON.stringify(settings));

const fnLine = isCustom ? Number(lineArg) : lineOf('stable_readings(const MeterFeeds');
const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`,
	`--extensions-dir=${path.join(out, 'extensions')}`, `--remote-debugging-port=${port}`,
	'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${fnLine}:5`,
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
	// a click on the tab of the editor gives the focus to the editor and does not move the cursor
	const focusEditor = async () => {
		const tab = await wb.evaluate(`(() => { const r = document.querySelector('.part.editor .tab.active').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await wb.send('Input.dispatchMouseEvent', { type, x: tab.x, y: tab.y, button: 'left', clickCount: 1 });
		}
		await sleep(300);
	};
	const command = async (text) => {
		await focusEditor();
		await key('P', 'KeyP', 80, 10); // ctrl+shift+p
		if (!await quickInput(text)) { throw new Error(`the command palette did not open for ${text}`); }
	};
	const shot = async (label, clip) => {
		const res = await wb.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
		writeFileSync(path.join(out, `${theme}-cost-${label}.png`), Buffer.from(res.result.data, 'base64'));
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
	const sideState = () => inSide(`
		const lineOfEl = (el) => el.closest('.row')?.dataset.line;
		const count = (sel) => doc.querySelectorAll(sel).length;
		return {
			details: doc.querySelector('.details')?.className ?? null,
			marks: ['copy', 'move', 'conversion', 'lifetime', 'destructor', 'allocation', 'lookup', 'state'].map((c) => c + ':' + count('.ck.cc-' + c)).join(' '),
			nested: count('.ck .ck'),
			chips: [...doc.querySelectorAll('.cost-chip')].map((c) => lineOfEl(c) + ':' + c.textContent),
			// the chips outside of the visible area. On a long line, the chips are after the end of the code
			offscreenChips: (() => {
				const view = doc.querySelector('.scroller').getBoundingClientRect();
				return [...doc.querySelectorAll('.cost-chip')].filter((c) => {
					const r = c.getBoundingClientRect();
					return r.bottom > view.top && r.top < view.bottom && (r.left >= view.right || r.right <= view.left);
				}).length;
			})(),
			bar: doc.querySelector('.lensgroup[aria-label="Hidden C++"]')?.textContent,
			detailsText: doc.querySelector('.details')?.textContent.slice(0, 160),
		};`);
	// the webview is not in the DOM of the editor group, so the box is the content of the editor group at the right
	const sideBox = () => wb.evaluate(`(() => {
		const groups = [...document.querySelectorAll('.part.editor .editor-group-container .editor-container')]
			.map((g) => g.getBoundingClientRect()).filter((r) => r.width > 200);
		const r = groups.sort((a, b) => b.left - a.left)[0];
		return r && { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
	})()`);
	// scrolls the side view so that the line is the eighth visible line. The editor follows
	const scrollTo = async (line) => {
		await inSide(`const s = doc.querySelector('.scroller'); s.scrollTop = Math.max(0, ${line} - 8) * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
		await sleep(500);
	};
	const hover = (selector) => inSide(`const el = ${selector}; if (!el) { return false; } el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true;`);
	const unhover = (selector) => inSide(`const el = ${selector}; el?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); return true;`);
	const clickIn = (selector, label) => inSide(`[...doc.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))?.click(); return true;`);

	for (let i = 0; i < 60; i++) {
		if (await wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")')) { break; }
		await sleep(500);
	}
	await sleep(4000); // the start of the engine

	// the side view opens, and Hidden C++ is on. It is on by default, so a toggle would turn it off. The Explorer
	// closes, so the side view is wider
	await command('DataFlow: Open Side View');
	for (let i = 0; i < 40 && !side; i++) { side = await findSide(); if (!side) { await sleep(250); } }
	if (!side) { throw new Error('the side view was not found'); }
	for (let i = 0; i < 40; i++) {
		if (await inSide(`return !!doc.querySelector('.toolbar .lens');`)) { break; }
		await sleep(250);
	}
	if (await inSide(`return [...doc.querySelectorAll('.toolbar .lens')].find((b) => b.textContent.trim().startsWith('Hidden C++'))?.getAttribute('aria-pressed') !== 'true';`)) {
		await clickIn('.toolbar .lens', 'Hidden C++');
	}
	// Ctrl+B closes the Explorer, and Ctrl+Alt+B closes the secondary side bar, if they are open. The profile keeps their
	// state, and the command palette can select a different command
	const isVisible = (selector) => wb.evaluate(`(() => { const p = document.querySelector('${selector}'); return !!p && p.offsetWidth > 0; })()`);
	if (await isVisible('.part.sidebar')) {
		await focusEditor();
		await key('b', 'KeyB', 66, 2);
	}
	if (await isVisible('.part.auxiliarybar')) {
		await focusEditor();
		await key('b', 'KeyB', 66, 3);
	}
	for (let i = 0; i < 120; i++) {
		if (await inSide(`return doc.querySelectorAll('.code span[class^="t"]').length > 0 && doc.querySelectorAll('.ck').length > 0;`)) { break; }
		await sleep(250);
	}
	if (!await inSide(`return !!doc.querySelector('.details');`)) {
		await clickIn('.toolbar .lens', 'Details');
	}
	await sleep(1000);
	if (isCustom) {
		result.default = await sideState();
		await shot(path.basename(file).replace(/[^\w.-]/g, '-'));
		throw new Error('done');
	}

	// the marks and the chips of stable_readings
	await scrollTo(fnLine);
	result.default = await sideState();
	await shot('default');

	// a scroll to the right shows the chips after the long lines
	const copyRow = lineOf('MeterRead{state');
	await inSide(`const s = doc.querySelector('.scroller'); s.scrollLeft = s.scrollWidth; return true;`);
	await sleep(400);
	result.scrolled = await inSide(`
		const s = doc.querySelector('.scroller');
		const view = s.getBoundingClientRect();
		const r = doc.querySelector('.row[data-line="${copyRow}"] .cost-chip').getBoundingClientRect();
		return { scrollLeft: s.scrollLeft, scrollWidth: s.scrollWidth, isChipVisible: r.left >= view.left && r.right <= view.right };`);
	await shot('scrolled');
	await inSide(`const s = doc.querySelector('.scroller'); s.scrollLeft = 0; return true;`);
	await sleep(300);

	// the card of the lookups, with the connector of the group
	const lookupLine = lineOf('last_read.contains(tapTopic)');
	await hover(`doc.querySelector('.row[data-line="${lookupLine}"] .ck.cc-lookup')`);
	await sleep(600);
	result.lookup = await inSide(`return { card: doc.querySelector('.cost-card')?.textContent ?? null, connector: doc.querySelectorAll('.connector path').length };`);
	await shot('lookup');
	await unhover(`doc.querySelector('.row[data-line="${lookupLine}"] .ck.cc-lookup')`);
	await sleep(400);

	// the card of the chip of the copies on the line of MeterRead
	const copyLine = lineOf('MeterRead{state');
	await hover(`doc.querySelector('.row[data-line="${copyLine}"] .cost-chip.cc-copy')`);
	await sleep(600);
	result.chip = await inSide(`return [...doc.querySelectorAll('.cost-card .cost-text')].map((t) => t.textContent);`);
	await shot('chip');
	await unhover(`doc.querySelector('.row[data-line="${copyLine}"] .cost-chip.cc-copy')`);
	await sleep(400);

	// the switch of the copies turns them off, and on again
	await clickIn('.lensbar .cat', 'Copies');
	await sleep(1500);
	result.noCopies = await sideState();
	await shot('no-copies');
	await clickIn('.lensbar .cat', 'Copies');
	await sleep(1500);

	// "Not useful" in the details column hides the copies of GridStatus. "Show them again" shows them
	await inSide(`const item = [...doc.querySelectorAll('.details .cost-item')].find((i) => /GridStatus/.test(i.textContent)); item?.querySelector('button.small')?.click(); return true;`);
	await sleep(1500);
	result.notUseful = await sideState();
	await shot('not-useful');
	await clickIn('.lensbar button', '1 hidden pattern');
	await sleep(1500);
	result.shown = await sideState();

	// Flow Lens and Hidden C++ together: a click on tap_topics at the start of a line traces it. No chip and no details
	// column covers this name
	const traceLine = lineOf('tap_topics.reserve(');
	await inSide(`
		const row = doc.querySelector('.row[data-line="${traceLine}"]');
		const token = [...row.querySelectorAll('.code span')].find((s) => s.textContent === 'tap_topics');
		const r = token.getBoundingClientRect();
		token.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 3, clientY: r.top + r.height / 2 }));
		return true;`);
	await sleep(1800);
	result.both = {
		rails: await inSide(`return doc.querySelectorAll('.rail').length;`),
		marksInCost: await inSide(`return [...doc.querySelectorAll('[data-mark]')].filter((m) => m.closest('.ck')).length;`),
	};
	const box = await sideBox();
	await shot('both', box);

	result.dirty = await wb.evaluate(`!!document.querySelector('.tab.dirty')`);
	wb.ws.close();
	side.ws.close();
} catch (err) {
	if (String(err) !== 'Error: done') {
		result.error = String(err);
	}
} finally {
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
}
console.log(JSON.stringify(result, null, 2));
