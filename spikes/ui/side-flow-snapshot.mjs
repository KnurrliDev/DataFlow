// Flow Lens in the side view on the CMake fixture: acceptance scenario 1 with bestFit in initial_power(). The script
// traces bestFit, takes frames of the pulse, shows the hover card of the finding, and traces startPlans with a click in
// the side view. Then it opens the details column.
// Usage: node spikes/ui/side-flow-snapshot.mjs <output folder> [dark|light|hc|hclight] [workspace folder file line:col]
// With a workspace, a file and a position, the script traces the variable at the position and takes one screenshot.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const [outArg, theme = 'dark', workspaceArg, fileArg, positionArg] = process.argv.slice(2);
const out = path.resolve(outArg);
const workspace = path.resolve(workspaceArg ?? path.join(repo, 'test', 'fixtures', 'battery'));
const file = path.resolve(fileArg ?? path.join(workspace, 'src', 'battery.cpp'));
const isCustom = !!positionArg;
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
const themes = { dark: 'Dark Modern', light: 'Light Modern', hc: 'Default High Contrast', hclight: 'Default High Contrast Light' };
const build = readdirSync(path.join(repo, '.vscode-test')).find((d) => d.startsWith('vscode-win32-x64-archive'));
const port = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = path.join(out, `user-data-side-flow-${theme}`);
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

const [declLine, declCol] = isCustom ? positionArg.split(':').map(Number) : [lineOf('auto bestFit = best_preset('), 12];
const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`,
	`--extensions-dir=${path.join(out, 'extensions')}`, `--remote-debugging-port=${port}`,
	'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${declLine}:${declCol}`,
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
				await sleep(500);
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
	const goToLine = async (target) => {
		await focusEditor();
		await key('g', 'KeyG', 71, 2); // ctrl+g
		if (!await quickInput(target)) { throw new Error('the go to line box did not open'); }
	};
	const shot = async (label, clip) => {
		const res = await wb.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
		writeFileSync(path.join(out, `${theme}-flow-${label}.png`), Buffer.from(res.result.data, 'base64'));
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
	const sideState = () => inSide(`return {
		lanes: doc.querySelectorAll('.row .lane').length,
		rails: doc.querySelectorAll('.rail').length,
		dashed: doc.querySelectorAll('.rail.dashed').length,
		marks: [...doc.querySelectorAll('[data-mark]')].map((m) => m.closest('.row').dataset.line + ':' + m.className.replace(/t\\d+ /, '')),
		guides: doc.querySelectorAll('.mk.lead').length,
		hooks: doc.querySelectorAll('.hook').length,
		dim: doc.querySelectorAll('.row.dim').length,
		dimOpacity: (() => { const c = doc.querySelector('.row.dim .code'); return c && getComputedStyle(c).opacity; })(),
		hints: [...doc.querySelectorAll('.hint')].map((h) => h.closest('.row').dataset.line + ':' + h.textContent),
		bar: doc.querySelector('.lensgroup[aria-label="Flow Lens"]')?.textContent,
		details: doc.querySelector('.details')?.textContent.slice(0, 160),
	};`);
	// the webview is not in the DOM of the editor group, so the box is the content of the editor group at the right
	const sideBox = () => wb.evaluate(`(() => {
		const groups = [...document.querySelectorAll('.part.editor .editor-group-container .editor-container')]
			.map((g) => g.getBoundingClientRect()).filter((r) => r.width > 200);
		const r = groups.sort((a, b) => b.left - a.left)[0];
		return r && { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
	})()`);

	for (let i = 0; i < 60; i++) {
		if (await wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")')) { break; }
		await sleep(500);
	}
	await sleep(4000); // the start of the engine

	// scenario 1: trace bestFit. The side view opens with the trace
	await goToLine(`${declLine}:${declCol}`);
	await command('DataFlow: Trace Variable');
	for (let i = 0; i < 40 && !side; i++) { side = await findSide(); if (!side) { await sleep(250); } }
	if (!side) { throw new Error('the side view was not found'); }
	for (let i = 0; i < 120; i++) {
		if (await inSide(`return doc.querySelectorAll('.code span[class^="t"]').length > 0 && doc.querySelectorAll('.rail').length > 0;`)) { break; }
		await sleep(250);
	}
	if (isCustom) {
		await sleep(1500);
		result.trace = await sideState();
		await shot(path.basename(file).replace(/[^\w.-]/g, '-'));
		// the card of the first dot at the end of a long line
		if (await inSide(`const m = doc.querySelector('.end-mark'); m?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return !!m;`)) {
			await sleep(400);
			result.endsCard = await inSide(`return doc.querySelector('.ends-card')?.textContent;`);
			await shot(`${path.basename(file).replace(/[^\w.-]/g, '-')}-dot`);
		}
		throw new Error('done');
	}

	// frames of the pulse after a new trace of the same variable
	await inSide(`[...doc.querySelectorAll('.var')].find((b) => b.textContent === 'usePreset')?.click(); return true;`);
	await sleep(1200);
	await inSide(`[...doc.querySelectorAll('.var')].find((b) => b.textContent === 'bestFit')?.click(); return true;`);
	const box = await sideBox();
	for (let i = 0; i < 6; i++) {
		await shot(`pulse-${i}`, box);
		await sleep(110);
	}
	await sleep(1200);
	result.bestFit = await sideState();
	result.editorDecorations = await wb.evaluate(`document.querySelectorAll('.part.editor .monaco-editor .cgmr, .part.editor .monaco-editor [class*="ced-"]').length`);
	await shot('trace');

	// the hover card and the curve of a read. The finding on line 46 is outside of the view, at the end of a long line
	const readLine = lineOf('{std::format("preset');
	await inSide(`const m = doc.querySelector('.row[data-line="${readLine}"] [data-mark]'); m.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true;`);
	await sleep(600);
	result.card = await inSide(`return doc.querySelector('.card')?.textContent;`);
	result.curves = await inSide(`return doc.querySelectorAll('.curve').length;`);
	result.laneCurves = await inSide(`return doc.querySelectorAll('.curve.lane').length;`);
	await shot('hover');
	await inSide(`const m = doc.querySelector('.row[data-line="${readLine}"] [data-mark]'); m.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); return true;`);

	// a click on startPlans in the side view traces it
	const candidatesLine = lineOf('std::vector<StartPlan> startPlans;');
	await inSide(`
		const row = doc.querySelector('.row[data-line="${candidatesLine}"]');
		const token = [...row.querySelectorAll('.code span')].find((s) => s.textContent === 'startPlans');
		const r = token.getBoundingClientRect();
		token.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 3, clientY: r.top + r.height / 2 }));
		return true;`);
	await sleep(1500);
	result.startPlans = await sideState();
	await shot('startPlans');

	// the Details button. In a narrow side view, the details column shows over the code. Escape closes it
	const detailsButton = `[...doc.querySelectorAll('.toolbar .lens')].find((b) => b.textContent.trim() === 'Details')`;
	result.detailsBefore = await inSide(`return doc.querySelector('.details')?.className ?? null;`);
	if (!result.detailsBefore) {
		await inSide(`${detailsButton}.click(); return true;`);
		await sleep(600);
	}
	result.details = await inSide(`const d = doc.querySelector('.details'); return d && { className: d.className, width: d.getBoundingClientRect().width, text: d.textContent.slice(0, 120) };`);
	await shot('details');
	if (!result.detailsBefore) {
		// the code of the side view is in the inner frame, so the key event goes to the window of that frame
		await inSide(`doc.defaultView.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
		await sleep(300);
		result.detailsAfterEscape = await inSide(`return doc.querySelector('.details')?.className ?? null;`);
	}

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
