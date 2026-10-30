// Spike P0 (a) harness.
// Starts the VS Code test build with this extension and the Chrome DevTools Protocol (CDP).
// Takes timed screenshots of the glyph margin, reads the DOM, and then closes VS Code.
// Usage: node spikes/gutter/run.mjs <output folder>
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.argv[2] ?? path.join(repo, 'spikes/gutter/out'));
const testBuild = readdirSync(path.join(repo, '.vscode-test')).find((d) => d.startsWith('vscode-win32-x64-archive'));
// CODE_EXE selects another VS Code build, for example the installed one.
const codeExe = process.env.CODE_EXE ?? path.join(repo, '.vscode-test', testBuild, 'Code.exe');
const port = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const proc = spawn(codeExe, [
	`--extensionDevelopmentPath=${repo}`,
	`--user-data-dir=${path.join(out, 'user-data')}`,
	`--extensions-dir=${path.join(out, 'extensions')}`,
	`--remote-debugging-port=${port}`,
	'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
	repo, path.join(repo, 'test', 'fixtures', 'battery', 'src', 'battery.cpp'),
], { env: { ...process.env, DATAFLOW_SPIKE: 'gutter' }, stdio: 'ignore' });

const result = { codeExe, pid: proc.pid };
try {
	// Find the workbench page.
	let page;
	for (let i = 0; i < 120 && !page; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			page = list.find((t) => t.type === 'page' && t.url.includes('workbench'));
		} catch { /* VS Code is not ready yet. */ }
		if (!page) { await sleep(500); }
	}
	if (!page) { throw new Error('No workbench page on the CDP port.'); }

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let nextId = 0;
	const pending = new Map();
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
	};
	const send = (method, params = {}) => new Promise((r) => {
		const id = ++nextId;
		pending.set(id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

	// Read the glyph margin: icons with SVG backgrounds, breakpoints, and the line number of each.
	const probe = `(() => {
		const lines = [...document.querySelectorAll('.monaco-editor .margin .line-numbers')]
			.map((e) => ({ n: e.textContent.trim(), top: e.getBoundingClientRect().top }));
		const lineOf = (r) => { const l = lines.find((x) => Math.abs(x.top - r.top) < 4); return l ? Number(l.n) : null; };
		const svg = [...document.querySelectorAll('.monaco-editor .margin *')]
			.filter((e) => getComputedStyle(e).backgroundImage.includes('data:image/svg'))
			.map((e) => { const r = e.getBoundingClientRect(); return { line: lineOf(r), cls: e.className, x: r.left, y: r.top, w: r.width, h: r.height }; });
		const bps = [...document.querySelectorAll('.monaco-editor .margin [class*="codicon-debug-breakpoint"]')]
			.map((e) => { const r = e.getBoundingClientRect(); return { line: lineOf(r), cls: e.className, x: r.left, y: r.top, w: r.width, h: r.height }; });
		const top = (o) => { const e = document.elementFromPoint(o.x + o.w / 2, o.y + o.h / 2); return e ? e.className : null; };
		return { svg, bps, onTopAtBreakpoint: bps.map(top), lineCount: lines.length };
	})()`;
	let dom;
	for (let i = 0; i < 60; i++) {
		dom = await evaluate(probe);
		if (dom && dom.svg.length > 0) { break; }
		await sleep(500);
	}
	result.dom = dom;
	if (!dom || dom.svg.length === 0) { throw new Error('No SVG gutter icons found.'); }
	await sleep(1500);

	// Timed screenshots of the gutter area.
	const xs = dom.svg.map((s) => s.x);
	const ys = dom.svg.map((s) => s.y);
	const clip = { x: Math.max(0, Math.min(...xs) - 8), y: Math.max(0, Math.min(...ys) - 8), width: 90, height: Math.max(...ys) - Math.min(...ys) + 40, scale: 2 };
	const frames = [];
	for (let i = 0; i < 8; i++) {
		const shot = await send('Page.captureScreenshot', { format: 'png', clip });
		frames.push(shot.result.data);
		writeFileSync(path.join(out, `frame-${i}.png`), Buffer.from(shot.result.data, 'base64'));
		await sleep(110);
	}
	result.distinctFrames = new Set(frames).size;
	const full = await send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(path.join(out, 'window.png'), Buffer.from(full.result.data, 'base64'));
	ws.close();
} catch (err) {
	result.error = String(err);
} finally {
	// Close the VS Code test build and all of its child processes.
	try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Already closed. */ }
}
writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ pid: result.pid, error: result.error, distinctFrames: result.distinctFrames,
	svgIcons: result.dom?.svg.length, breakpoints: result.dom?.bps, onTopAtBreakpoint: result.dom?.onTopAtBreakpoint,
	iconsOnBreakpointLine: result.dom?.svg.filter((s) => result.dom.bps.some((b) => b.line === s.line)) }, null, 2));
