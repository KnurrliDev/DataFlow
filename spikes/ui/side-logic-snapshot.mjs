// Logic Map in the side view on the CMake fixture: acceptance scenario 2 in process(). The script turns on Logic Map
// and makes screenshots of the default path, of the two parts of scenario 2 with the choices in the trail
// of the path panel, of the frames of "Play path", of the card of a line number, and of Flow Lens and Logic Map
// together. The Explorer closes, so the side view has space for the path panel.
// Usage: node spikes/ui/side-logic-snapshot.mjs <output folder> [dark|light|hc|hclight] [workspace folder file line]
// With a workspace, a file and a line, the script turns on Logic Map in the function of the line and makes one
// screenshot of the default path.
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
const port = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = path.join(out, `user-data-side-logic-${theme}`);
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

const fnLine = isCustom ? Number(lineArg) : lineOf('std::optional<Requests> process(tf::Executor');
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
		writeFileSync(path.join(out, `${theme}-logic-${label}.png`), Buffer.from(res.result.data, 'base64'));
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
		const details = doc.querySelector('.details');
		return {
			details: details && details.className,
			deadRows: doc.querySelectorAll('.row.dead').length,
			deadOpacity: (() => { const c = doc.querySelector('.row.dead .code'); return c && getComputedStyle(c).opacity; })(),
			events: [...doc.querySelectorAll('.lk-event')].map((e) => lineOfEl(e) + ':' + e.textContent),
			nulls: [...doc.querySelectorAll('.lk-null')].map((e) => lineOfEl(e) + ':' + e.textContent),
			hints: [...doc.querySelectorAll('.hint')].map((h) => lineOfEl(h) + ':' + h.textContent),
			bar: [...doc.querySelectorAll('.lensbar')].map((b) => b.textContent),
			summary: doc.querySelector('.summary')?.textContent,
			callouts: [...doc.querySelectorAll('.callout')].map((c) => c.textContent),
			trail: [...doc.querySelectorAll('.trail .step')].map((s) => s.className.replace('step ', '') + ' | ' + s.querySelector('.step-text')?.textContent + ' | ' + s.querySelector('.step-sub')?.textContent),
		};`);
	const playState = () => inSide(`return {
		current: doc.querySelector('.trail .step.current .step-text')?.textContent ?? null,
		rows: [...doc.querySelectorAll('.row.step')].map((r) => r.dataset.line),
		cursor: (() => { const c = doc.querySelector('.trail-cursor'); return c && c.style.top; })(),
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
	// sets the option of the decision on the line with its step in the trail of the path panel
	const choose = async (line, value) => {
		const ok = await inSide(`
			const step = doc.querySelector('.trail .step.k-decision[data-line="${line}"]');
			if (!step) { return false; }
			const select = step.querySelector('select');
			if (select) {
				select.value = ${JSON.stringify(value)};
				select.dispatchEvent(new Event('change', { bubbles: true }));
				return true;
			}
			const button = [...step.querySelectorAll('.seg button')].find((b) => b.textContent === ${JSON.stringify(value)});
			button?.click();
			return !!button;`);
		if (!ok) { throw new Error(`no step on line ${line} with the option ${value}`); }
		await sleep(500);
	};
	const clickIn = (selector, label) => inSide(`[...doc.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click(); return true;`);

	for (let i = 0; i < 60; i++) {
		if (await wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")')) { break; }
		await sleep(500);
	}
	await sleep(4000); // the start of the engine

	// the side view opens, and Logic Map is on: it is on by default, and the profile can keep it off. The Explorer
	// closes, so the side view is wider
	await command('DataFlow: Open Side View');
	for (let i = 0; i < 40 && !side; i++) { side = await findSide(); if (!side) { await sleep(250); } }
	if (!side) { throw new Error('the side view was not found'); }
	for (let i = 0; i < 40; i++) {
		if (await inSide(`return !!doc.querySelector('.toolbar .lens');`)) { break; }
		await sleep(250);
	}
	if (await inSide(`return [...doc.querySelectorAll('.toolbar .lens')].find((b) => b.textContent.trim().startsWith('Logic Map'))?.getAttribute('aria-pressed') !== 'true';`)) {
		await clickIn('.toolbar .lens', 'Logic Map');
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
		if (await inSide(`return doc.querySelectorAll('.code span[class^="t"]').length > 0 && !!doc.querySelector('.lensgroup[aria-label="Logic Map"]');`)) { break; }
		await sleep(250);
	}
	// the path panel is in the details column, in the tab of Logic Map. In a narrow side view, it is closed at the start
	if (!await inSide(`return !!doc.querySelector('.details');`)) {
		await clickIn('.toolbar .lens', 'Details');
	}
	for (let i = 0; i < 40; i++) {
		if (await inSide(`return [...doc.querySelectorAll('.details .tabs .tab')].some((t) => t.textContent.trim() === 'Logic Map');`)) { break; }
		await sleep(250);
	}
	await clickIn('.details .tabs .tab', 'Logic Map');
	for (let i = 0; i < 40; i++) {
		if (await inSide(`return doc.querySelectorAll('.trail .step').length > 0 || /No path/.test(doc.querySelector('.lensgroup[aria-label="Logic Map"]')?.textContent ?? '');`)) { break; }
		await sleep(250);
	}
	await sleep(800);
	if (isCustom) {
		result.default = await sideState();
		await shot(path.basename(file).replace(/[^\w.-]/g, '-'));
		throw new Error('done');
	}

	// the default path: past the early return, with the option that runs the most lines for each decision
	await scrollTo(fnLine);
	result.default = await sideState();
	await shot('default');

	// scenario 2, part 1: METER_READING, new readings found and the timeout
	const chainLine = lineOf('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)');
	const searching = lineOf('home_battery_ctl.state == HOMEPOWER_METER_READING');
	await choose(chainLine, 'HOMEPOWER_METER_READING');
	await choose(lineOf('if (data.size() > 0)', searching), 'yes');
	await choose(lineOf('if (home_battery_ctl.operational_mode == POWER_AUTO &&', searching), 'yes');
	await scrollTo(searching - 2);
	result.part1 = await sideState();
	await shot('part1');

	// frames of "Play path": the dot moves down the trail, and the code view marks the line of the step
	const box = await sideBox();
	await clickIn('.details .lens', '▶ Play path');
	result.play = [];
	for (let i = 0; i < 6; i++) {
		await sleep(i === 0 ? 150 : 650);
		result.play.push(await playState());
		await shot(`play-${i}`, box);
	}
	await sleep(6000);
	result.playEnd = await playState();

	// the card of a line number: why a line of another state runs
	const movedLine = lineOf('"_ended"');
	await scrollTo(movedLine - 4);
	await inSide(`doc.querySelector('.row[data-line="${movedLine}"] .ln').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true;`);
	await sleep(700);
	result.why = await inSide(`return doc.querySelector('.why-card')?.textContent ?? null;`);
	await shot('why');
	await inSide(`doc.querySelector('.row[data-line="${movedLine}"] .ln').dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); return true;`);
	await sleep(400);

	// scenario 2, part 2: CHARGE_PLANNING, converged and POWER_AUTO
	await clickIn('.lensbar button', 'Reset');
	await sleep(600);
	await choose(chainLine, 'HOMEPOWER_CHARGE_PLANNING');
	await choose(lineOf('if (home_battery_ctl.charging_future &&', chainLine), 'yes');
	await choose(lineOf('if (converged)', chainLine), 'yes');
	await choose(lineOf('if (home_battery_ctl.operational_mode == POWER_AUTO)', chainLine), 'yes');
	await scrollTo(chainLine);
	result.part2 = await sideState();
	await shot('part2');

	// Flow Lens and Logic Map together: a click on cur_tariff_plan traces it
	const curLine = lineOf('auto cur_tariff_plan = get_if(');
	await scrollTo(curLine);
	await inSide(`
		const row = doc.querySelector('.row[data-line="${curLine}"]');
		const token = [...row.querySelectorAll('.code span')].find((s) => s.textContent === 'cur_tariff_plan');
		const r = token.getBoundingClientRect();
		token.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 3, clientY: r.top + r.height / 2 }));
		return true;`);
	await sleep(1800);
	result.both = {
		rails: await inSide(`return doc.querySelectorAll('.rail').length;`),
		marks: await inSide(`return [...doc.querySelectorAll('[data-mark]')].map((m) => m.closest('.row').dataset.line + ':' + (m.closest('.lk') ? 'in box' : 'alone'));`),
		tabs: await inSide(`return [...doc.querySelectorAll('.tab')].map((t) => t.textContent + (t.getAttribute('aria-selected') === 'true' ? ' (selected)' : ''));`),
	};
	await shot('both');

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
