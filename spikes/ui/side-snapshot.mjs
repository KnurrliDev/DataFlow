// Opens a C++ file in the VS Code test build with DataFlow, opens the side view and takes screenshots. It scrolls the
// text editor and the side view, and writes the first visible line of each view after each scroll. For the file of the
// fixture, it also hides the text editor behind the Welcome page, clicks a line in the side view, and clicks the file
// name in the toolbar of the side view.
// Usage: node spikes/ui/side-snapshot.mjs <output folder> [dark|light|hc|hclight] [workspace folder] [file] [line]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const [outArg, theme = 'dark', workspaceArg, fileArg, lineArg = '1'] = process.argv.slice(2);
const out = path.resolve(outArg);
const workspace = path.resolve(workspaceArg ?? path.join(repo, 'test', 'fixtures', 'battery'));
const file = path.resolve(fileArg ?? path.join(workspace, 'src', 'battery.cpp'));
const themes = { dark: 'Dark Modern', light: 'Light Modern', hc: 'Default High Contrast', hclight: 'Default High Contrast Light' };
const build = readdirSync(path.join(repo, '.vscode-test')).find((d) => d.startsWith('vscode-win32-x64-archive'));
const port = 9340;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = path.basename(file).replace(/\W/g, '-');

const userData = path.join(out, `user-data-side-${theme}`);
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

const proc = spawn(path.join(repo, '.vscode-test', build, 'Code.exe'), [
	`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`,
	`--extensions-dir=${path.join(out, 'extensions')}`, `--remote-debugging-port=${port}`,
	'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
	'--goto', `${file}:${lineArg}:1`,
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

const result = { pid: proc.pid, theme, file };
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
	const command = async (text) => {
		await focusEditor();
		await key('P', 'KeyP', 80, 10); // ctrl+shift+p
		if (!await quickInput(text)) { throw new Error(`the command palette did not open for ${text}`); }
	};
	const shot = async (label) => {
		const res = await wb.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(path.join(out, `${theme}-${name}-${label}.png`), Buffer.from(res.result.data, 'base64'));
	};
	// the first visible line of the text editor: the line number at the top of the editor
	const editorFirstLine = () => wb.evaluate(`(() => {
		const ed = document.querySelector('.part.editor .monaco-editor');
		const top = ed.querySelector('.lines-content').getBoundingClientRect().top;
		const rows = [...ed.querySelectorAll('.margin-view-overlays .line-numbers')].map((n) => ({ n: Number(n.textContent), y: n.parentElement.getBoundingClientRect().top }));
		const view = ed.querySelector('.monaco-scrollable-element').getBoundingClientRect().top;
		const visible = rows.filter((r) => r.y >= view - 2).sort((a, b) => a.y - b.y);
		return visible[0]?.n;
	})()`);

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
	const sideFirstLine = () => inSide(`const s = doc.querySelector('.scroller'); const h = parseFloat(s.style.getPropertyValue('--row-height')); return Math.round(s.scrollTop / h) + 1;`);

	for (let i = 0; i < 60; i++) {
		if (await wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")')) { break; }
		await sleep(500);
	}
	await sleep(4000); // the start of the engine
	await command('DataFlow: Open Side View');
	for (let i = 0; i < 40 && !side; i++) { side = await findSide(); if (!side) { await sleep(250); } }
	if (!side) { throw new Error('the side view was not found'); }
	// wait for the tokens of the engine
	for (let i = 0; i < 120; i++) {
		if (await inSide(`return doc.querySelectorAll('.code span[class^="t"]').length;`)) { break; }
		await sleep(250);
	}
	await sleep(800);
	result.spans = await inSide(`return doc.querySelectorAll('.code span[class^="t"]').length;`);
	result.status = await inSide(`return doc.querySelector('.status').textContent;`);
	result.toolbar = await inSide(`return doc.querySelector('.toolbar').textContent;`);
	// each button of the toolbar is in the visible part of the toolbar, also in a narrow side view
	result.toolbarButtons = await inSide(`const bar = doc.querySelector('.toolbar').getBoundingClientRect();
		return [...doc.querySelectorAll('.toolbar button')].map((b) => {
			const r = b.getBoundingClientRect();
			return { text: b.textContent.trim(), isVisible: r.left >= bar.left && r.right <= bar.right && r.top >= bar.top && r.bottom <= bar.bottom };
		});`);
	result.themeVariables = await inSide(`return [...doc.documentElement.style].filter((n) => /BracketHighlight|IndentGuide/.test(n))
		.map((n) => n + ': ' + doc.documentElement.style.getPropertyValue(n));`);
	result.guides = await inSide(`return doc.querySelectorAll('.guide').length + ' guides, ' + doc.querySelectorAll('.guide.active').length + ' active';`);
	result.start = { editor: await editorFirstLine(), side: await sideFirstLine() };
	await shot('open');

	// scroll the text editor with the mouse wheel
	const box = await editorBox();
	for (let i = 0; i < 6; i++) {
		await wb.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 120 });
		await sleep(60);
	}
	await sleep(600);
	result.afterEditorScroll = { editor: await editorFirstLine(), side: await sideFirstLine() };
	await shot('editor-scrolled');

	// scroll the side view
	await inSide(`const s = doc.querySelector('.scroller'); s.scrollTop += 37 * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
	await sleep(800);
	result.afterSideScroll = { editor: await editorFirstLine(), side: await sideFirstLine() };
	await shot('side-scrolled');

	// With no text editor: the Welcome page hides the C++ editor, as the panel of Claude Code does. A click on the name of
	// a called function in process() moves the cursor of the side view, and the function in the toolbar follows it. The
	// button of the file name then opens the text editor at the line of the click
	if (!fileArg) {
		const line = readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('fire_transition(home_battery_ctl, "", true);')) + 1;
		const activeTab = () => wb.evaluate(`document.querySelector('.part.editor .tab.active .label-name')?.textContent ?? ''`);
		await command('Help: Welcome');
		await sleep(1500);
		result.noEditor = { line, tab: await activeTab(), fnBefore: await inSide(`return doc.querySelector('.toolbar .fn')?.textContent ?? '';`) };
		await inSide(`const s = doc.querySelector('.scroller'); s.scrollTop = ${line - 10} * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
		await sleep(800);
		await inSide(`const span = [...doc.querySelectorAll('.rows > .row[data-line="${line}"] .code span')].find((s) => s.textContent === 'fire_transition');
			const r = span.getBoundingClientRect();
			span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 2, clientY: r.top + r.height / 2 }));
			return true;`);
		await sleep(1500);
		result.noEditor.cursor = await inSide(`return Number(doc.querySelector('.rows > .row.cursor')?.dataset.line ?? 0);`);
		result.noEditor.fn = await inSide(`return doc.querySelector('.toolbar .fn')?.textContent ?? '';`);
		await shot('no-editor');
		await inSide(`doc.querySelector('.toolbar button.file').click(); return true;`);
		await sleep(1500);
		result.noEditor.after = {
			tab: await activeTab(),
			status: await wb.evaluate(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`),
		};
		await shot('editor-opened');
	}

	// A right-click on a call of fire_transition: the menu of VS Code has Show Calls, and the list shows the calls. A click
	// on a call moves the text editor to the call, and Escape closes the list
	if (!fileArg) {
		const line = readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('fire_transition(home_battery_ctl, "", true);')) + 1;
		await inSide(`doc.querySelector('.scroller').scrollLeft = 0; doc.querySelector('.rows > .row[data-line="${line}"]')?.scrollIntoView({ block: 'center' }); return true;`);
		await sleep(500);
		await inSide(`const span = [...doc.querySelectorAll('.rows > .row[data-line="${line}"] .code span')].find((s) => s.textContent === 'fire_transition');
			const r = span.getBoundingClientRect();
			span.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
			return true;`);
		await sleep(1000);
		const item = await wb.evaluate(`(() => {
			const items = [...document.querySelectorAll('.monaco-menu .action-item')];
			const item = items.find((i) => i.textContent.trim().startsWith('Show Calls'));
			if (!item) { return { labels: items.map((i) => i.textContent.trim()) }; }
			const r = item.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		})()`);
		result.calls = { menu: item.labels ?? 'Show Calls' };
		if (item.x !== undefined) {
			for (const type of ['mousePressed', 'mouseReleased']) {
				await wb.send('Input.dispatchMouseEvent', { type, x: item.x, y: item.y, button: 'left', clickCount: 1 });
			}
			await sleep(2500);
			result.calls.list = await inSide(`const list = doc.querySelector('.call-list');
				return list ? { title: list.querySelector('.call-list-title')?.textContent, items: list.querySelectorAll('.call-item').length,
					files: [...list.querySelectorAll('.call-list-file')].map((f) => f.textContent) } : null;`);
			await shot('calls');
			result.calls.target = await inSide(`const items = [...doc.querySelectorAll('.call-list .call-item')];
				const last = items[items.length - 1];
				last.click();
				return Number(last.querySelector('.call-line').textContent);`);
			await sleep(1000);
			result.calls.status = await wb.evaluate(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`);
			result.calls.isOpen = await inSide(`return !!doc.querySelector('.call-list');`);
			await inSide(`doc.defaultView.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
			await sleep(400);
			result.calls.afterEscape = await inSide(`return !!doc.querySelector('.call-list');`);
		}
	}

	// Ctrl+click: with Ctrl down, the name under the mouse gets the underline of a link. Ctrl+click on HomeBatteryCtrl goes
	// to its header in the side view only, so the cursor of the text editor stays. The mouse button Back comes back
	if (!fileArg) {
		const line = readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('std::optional<Requests> process(')) + 1;
		const header = path.join(workspace, 'include', 'battery', 'types.hpp');
		const declLine = readFileSync(header, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('struct HomeBatteryCtrl {')) + 1;
		const mod = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey';
		const status = () => wb.evaluate(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`);
		const sideFile = () => inSide(`return doc.querySelector('.toolbar .file')?.textContent ?? '';`);
		// the side view makes only the rows near the visible part
		await inSide(`const s = doc.querySelector('.scroller'); s.scrollLeft = 0; s.scrollTop = ${line - 10} * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
		await sleep(800);
		result.goto = { line, declLine, statusBefore: await status() };
		const name = `[...doc.querySelectorAll('.rows > .row[data-line="${line}"] .code span')].find((s) => s.textContent === 'HomeBatteryCtrl')`;
		const mouse = (type, extra) => inSide(`const span = ${name}; const r = span.getBoundingClientRect();
			span.dispatchEvent(new MouseEvent('${type}', { bubbles: true, cancelable: true, button: 0, clientX: r.left + 4, clientY: r.top + r.height / 2, ${extra} }));
			return true;`);
		await mouse('mousemove', `${mod}: true`);
		result.goto.hover = await inSide(`const span = ${name}; const style = getComputedStyle(span);
			return { isLink: span.classList.contains('goto-link'), decoration: style.textDecorationLine, cursor: style.cursor };`);
		await shot('goto-hover');
		await inSide(`doc.defaultView.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true })); return true;`);
		result.goto.afterKeyUp = await inSide(`return ${name}.classList.contains('goto-link');`);
		await mouse('mousedown', `${mod}: true`);
		await mouse('mouseup', `${mod}: true`);
		for (let i = 0; i < 40 && await sideFile() !== 'types.hpp'; i++) {
			await sleep(250);
		}
		await sleep(500);
		result.goto.file = await sideFile();
		result.goto.cursor = await inSide(`return Number(doc.querySelector('.rows > .row.cursor')?.dataset.line ?? 0);`);
		result.goto.statusAfter = await status();
		await shot('goto-header');
		await inSide(`doc.querySelector('.scroller').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 3 })); return true;`);
		for (let i = 0; i < 40 && await sideFile() !== 'battery.cpp'; i++) {
			await sleep(250);
		}
		result.goto.back = await sideFile();

		// A right-click on HomeBatteryCtrl: the menu of VS Code has Outline, and the panel shows the members with the layout.
		// The filter keeps the members with "charg". A click on a member moves the side view, and Escape closes the panel
		await inSide(`const s = doc.querySelector('.scroller'); s.scrollLeft = 0; s.scrollTop = ${line - 10} * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
		await sleep(800);
		await inSide(`const span = ${name}; const r = span.getBoundingClientRect();
			span.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
			return true;`);
		await sleep(1000);
		const item = await wb.evaluate(`(() => {
			const items = [...document.querySelectorAll('.monaco-menu .action-item')];
			const item = items.find((i) => i.textContent.trim() === 'Outline');
			if (!item) { return { labels: items.map((i) => i.textContent.trim()) }; }
			const r = item.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		})()`);
		result.outline = { menu: item.labels ?? 'Outline' };
		if (item.x !== undefined) {
			for (const type of ['mousePressed', 'mouseReleased']) {
				await wb.send('Input.dispatchMouseEvent', { type, x: item.x, y: item.y, button: 'left', clickCount: 1 });
			}
			for (let i = 0; i < 40 && !await inSide(`return !!doc.querySelector('.outline-panel');`); i++) {
				await sleep(250);
			}
			await sleep(400);
			const panel = () => inSide(`const p = doc.querySelector('.outline-panel'); if (!p) { return null; }
				return { title: p.querySelector('.ol-title')?.textContent, layout: p.querySelector('.ol-layout span')?.textContent ?? '',
					hasBar: !!p.querySelector('.ol-bar'), groups: [...p.querySelectorAll('.ol-group-head')].map((g) => g.textContent),
					items: p.querySelectorAll('.ol-item').length };`);
			result.outline.panel = await panel();
			await shot('outline');
			await inSide(`const f = doc.querySelector('.outline-panel .ol-filter'); f.value = 'charg'; f.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
			await sleep(400);
			result.outline.filtered = await inSide(`return [...doc.querySelectorAll('.outline-panel .ol-item .ol-label')].map((l) => l.textContent);`);
			await inSide(`doc.querySelector('.outline-panel .ol-item').click(); return true;`);
			for (let i = 0; i < 40 && await sideFile() !== 'types.hpp'; i++) {
				await sleep(250);
			}
			result.outline.file = await sideFile();
			result.outline.isOpen = await inSide(`return !!doc.querySelector('.outline-panel');`);
			await inSide(`doc.defaultView.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
			await sleep(400);
			result.outline.afterEscape = await inSide(`return !!doc.querySelector('.outline-panel');`);
			await inSide(`doc.querySelector('.scroller').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 3 })); return true;`);
			for (let i = 0; i < 40 && await sideFile() !== 'battery.cpp'; i++) {
				await sleep(250);
			}
			result.outline.back = await sideFile();
		}
	}

	result.dirty = await wb.evaluate(`!!document.querySelector('.tab.dirty')`);
	side.ws.close();

	// the serializer restores the side view after a reload of the window
	await command('Developer: Reload Window');
	wb.ws.close();
	side = undefined;
	await sleep(3000);
	for (let i = 0; i < 80 && !side; i++) {
		try { side = await findSide(); } catch { /* the window starts again */ }
		if (!side) { await sleep(500); }
	}
	if (!side) { throw new Error('the side view did not come back after the reload'); }
	for (let i = 0; i < 120; i++) {
		if (await inSide(`return doc.querySelectorAll('.code span[class^="t"]').length;`)) { break; }
		await sleep(250);
	}
	result.afterReload = await inSide(`return doc.querySelector('.toolbar .file')?.textContent + ', ' + doc.querySelectorAll('.code span[class^="t"]').length + ' spans';`);
	const page2 = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('workbench'));
	const wb2 = await connect(page2.webSocketDebuggerUrl);
	const res = await wb2.send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(path.join(out, `${theme}-${name}-reloaded.png`), Buffer.from(res.result.data, 'base64'));
	wb2.ws.close();
	side.ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
}
console.log(JSON.stringify(result, null, 2));
