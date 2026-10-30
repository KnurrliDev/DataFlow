// Takes the screenshots of the documentation: the side view with each lens and with each view tool of the MCP server.
// The script starts the test build of VS Code on the fixture projects, works in the side view through the remote
// debugging protocol, and saves the screenshots as PNG files. The window shows no side bar, no panel, no chat, no
// notifications and no hovers of VS Code. Before each screenshot, the script blurs each text that looks like a path or a
// personal name, and it writes these texts to the output.
// Run "npm run compile" and "node scripts/prepare-fixtures.mjs" first. Do not use the mouse or the keyboard while the
// script runs.
// Usage: node scripts/docs-screenshots.mjs [output folder] [names of the screenshots]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const [outArg, ...only] = process.argv.slice(2);
const out = path.resolve(outArg ?? path.join(repo, 'docs', 'images'));
const temp = mkdtempSync(path.join(os.tmpdir(), 'dataflow-shots-'));
const port = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWanted = (...names) => only.length === 0 || names.some((n) => only.includes(n));

// the newest test build of VS Code
const version = (d) => d.replace(/^\D+/, '').split('.').map(Number);
const build = readdirSync(path.join(repo, '.vscode-test')).filter((d) => d.startsWith('vscode-win32-x64-archive'))
	.sort((a, b) => { const [x, y] = [version(a), version(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).at(-1);
const codeExe = path.join(repo, '.vscode-test', build, 'Code.exe');

// the size of the window in CSS pixels, the scale of the screenshots, and the width of the text editor
const VIEW = { width: 1600, height: 900, deviceScaleFactor: 1 };
const EDITOR_WIDTH = 600;

// a clean window: no title bar in the page, no activity bar, no breadcrumbs with the path, no chat, no tips
const SETTINGS = {
	'workbench.colorTheme': 'Dark Modern',
	'workbench.startupEditor': 'none',
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'workbench.activityBar.location': 'hidden',
	'workbench.layoutControl.enabled': false,
	'workbench.tips.enabled': false,
	'workbench.enableExperiments': false,
	'window.titleBarStyle': 'native',
	'window.menuBarVisibility': 'hidden',
	'window.commandCenter': false,
	'window.zoomLevel': 0,
	'breadcrumbs.enabled': false,
	'chat.disableAIFeatures': true,
	'chat.commandCenter.enabled': false,
	'extensions.ignoreRecommendations': true,
	'git.openRepositoryInParentFolders': 'never',
	'editor.minimap.enabled': false,
	'editor.stickyScroll.enabled': false,
	'editor.hover.enabled': false,
	'update.mode': 'none',
	'telemetry.telemetryLevel': 'off',
	'security.workspace.trust.enabled': false,
};

// The texts that a screenshot must not show: absolute paths and the names of the user. The names come from the system and
// from git when the script runs, so the script itself contains no name
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userNames = new Set([os.userInfo().username, path.basename(os.homedir())]);
try {
	userNames.add(execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim());
} catch { /* no global name */ }
const PRIVATE = [String.raw`(^|[^\w])[A-Za-z]:[\\/]`, String.raw`[\\/]Users[\\/]`, 'AppData', ...[...userNames].filter((n) => n.length > 2).map(escapeRe)].join('|');

// The function runs in a document, blurs the elements of the private texts and gives these texts
const COVER = String.raw`(doc, source) => {
	const re = new RegExp(source, 'i');
	const found = [];
	const view = doc.defaultView;
	const walker = doc.createTreeWalker(doc.body, view.NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (!re.test(n.textContent)) { continue; }
		const el = n.parentElement;
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < view.innerWidth && r.top < view.innerHeight) {
			el.style.filter = 'blur(6px)';
			found.push(n.textContent.trim().slice(0, 100));
		}
	}
	return found;
}`;

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
	const evaluate = async (expression) => {
		const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
		if (reply.result?.exceptionDetails) {
			throw new Error(`script error: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
		}
		return reply.result?.result?.value;
	};
	return { ws, send, evaluate };
}

// Starts VS Code on a workspace, gives the helpers to the steps, and stops VS Code after the steps
async function session(name, workspace, file, line, settings, steps) {
	const userData = path.join(temp, `user-${name}`);
	mkdirSync(path.join(userData, 'User'), { recursive: true });
	writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ ...SETTINGS, ...settings }));
	const registry = path.join(temp, `mcp-${name}`);
	const proc = spawn(codeExe, [
		`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`, `--extensions-dir=${path.join(temp, 'extensions')}`,
		`--remote-debugging-port=${port}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
		workspace, '--goto', `${file}:${line}:1`,
	], {
		stdio: 'ignore',
		// the MCP registry and the settings of Claude Code of the window are in the temporary folder, not in the home folder
		env: { ...process.env, DATAFLOW_MCP_REGISTRY: registry, CLAUDE_CONFIG_DIR: path.join(temp, `claude-${name}`) },
	});
	try {
		let page;
		for (let i = 0; i < 120 && !page; i++) {
			try {
				page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('workbench'));
			} catch { /* not ready */ }
			if (!page) { await sleep(500); }
		}
		if (!page) { throw new Error('VS Code did not start'); }
		const wb = await connect(page.webSocketDebuggerUrl);
		await wb.send('Emulation.setDeviceMetricsOverride', { ...VIEW, mobile: false });
		const key = async (k, code, vk, modifiers = 0) => {
			await wb.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
			await wb.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
		};
		const mouse = (type, x, y, extra = {}) => wb.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
		const click = async (x, y) => {
			await mouse('mouseMoved', x, y);
			await mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
			await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
		};
		// a click on the tab of the text editor gives the focus to the editor and does not move the cursor
		const focusEditor = async () => {
			const tab = await wb.evaluate(`(() => { const t = [...document.querySelectorAll('.part.editor .tab')].find((x) => /\\.(cpp|hpp|h)$/.test(x.querySelector('.label-name')?.textContent ?? ''));
				const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
			await click(tab.x, tab.y);
			await sleep(300);
		};
		// the quick input with the focus, then the text. Enter only if the first item is the expected item
		const quickInput = async (text, expected) => {
			for (let i = 0; i < 25; i++) {
				if (await wb.evaluate(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none' && w.contains(document.activeElement); })()`)) {
					await wb.send('Input.insertText', { text });
					await sleep(600);
					if (expected) {
						const first = await wb.evaluate(`document.querySelector('.quick-input-list .monaco-list-row.focused')?.getAttribute('aria-label') ?? ''`);
						if (!first.toLowerCase().includes(expected.toLowerCase())) {
							await key('Escape', 'Escape', 27);
							throw new Error(`the command palette shows "${first}" for "${text}"`);
						}
					}
					await key('Enter', 'Enter', 13);
					await sleep(400);
					return;
				}
				await sleep(200);
			}
			throw new Error(`the quick input did not open for "${text}"`);
		};
		const command = async (title) => {
			await focusEditor();
			await key('P', 'KeyP', 80, 10); // ctrl+shift+p
			await quickInput(title, title);
		};
		const goToLine = async (target) => {
			await focusEditor();
			await key('g', 'KeyG', 71, 2); // ctrl+g
			await quickInput(target);
		};
		const until = async (check, what, tries = 80) => {
			for (let i = 0; i < tries; i++) {
				if (await check()) { return; }
				await sleep(250);
			}
			throw new Error(`no ${what}`);
		};

		// the side view is a webview in its own target. Its code runs in the frame "active-frame"
		let side;
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
		const SIDE_DOC = `(document.querySelector('iframe#active-frame')?.contentDocument ?? document)`;
		const inSide = (code) => side.evaluate(`(() => { const doc = ${SIDE_DOC}; ${code} })()`);
		const openSide = async (title) => {
			await command(title);
			for (let i = 0; i < 60 && !side; i++) { side = await findSide(); if (!side) { await sleep(250); } }
			if (!side) { throw new Error('the side view was not found'); }
			await until(() => inSide(`return doc.querySelectorAll('.code span[class^="t"]').length > 0 || doc.querySelectorAll('.scard').length > 0;`), 'code in the side view', 160);
		};
		// the sash between the two editor groups goes to x
		const splitAt = async (x) => {
			const sash = await wb.evaluate(`(() => { const r = [...document.querySelectorAll('.part.editor .monaco-sash.vertical')].map((e) => e.getBoundingClientRect())
				.find((b) => b.height > 200 && b.left > 100); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
			if (!sash) { throw new Error('no sash between the editor groups'); }
			await mouse('mouseMoved', sash.x, sash.y);
			await mouse('mousePressed', sash.x, sash.y, { button: 'left', clickCount: 1 });
			for (let i = 1; i <= 12; i++) {
				await mouse('mouseMoved', sash.x + ((x - sash.x) * i) / 12, sash.y, { button: 'left', buttons: 1 });
				await sleep(30);
			}
			await mouse('mouseReleased', x, sash.y, { button: 'left', clickCount: 1 });
			await sleep(800);
		};
		// the box of the editor group at the right, in the coordinates of the page
		const sideBox = () => wb.evaluate(`(() => {
			const groups = [...document.querySelectorAll('.part.editor .editor-group-container')].map((g) => g.getBoundingClientRect()).filter((r) => r.width > 200);
			const r = groups.sort((a, b) => b.left - a.left)[0];
			return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scale: 1 };
		})()`);
		// the switches of the lenses in the toolbar of the side view. Flow Lens and Change Ripple do not change
		const setLenses = async (on) => {
			for (const lens of ['Logic Map', 'Hidden C++', 'Includes', 'Calls', 'Threads']) {
				const pressed = await inSide(`const b = [...doc.querySelectorAll('.toolbar button.lens')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(lens)}));
					return b ? b.getAttribute('aria-pressed') : null;`);
				if (pressed !== null && (pressed === 'true') !== on.includes(lens)) {
					await inSide(`[...doc.querySelectorAll('.toolbar button.lens')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(lens)})).click(); return true;`);
					await sleep(700);
				}
			}
		};
		// the details column with a tab, or no details column
		const details = async (tab) => {
			const isOpen = await inSide(`return !!doc.querySelector('.details');`);
			if (isOpen !== !!tab) {
				await inSide(`[...doc.querySelectorAll('.toolbar button.lens')].find((x) => x.textContent.trim() === 'Details').click(); return true;`);
				await sleep(700);
			}
			// with one lens, the details column has no tabs
			if (tab) {
				const find = `const tabs = [...doc.querySelectorAll('.details .tabs .tab')]; const t = tabs.find((x) => x.textContent.trim() === ${JSON.stringify(tab)});`;
				try {
					await until(() => inSide(`${find} return !!t || (tabs.length === 0 && !!doc.querySelector('.details'));`), `tab ${tab}`, 40);
				} catch (err) {
					throw new Error(`${err.message}: ${await inSide(`return [...doc.querySelectorAll('.details .tabs .tab')].map((x) => x.textContent.trim()).join(', ');`)}`);
				}
				await inSide(`${find} t?.click(); return true;`);
				await sleep(800);
			}
		};
		// the side view scrolls so that the line is the first visible line. The text editor follows
		const scrollSide = async (line) => {
			await inSide(`const s = doc.querySelector('.scroller'); s.scrollLeft = 0; s.scrollTop = ${line - 1} * parseFloat(s.style.getPropertyValue('--row-height')); return true;`);
			await sleep(800);
		};
		const row = (line) => `doc.querySelector('.rows > .row[data-line="${line}"]')`;
		const token = (line, text) => `[...${row(line)}.querySelectorAll('.code span')].find((s) => s.textContent === ${JSON.stringify(text)})`;
		// a click on a name in the side view moves the cursor there
		const clickToken = (line, text) => inSide(`const t = ${token(line, text)}; const r = t.getBoundingClientRect();
			t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 2, clientY: r.top + r.height / 2 })); return true;`);
		const hover = (selector) => inSide(`const el = ${selector}; if (!el) { return false; } const r = el.getBoundingClientRect();
			el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + 2, clientY: r.top + r.height / 2 })); return true;`);
		const unhover = (selector) => inSide(`const el = ${selector}; el?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); return true;`);
		const clickIn = (selector, label) => inSide(`const b = [...doc.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}));
			b?.click(); return !!b;`);
		// no notifications and no hovers of VS Code. Then the texts of paths get a blur, and the screenshot gets the file name
		const shot = async (label, clip) => {
			await wb.evaluate(`document.querySelectorAll('.notifications-toasts .notification-toast-container, .notifications-center').forEach((t) => t.remove())`);
			await sleep(300);
			const covered = [
				...await wb.evaluate(`(${COVER})(document, ${JSON.stringify(PRIVATE)})`),
				...(side ? await side.evaluate(`(${COVER})(${SIDE_DOC}, ${JSON.stringify(PRIVATE)})`) : []),
			];
			const res = await wb.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
			mkdirSync(out, { recursive: true });
			writeFileSync(path.join(out, `${label}.png`), Buffer.from(res.result.data, 'base64'));
			console.log(`${label}.png${covered.length ? `: covered ${JSON.stringify(covered)}` : ''}`);
		};
		// the MCP server of the window: the connection to Claude Code starts it and writes the token file into the registry
		let rpcId = 0;
		const startMcp = async () => {
			await command('DataFlow: Connect to Claude Code');
			let token;
			let url;
			for (let i = 0; i < 80 && !(token && url); i++) {
				const tokenFile = path.join(registry, 'token');
				token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined;
				const win = existsSync(registry) ? readdirSync(registry).find((f) => /^window-\d+\.json$/.test(f)) : undefined;
				url = win ? JSON.parse(readFileSync(path.join(registry, win), 'utf8')).url : undefined;
				if (!(token && url)) { await sleep(250); }
			}
			if (!token || !url) { throw new Error('the MCP server did not start'); }
			const rpc = async (method, params = {}) => (await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
				body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
			})).json();
			await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
			return async (toolName, args) => {
				const reply = await rpc('tools/call', { name: toolName, arguments: args });
				if (!reply.result || reply.result.isError) {
					throw new Error(`${toolName}: ${reply.result?.content?.[0]?.text ?? JSON.stringify(reply.error)}`);
				}
				return JSON.parse(reply.result.content[0].text);
			};
		};

		await until(() => wb.evaluate('!!document.querySelector(".monaco-editor .view-lines")'), 'text editor', 120);
		await sleep(1000);
		// no hovers of the workbench, for example the path of a file on its tab
		await wb.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '.workbench-hover-container, .monaco-hover, .monaco-workbench .hover-widget { display: none !important; }';
			document.head.appendChild(s); return true; })()`);
		// no side bar and no panel
		if (await wb.evaluate(`(() => { const p = document.querySelector('.part.sidebar'); return !!p && p.offsetWidth > 0; })()`)) {
			await command('View: Close Primary Side Bar');
		}
		if (await wb.evaluate(`(() => { const p = document.querySelector('.part.panel'); return !!p && p.offsetWidth > 0; })()`)) {
			await command('View: Hide Panel');
		}
		await sleep(3000); // the start of the engine
		await steps({
			wb, command, goToLine, until, openSide, splitAt, sideBox, setLenses, details, scrollSide, row, token, clickToken, hover,
			unhover, clickIn, shot, startMcp, inSide: (code) => inSide(code),
		});
		side?.ws.close();
		wb.ws.close();
	} finally {
		try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* closed */ }
		await sleep(2000);
	}
}

const battery = path.join(repo, 'test', 'fixtures', 'battery');
const batteryCpp = path.join(battery, 'src', 'battery.cpp');
const batteryText = readFileSync(batteryCpp, 'utf8').split(/\r?\n/);
const lineOf = (s, after = 0) => {
	const n = batteryText.findIndex((l, i) => i >= after && l.includes(s)) + 1;
	if (n === 0) { throw new Error(`no line with "${s}"`); }
	return n;
};
const colOf = (line, s) => batteryText[line - 1].indexOf(s) + 1;

const L = {
	initial: lineOf('auto initial_power('),
	bestFit: lineOf('auto bestFit = best_preset('),
	usedPreset: lineOf('log_info(std::format("used preset'),
	solve: lineOf('std::optional<double> solve_power_plan('),
	process: lineOf('std::optional<Requests> process(tf::Executor'),
	setup: lineOf('auto &tariff_plans = home_battery_ctl'),
	curPlan: lineOf('auto cur_tariff_plan = get_if('),
	start: lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)'),
	update: lineOf('fire_transition(home_battery_ctl, "", true);'),
	chain: lineOf('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)'),
	ready: lineOf('if (home_battery_ctl.charging_future && FINISHED('),
	get: lineOf('auto converged = home_battery_ctl.charging_future->get();'),
	reset: lineOf('home_battery_ctl.charging_future.reset();'),
	converged: lineOf('if (converged) {'),
	requests: lineOf('requests = make_requests('),
	notConverged: lineOf('} else {', lineOf('if (converged) {')),
	nextSlot: lineOf('pick_next_price_slot(settings);'),
	active: lineOf('} else if (home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE)'),
	reading: lineOf('} else if (home_battery_ctl.state == HOMEPOWER_METER_READING)'),
	readings: lineOf('auto data = stable_readings('),
	stable: lineOf('} else if (home_battery_ctl.state == HOMEPOWER_METER_STABLE)'),
	store: lineOf('for (const auto &d : home_battery_ctl.new_readings)'),
	chainEnd: lineOf('home_battery_ctl.new_readings.clear();') + 2,
	ret: lineOf('return requests;'),
	stableFn: lineOf('std::vector<MeterRead> stable_readings('),
	lookup: lineOf('if (!last_read.contains(tapTopic))'),
	fire: lineOf('fire_transition(home_battery_ctl, "", true);'),
};

try {
	if (isWanted('flow-lens', 'flow-lens-member', 'logic-map', 'hidden-cpp', 'include-hierarchy', 'call-hierarchy', 'show-calls', 'threads',
		'model-blocks', 'model-notes', 'model-comments', 'model-detail', 'overview')) {
		await session('battery', battery, batteryCpp, L.process, { 'git.enabled': false }, async (s) => {
			await s.openSide('DataFlow: Open Side View');
			await s.splitAt(EDITOR_WIDTH);
			await s.until(() => s.inSide(`return /Engine: ready/.test(doc.querySelector('.status')?.textContent ?? '');`), 'ready engine', 160);
			await sleep(2000);

			// Flow Lens: the trace of bestFit, and the card of the read with no check
			if (isWanted('flow-lens')) {
				await s.setLenses([]);
				await s.details(null);
				await s.goToLine(`${L.bestFit}:${colOf(L.bestFit, 'bestFit')}`);
				await s.command('DataFlow: Trace Variable');
				await s.until(() => s.inSide(`return doc.querySelectorAll('.rail').length > 0;`), 'rails');
				await s.scrollSide(L.initial);
				await sleep(1500);
				const mark = `[...${s.row(L.usedPreset)}.querySelectorAll('[data-mark]')].at(-1)`;
				await s.hover(mark);
				await s.until(() => s.inSide(`return !!doc.querySelector('.card');`), 'card of Flow Lens');
				await sleep(800);
				await s.shot('flow-lens', await s.sideBox());
				await s.unhover(mark);
			}

			// Flow Lens on a data member: is_dirty with the threads, the locks and the race in the details column
			if (isWanted('flow-lens-member')) {
				await s.setLenses([]);
				await s.scrollSide(L.solve);
				await s.clickToken(L.start, 'is_dirty');
				await s.until(() => s.inSide(`return ${s.row(lineOf('charge.is_dirty = false;'))}?.querySelectorAll('[data-mark]').length > 0;`), 'marks of the member');
				await s.details('Flow Lens');
				await s.scrollSide(L.solve);
				await sleep(1500);
				await s.shot('flow-lens-member', await s.sideBox());
				await s.command('DataFlow: Clear Trace');
				await sleep(800);
			}

			// Logic Map: the path through the planning state, with the trail and the card of a line number
			if (isWanted('logic-map')) {
				await s.setLenses(['Logic Map']);
				await s.goToLine(`${L.chain}:5`);
				await s.details('Logic Map');
				await s.until(() => s.inSide(`return doc.querySelectorAll('.trail .step').length > 0;`), 'trail');
				const choose = async (line, value) => {
					const ok = await s.inSide(`
						const step = doc.querySelector('.trail .step.k-decision[data-line="${line}"]');
						if (!step) { return false; }
						const select = step.querySelector('select');
						if (select) { select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; }
						const button = [...step.querySelectorAll('.seg button')].find((b) => b.textContent === ${JSON.stringify(value)});
						button?.click();
						return !!button;`);
					if (!ok) { throw new Error(`no step on line ${line} with the option ${value}`); }
					await sleep(600);
				};
				await choose(L.chain, 'HOMEPOWER_CHARGE_PLANNING');
				await choose(L.ready, 'yes');
				await choose(L.converged, 'yes');
				await choose(lineOf('if (home_battery_ctl.operational_mode == POWER_AUTO)', L.converged), 'yes');
				await s.scrollSide(L.process);
				await sleep(1200);
				await s.shot('logic-map', await s.sideBox());
			}

			// Hidden C++: the chips of stable_readings(), and the card of the repeated lookups with their curves
			if (isWanted('hidden-cpp')) {
				await s.setLenses(['Hidden C++']);
				await s.details(null);
				await s.goToLine(`${L.lookup}:9`);
				await s.scrollSide(L.stableFn - 1);
				await s.until(() => s.inSide(`return doc.querySelectorAll('.ck').length > 0;`), 'items of Hidden C++');
				await sleep(800);
				const chip = `${s.row(L.lookup)}.querySelector('.ck.cc-lookup')`;
				await s.hover(chip);
				await s.until(() => s.inSide(`return !!doc.querySelector('.cost-card');`), 'card of Hidden C++');
				await sleep(800);
				await s.shot('hidden-cpp', await s.sideBox());
				await s.unhover(chip);
			}

			// Include Hierarchy: the hints of the includes, the tree, and the path that brings a header into the file
			if (isWanted('include-hierarchy')) {
				await s.setLenses(['Includes']);
				await s.goToLine('1:1');
				await s.details('Includes');
				const item = (name) => `[...doc.querySelectorAll('.itree [role="treeitem"]')].find((x) => (x.querySelector('.f')?.textContent ?? '').replace(/[<>"]/g, '').split('/').pop() === '${name}')`;
				try {
					await s.until(() => s.inSide(`return !!${item('types.hpp')};`), 'include tree', 60);
				} catch (err) {
					throw new Error(`${err.message}: ${await s.inSide(`return doc.querySelector('.details')?.textContent.slice(0, 300) + ' | ' + [...doc.querySelectorAll('.itree .f')].map((f) => f.textContent).join(', ');`)}`);
				}
				// the includes of types.hpp, and the path that brings <vector> into the file
				await s.inSide(`${item('types.hpp')}.querySelector('.tw')?.click(); return true;`);
				await s.until(() => s.inSide(`return !!${item('vector')};`), 'includes of types.hpp');
				await s.inSide(`${item('vector')}.click(); return true;`);
				await s.until(() => s.inSide(`return !!doc.querySelector('.why-path');`), 'path of the include');
				await sleep(800);
				await s.scrollSide(1);
				await s.shot('include-hierarchy', await s.sideBox());
			}

			// Call Hierarchy: the graph of process(), and the list of the calls of fire_transition()
			if (isWanted('call-hierarchy')) {
				await s.setLenses(['Calls']);
				await s.goToLine(`${L.chain}:5`);
				await s.details('Calls');
				await s.until(() => s.inSide(`return [...doc.querySelectorAll('.details button.link')].some((b) => b.textContent === 'Show graph');`), 'button Show graph');
				await s.clickIn('.details button.link', 'Show graph');
				await s.until(() => s.inSide(`return doc.querySelectorAll('.cg-node').length > 1;`), 'call graph');
				await sleep(1200);
				await s.shot('call-hierarchy', await s.sideBox());
				await s.clickIn('.details button.link', 'Hide graph');
				await sleep(600);
			}
			if (isWanted('show-calls')) {
				await s.setLenses(['Calls']);
				await s.details(null);
				await s.goToLine(`${L.fire}:${colOf(L.fire, 'fire_transition') + 2}`);
				await s.command('DataFlow: Show Calls');
				await s.until(() => s.inSide(`return doc.querySelectorAll('.call-list .call-item').length > 0;`), 'list of calls');
				await sleep(1000);
				await s.shot('show-calls', await s.sideBox());
				await s.inSide(`doc.defaultView.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
				await sleep(500);
			}

			// Threads and races: the race on is_dirty, with its accesses in the code and the two lanes
			if (isWanted('threads')) {
				await s.setLenses(['Threads']);
				await s.goToLine(`${L.start}:5`);
				await s.details('Threads');
				await s.until(() => s.inSide(`return doc.querySelectorAll('.titems .titem').length > 0;`), 'shared data');
				await s.inSide(`const items = [...doc.querySelectorAll('.titems .titem')]; (items.find((i) => /is_dirty/.test(i.textContent)) ?? items[0]).click(); return true;`);
				await sleep(1200);
				await s.scrollSide(L.solve);
				await sleep(800);
				await s.shot('threads', await s.sideBox());
			}

			// the view tools of the MCP server, as a language model calls them
			if (isWanted('model-blocks', 'model-notes', 'model-comments', 'model-detail', 'overview')) {
				const tool = await s.startMcp();
				await s.setLenses([]);
				await tool('show_blocks', {
					function: 'process',
					blocks: [
						{ lines: [L.setup, L.curPlan], title: 'Read the active tariff plan', summary: 'Gets the tariff plans and the settings of the controller. With no active plan, the function stops.' },
						{ lines: [L.start, L.start + 2], title: 'Start the solver on a worker thread', summary: 'If the charge changed and no solver runs, solve_power_plan() starts on the executor.' },
						{ lines: [L.update, L.update], title: 'Update the state machine', summary: 'An empty event makes the state machine check its state.' },
						{
							lines: [L.chain, L.chainEnd], title: 'Run the current state', summary: 'Each state of the controller has its own branch.', children: [
								{
									lines: [L.chain, L.active - 1], title: 'Planning: use the result of the solver', children: [
										{ lines: [L.get, L.reset], title: 'Take the result and free the future' },
										{
											lines: [L.converged, L.active - 2], title: 'Use the result', children: [
												{ lines: [L.converged, L.notConverged - 1], title: 'Converged: make the requests' },
												{ lines: [L.notConverged, L.active - 2], title: 'Not converged: try the next price slot' },
											],
										},
									],
								},
								{ lines: [L.active, L.reading - 1], title: 'Charging: plan again when the charge stops' },
								{ lines: [L.reading, L.stable - 1], title: 'Meter reading: keep the new stable readings' },
								{ lines: [L.stable, L.chainEnd], title: 'Meter stable: store the readings' },
							],
						},
						{ lines: [L.ret, L.ret], title: 'Return the requests', summary: 'The caller sends the requests, or nothing if no plan is ready.' },
					],
				});
				await s.goToLine(`${L.chain}:5`);
				await s.details('Model');
				await s.scrollSide(L.process - 1);
				await sleep(1500);
				if (isWanted('model-blocks')) {
					await s.shot('model-blocks', await s.sideBox());
				}

				await tool('highlight', {
					ranges: [
						{ lines: [L.curPlan, L.curPlan], kind: 'problem', note: `get_if() gives null if the active plan is not in tariff_plans, and line ${L.requests} reads *cur_tariff_plan with no check.` },
						{ lines: [L.start, L.start + 2], kind: 'warning', note: `Reads charge.is_dirty before it checks the future. The solver writes is_dirty on the worker thread (line ${lineOf('charge.is_dirty = false;')}).` },
						{ lines: [L.store, L.store + 5], kind: 'info', note: 'Stores the new readings until reading_db has reading_count_limit items.' },
					],
				});
				await s.goToLine(`${L.curPlan}:5`);
				await s.scrollSide(L.process - 1);
				await sleep(1500);
				if (isWanted('model-notes')) {
					await s.details(null);
					await s.shot('model-notes', await s.sideBox());
				}

				await tool('comment_lines', {
					comments: [
						{ line: L.start + 1, text: 'solve_power_plan() runs on a worker thread', color: 'purple' },
						{ line: L.reset, text: 'the next cycle can start a new solver', color: 'blue' },
						{ line: L.requests, text: 'the plan of the solver becomes requests', color: 'green' },
						{ line: L.nextSlot, text: 'a later, cheaper price slot' },
						{ line: L.readings, text: 'only the readings that did not change for meter_hold_time', color: 'yellow' },
					],
				});
				await s.goToLine(`${L.get}:5`);
				await s.scrollSide(L.chain - 6);
				await sleep(1500);
				if (isWanted('model-comments')) {
					await s.details(null);
					await s.shot('model-comments', await s.sideBox());
				}

				await tool('add_detail', {
					line: L.ready, expression: 'FINISHED(*home_battery_ctl.charging_future)', title: 'Examples of FINISHED(...)',
					text: '`FINISHED(f)` expands to `(f).is_ready()`. It is true when the solver has a result.\n\n'
						+ '- The solver still runs: `false`. The state stays at planning, and the next cycle checks again.\n'
						+ `- The solver found a cost of \`3e-6\`: \`true\`. Line ${L.get} gets \`3e-6\`.\n`
						+ `- The solver found no cost under \`1e-5\`: \`true\`. Line ${L.get} gets an empty optional, so the branch on line ${L.notConverged} runs.`,
				});
				await sleep(1500);
				if (isWanted('model-detail')) {
					await s.details(null);
					await s.scrollSide(L.chain - 6);
					const mark = `${s.row(L.ready)}.querySelector('.detail-mark')`;
					await s.until(() => s.inSide(`return !!${mark};`), 'symbol of the detail');
					await s.hover(mark);
					await s.until(() => s.inSide(`return !!doc.querySelector('.detail-card');`), 'card of the detail');
					await sleep(800);
					await s.shot('model-detail', await s.sideBox());
					await s.unhover(mark);
				}

				// the window: the text editor and the side view with the layers of the model, Logic Map and a trace
				if (isWanted('overview')) {
					await s.setLenses(['Logic Map']);
					await tool('show_flow', { line: L.get, name: 'converged' });
					// the cursor on an empty line keeps the trace and shows all lines at full brightness
					await s.goToLine(`${L.chain - 1}:1`);
					await s.details(null);
					await s.scrollSide(L.process - 1);
					await sleep(2000);
					await s.shot('overview');
				}
			}
		});
	}

	// Change Ripple on the review fixture: the story of a changed limit in solve_power_plan()
	if (isWanted('change-ripple')) {
		const review = path.join(repo, 'build', 'fixtures', 'battery-review');
		const reviewCpp = path.join(review, 'src', 'battery.cpp');
		const changed = readFileSync(reviewCpp, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('if (cost < 1e-4)')) + 1;
		await session('review', review, reviewCpp, changed, {}, async (s) => {
			await s.openSide('DataFlow: Review Changes');
			await s.splitAt(EDITOR_WIDTH);
			await s.until(() => s.inSide(`return doc.querySelectorAll('.scard').length >= 3 && doc.querySelectorAll('.scard .code span[class^="t"]').length > 0;`), 'story', 240);
			await sleep(6000); // the wave
			await s.shot('change-ripple', await s.sideBox());
		});
	}
} finally {
	rmSync(temp, { recursive: true, force: true });
}
