import { useLayoutEffect, useRef } from 'preact/hooks';
import type { SideCallEdge, SideCallFunction, SideCalls } from '../side/protocol';
import { vscode } from './vscode';

// Call Hierarchy in the side view: the hints on the calls of the function at the cursor, the graph with the callers on
// the left and the called functions on the right, and the details column with the lists of the calls.

export type CallHint = SideCalls['hints'][number];

// The function in the center, the levels of the graph, and the library calls. The side view keeps this state.
export interface CallView {
	focus: number;
	depth: 1 | 2;
	showLibrary: boolean;
}

const openPlace = (file: string, line: number, col: number) => vscode.postMessage({ type: 'openPlace', file, line, col });
const fileName = (file: string) => file.split(/[/\\]/).pop() ?? file;

// The hints of each line, for the code view
export function callHints(calls: SideCalls | null): Map<number, CallHint[]> {
	const out = new Map<number, CallHint[]>();
	for (const h of calls?.hints ?? []) {
		out.set(h.line, [...(out.get(h.line) ?? []), h]);
	}
	return out;
}

// The links that show: a library call shows only when the user asks for it
export function visibleEdges(calls: SideCalls, showLibrary: boolean): SideCallEdge[] {
	const isLibrary = (id: number) => calls.functions[id]?.where === 'library';
	return calls.edges.filter((e) => showLibrary || (!isLibrary(e.from) && !isLibrary(e.to)));
}

//----------------------------------
// Graph

const NW = 196; // the width of a node
const NH = 38;
const COLW = 238; // the distance between two columns
const ROWH = 48;
const PAD = 6;

interface Layout {
	pos: Map<number, { col: number; row: number; x: number; y: number }>;
	via: Map<number, SideCallEdge>; // the link that put a node into the graph
	used: SideCallEdge[];
	width: number;
	height: number;
}

// The callers go to the left of the function in the center, the called functions to the right, up to depth columns.
// The rows of a column follow the rows of the nodes that they connect to, then the first line of the call.
function layout(edges: SideCallEdge[], focus: number, depth: number): Layout {
	const col = new Map<number, number>([[focus, 0]]);
	const via = new Map<number, SideCallEdge>();
	for (const dir of [-1, 1]) {
		let front = [focus];
		for (let d = 1; d <= depth; d++) {
			const next: number[] = [];
			for (const n of front) {
				for (const e of edges) {
					const other = dir < 0 ? (e.to === n ? e.from : -1) : (e.from === n ? e.to : -1);
					if (other >= 0 && !col.has(other)) {
						col.set(other, dir * d);
						via.set(other, e);
						next.push(other);
					}
				}
			}
			front = next;
		}
	}

	const byCol = new Map<number, number[]>();
	for (const [id, c] of col) {
		byCol.set(c, [...(byCol.get(c) ?? []), id]);
	}
	const pos: Layout['pos'] = new Map();
	for (const c of [...byCol.keys()].sort((a, b) => Math.abs(a) - Math.abs(b))) {
		const ids = byCol.get(c)!;
		const rank = (id: number): [number, number] => {
			const e = via.get(id);
			if (!e) {
				return [0, 0];
			}
			const near = pos.get(c < 0 ? e.to : e.from);
			return [near ? near.row : 0, e.sites[0]?.line ?? 0];
		};
		ids.sort((a, b) => {
			const ra = rank(a);
			const rb = rank(b);
			return ra[0] - rb[0] || ra[1] - rb[1];
		});
		ids.forEach((id, row) => pos.set(id, { col: c, row, x: 0, y: 0 }));
	}
	const cols = [...byCol.keys()];
	const minCol = Math.min(...cols);
	const maxCol = Math.max(...cols);
	const tallest = Math.max(...[...byCol.values()].map((ids) => ids.length));
	for (const ids of byCol.values()) {
		const offset = (tallest - ids.length) / 2;
		for (const id of ids) {
			const p = pos.get(id)!;
			p.x = PAD + (p.col - minCol) * COLW;
			p.y = PAD + (p.row + offset) * ROWH;
		}
	}
	const used = edges.filter((e) => col.has(e.from) && col.has(e.to) && col.get(e.to) === col.get(e.from)! + 1);
	return { pos, via, used, width: PAD * 2 + (maxCol - minCol) * COLW + NW, height: PAD * 2 + (tallest - 1) * ROWH + NH };
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface CallGraphProps {
	calls: SideCalls;
	view: CallView;
	onView: (view: CallView) => void;
	onFocus: (fn: number) => void;
	onClose: () => void;
}

// The panel of the graph over the code: the controls, and the graph. A click on a node puts it in the center. The graph
// scrolls so that the function in the center is in the middle of the panel
export function CallGraph({ calls, view, onView, onFocus, onClose }: CallGraphProps) {
	const focus = calls.functions[view.focus];
	const box = useRef<HTMLDivElement>(null);
	const L = focus ? layout(visibleEdges(calls, view.showLibrary), view.focus, view.depth) : undefined;
	useLayoutEffect(() => {
		const p = L?.pos.get(view.focus);
		const el = box.current;
		if (p && el) {
			el.scrollTop = Math.max(0, p.y + NH / 2 - el.clientHeight / 2);
			el.scrollLeft = Math.max(0, p.x + NW / 2 - el.clientWidth / 2);
		}
	}, [calls, view.focus, view.depth, view.showLibrary]);
	if (!focus || !L) {
		return null;
	}
	const cursor = calls.functions[calls.focus];
	return (
		<div class="callgraph" role="group" aria-label="Call Hierarchy">
			<div class="callgraph-bar">
				<span class="sub-title">Calls of {focus.label}</span>
				<div class="seg" role="group" aria-label="Levels">
					<button type="button" aria-pressed={view.depth === 1} onClick={() => onView({ ...view, depth: 1 })}>1 level</button>
					<button type="button" aria-pressed={view.depth === 2} onClick={() => onView({ ...view, depth: 2 })}>2 levels</button>
				</div>
				<button type="button" class="var" aria-pressed={view.showLibrary} onClick={() => onView({ ...view, showLibrary: !view.showLibrary })}>
					Library calls
				</button>
				{cursor && view.focus !== calls.focus && (
					<button type="button" class="link" onClick={() => onFocus(calls.focus)}>Back to {cursor.label}</button>
				)}
				<span class="grow" />
				<button type="button" class="lens" onClick={onClose}>Hide graph</button>
			</div>
			<div class="callgraph-svg" ref={box}>
				<svg width={L.width} height={L.height} viewBox={`0 0 ${L.width} ${L.height}`} role="img"
					aria-label={`Call hierarchy of ${focus.label}: the callers on the left, the called functions on the right`}>
					<g>
						{L.used.map((e) => {
							const a = L.pos.get(e.from)!;
							const b = L.pos.get(e.to)!;
							const sx = a.x + NW;
							const sy = a.y + NH / 2;
							const tx = b.x;
							const ty = b.y + NH / 2;
							const dx = (tx - sx) / 2;
							return <path class={`cg-edge k-${e.kind}${e.isVirtual ? ' virtual' : ''}`} d={`M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`} />;
						})}
					</g>
					<g>
						{[...L.pos.entries()].map(([id, p]) => (
							<GraphNode fn={calls.functions[id]} x={p.x} y={p.y} isFocus={id === view.focus} via={L.via.get(id)} onFocus={onFocus} />
						))}
					</g>
				</svg>
			</div>
		</div>
	);
}

function GraphNode({ fn, x, y, isFocus, via, onFocus }: { fn: SideCallFunction; x: number; y: number; isFocus: boolean; via?: SideCallEdge; onFocus: (fn: number) => void }) {
	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onFocus(fn.id);
		}
	};
	return (
		<g class={`cg-node w-${fn.where}${isFocus ? ' focus' : ''}`} tabIndex={0} role="button" aria-label={`${fn.label}${isFocus ? ', in the center' : ''}`}
			onClick={() => onFocus(fn.id)} onKeyDown={onKey}>
			<title>{via ? `${fn.label}: ${via.long}` : fn.label}</title>
			<rect x={x} y={y} width={NW} height={NH} rx={6} />
			<text x={x + 10} y={y + 16} class="cg-label">{short(fn.label, 27)}</text>
			<text x={x + 10} y={y + 30} class={`cg-sub k-${isFocus ? 'focus' : via?.kind ?? 'call'}`}>{isFocus ? 'in the center' : short(via?.short ?? '', 30)}</text>
		</g>
	);
}

//----------------------------------
// Details

export interface CallDetailsProps {
	calls: SideCalls | null;
	view: CallView;
	isGraphOpen: boolean;
	onView: (view: CallView) => void;
	onFocus: (fn: number) => void;
	onGraph: () => void;
}

// The details column of Call Hierarchy: the callers and the called functions of the function in the center, with the
// data and the lines of the calls
export function CallDetails({ calls, view, isGraphOpen, onView, onFocus, onGraph }: CallDetailsProps) {
	const focus = calls?.functions[view.focus];
	if (!calls || !focus) {
		return (
			<div class="details-body">
				<p class="sub">Put the cursor in a function. Call Hierarchy shows its callers and the functions that it calls.</p>
			</div>
		);
	}
	const edges = visibleEdges(calls, view.showLibrary);
	const into = edges.filter((e) => e.to === view.focus);
	const out = edges.filter((e) => e.from === view.focus);
	const hidden = calls.edges.filter((e) => (e.from === view.focus || e.to === view.focus) && !edges.includes(e)).length;
	const cursor = calls.functions[calls.focus];

	const item = (e: SideCallEdge, other: number) => {
		const fn = calls.functions[other];
		return (
			<div class="call">
				<div class="call-who">
					<button type="button" class="link mono" title={`Put ${fn.label} in the center`} onClick={() => onFocus(other)}>{fn.label}</button>
					<span class={`call-what k-${e.kind}`}>{e.short}</span>
				</div>
				<p class="sub">{e.long}</p>
				<div class="call-sites">
					{e.sites.map((s) => (
						<button type="button" class="badge k-muted" title={`Show line ${s.line}`} onClick={() => openPlace(e.file, s.line, s.col)}>{s.line}</button>
					))}
				</div>
			</div>
		);
	};

	return (
		<div class="details-body">
			<div class="flow-title">
				<span class="flow-name mono fn-name">{focus.label}</span>
				<button type="button" class="link" onClick={onGraph}>{isGraphOpen ? 'Hide graph' : 'Show graph'}</button>
			</div>
			{focus.where !== 'main' && (
				<p class="sub">
					{focus.label} is in a different file. The lists show its calls in this file only.{' '}
					{focus.where !== 'library' && focus.isDefined ? (
						<>
							<button type="button" class="link" title={`Open ${focus.file} at line ${focus.line}`}
								onClick={() => openPlace(focus.file, focus.line, focus.col)}>
								Open {fileName(focus.file)}
							</button>{' '}
							to see all of its calls.
						</>
					) : focus.where !== 'library' && (
						<>
							Its body is in a different source file.{' '}
							<button type="button" class="link" title="Ask the C/C++ extension or clangd for the definition, and open its file"
								onClick={() => vscode.postMessage({ type: 'openDefinition', file: focus.file, line: focus.line, col: focus.col })}>
								Find the definition
							</button>{' '}
							to see all of its calls.
						</>
					)}
				</p>
			)}
			<div class="path-actions">
				<button type="button" class="var" aria-pressed={view.showLibrary} onClick={() => onView({ ...view, showLibrary: !view.showLibrary })}>
					Library calls{hidden > 0 ? ` (${hidden} hidden)` : ''}
				</button>
				{cursor && view.focus !== calls.focus && <button type="button" class="link" onClick={() => onFocus(calls.focus)}>Back to {cursor.label}</button>}
			</div>
			{calls.notice && <p class="sub notice">{calls.notice}</p>}
			<div class="sub-title">Called by ({into.length})</div>
			{into.length > 0 ? into.map((e) => item(e, e.from)) : <p class="sub">No caller in this file, and no caller from the call hierarchy of VS Code.</p>}
			<div class="sub-title">Calls ({out.length})</div>
			{out.length > 0 ? out.map((e) => item(e, e.to)) : <p class="sub">No calls in this file.</p>}
		</div>
	);
}
