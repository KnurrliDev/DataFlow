import { useEffect, useState } from 'preact/hooks';
import type { SideIncludeNode, SideIncluders, SideIncludes } from '../side/protocol';
import { vscode } from './vscode';

// Include Hierarchy in the side view: the hints on the include lines of the file, and the details column with the
// totals, the groups of the lines, the include tree, the path of the selected header and the places that include it.

export type IncludeHint = SideIncludes['hints'][number];

// For example 950, 12.3k or 1.2M
function fmt(n: number): string {
	if (n >= 1e6) {
		return `${(n / 1e6).toFixed(1)}M`;
	}
	return n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

const full = (n: number) => n.toLocaleString('en-US');
const percent = (part: number, all: number) => `${all > 0 ? ((part / all) * 100).toFixed(1) : '0.0'}%`;
const basename = (file: string) => file.split(/[\\/]/).pop() ?? file;
const openPlace = (file: string, line: number) => vscode.postMessage({ type: 'openPlace', file, line });

// The hints of each line, for the code view
export function includeHints(includes: SideIncludes | null): Map<number, IncludeHint[]> {
	const out = new Map<number, IncludeHint[]>();
	for (const h of includes?.hints ?? []) {
		out.set(h.line, [...(out.get(h.line) ?? []), h]);
	}
	return out;
}

export interface IncludeDetailsProps {
	includes: SideIncludes | null;
	includers?: SideIncluders; // the translation units of the compile databases that include a file
	selected?: number; // the selected node
	onSelect: (node: number) => void;
}

// The details column of Include Hierarchy. "Includes" shows the tree and the path of the selected header. "Included
// by" shows the places in the translation unit that include it, and the translation units of the compile databases.
export function IncludeDetails({ includes, includers, selected, onSelect }: IncludeDetailsProps) {
	const [tab, setTab] = useState<'tree' | 'back'>('tree');
	const [open, setOpen] = useState<Set<number>>(() => new Set([0]));

	// a new file starts with the includes of the file. A selection opens the path to the selected header
	useEffect(() => setOpen(new Set([0])), [includes?.file]);
	useEffect(() => {
		if (!includes || selected === undefined || !includes.nodes[selected]) {
			return;
		}
		setOpen((o) => {
			const next = new Set(o);
			for (let p = includes.nodes[selected].parent; p >= 0; p = includes.nodes[p].parent) {
				next.add(p);
			}
			return next;
		});
	}, [includes, selected]);

	if (!includes) {
		return (
			<div class="details-body">
				<p class="sub">Include Hierarchy shows the includes of the file, the lines that each include adds, and the path of each header.</p>
			</div>
		);
	}
	const s = includes.stats;
	const sel = selected !== undefined ? includes.nodes[selected] : undefined;
	const toggle = (id: number) => setOpen((o) => {
		const next = new Set(o);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		return next;
	});

	return (
		<div class="details-body">
			<div class="flow-title">
				<span class="flow-name">Includes of {includes.name}</span>
			</div>
			<div class="seg" role="group" aria-label="View">
				<button type="button" aria-pressed={tab === 'tree'} onClick={() => setTab('tree')}>Includes</button>
				<button type="button" aria-pressed={tab === 'back'} onClick={() => setTab('back')}>Included by</button>
			</div>
			<div class="stats">
				<span class="stat">{full(s.lines)} lines in the file</span>
				<span class="stat">{fmt(s.total)} lines after the preprocessor</span>
				<span class="stat">{s.includes} includes, {s.skipped} included before</span>
				{s.unused > 0 && <span class="stat">{s.unused} possibly unused</span>}
				{s.forward > 0 && <span class="stat">{s.forward} replaceable by forward declarations</span>}
				{s.missing > 0 && <span class="stat problem">{s.missing} not found</span>}
			</div>
			{tab === 'tree' ? (
				<>
					<LineGroups includes={includes} />
					<IncludeTree includes={includes} open={open} selected={selected} onToggle={toggle} onSelect={onSelect} />
					<WhyPath includes={includes} node={sel} />
				</>
			) : (
				<IncludedBy includes={includes} includers={includers} node={sel} onSelect={onSelect} />
			)}
		</div>
	);
}

// The bar "Where the lines come from": the lines of each group, as a part of all lines after the preprocessor
function LineGroups({ includes }: { includes: SideIncludes }) {
	const total = includes.stats.total;
	const label = includes.groups.map((g) => `${g.name} ${percent(g.lines, total)}`).join(', ');
	return (
		<div class="mgroup">
			<div class="sub-title">Where the lines come from</div>
			<div class="istack" role="img" aria-label={label}>
				{includes.groups.map((g) => (
					<i class={`c-${g.color}`} style={{ width: `${(g.lines / Math.max(1, total)) * 100}%` }} title={`${g.name}: ${full(g.lines)} lines`} />
				))}
			</div>
			<div class="ikey">
				{includes.groups.map((g) => (
					<span><i class={`dot-inline c-${g.color}`} />{g.name} {percent(g.lines, total)}</span>
				))}
			</div>
		</div>
	);
}

interface TreeProps {
	includes: SideIncludes;
	open: Set<number>;
	selected?: number;
	onToggle: (id: number) => void;
	onSelect: (id: number) => void;
}

// The include tree. Only the open nodes show their children. The bar and the number give the lines that a node adds.
function IncludeTree({ includes, open, selected, onToggle, onSelect }: TreeProps) {
	const total = Math.max(1, includes.stats.total);
	const rows: preact.JSX.Element[] = [];
	const add = (n: SideIncludeNode) => {
		const isOpen = open.has(n.id);
		const hasKids = n.children.length > 0;
		const title = n.state === 'skipped' ? `${n.name}: included before. It adds nothing here.`
			: n.state === 'missing' ? `${n.name}: not found`
				: `${n.path}: ${full(n.total)} lines with its includes`;
		rows.push(
			<div
				class={`irow s-${n.state}`}
				role="treeitem"
				aria-level={n.depth + 1}
				aria-selected={n.id === selected}
				aria-expanded={hasKids ? isOpen : undefined}
				title={title}
				onClick={() => onSelect(n.id)}
			>
				<span class="iname" style={{ paddingLeft: `${Math.min(n.depth, 12) * 10}px` }}>
					<button
						type="button"
						class="tw"
						tabIndex={-1}
						aria-hidden="true"
						onClick={(e) => {
							e.stopPropagation();
							if (hasKids) {
								onToggle(n.id);
							}
						}}
					>
						{hasKids ? (isOpen ? '▾' : '▸') : ''}
					</button>
					<span class={`dot-inline c-${n.color}`} />
					<span class="f">{n.name}</span>
					{n.parent === 0 && n.line > 0 && <span class="iline">:{n.line}</span>}
					{n.isForced && <span class="badge k-muted">-include</span>}
					{n.isOwn && <span class="badge k-muted">own header</span>}
					{n.state === 'skipped' && <span class="badge k-muted">included before</span>}
					{n.isUsed === false && !n.isOwn && <span class="badge k-problem">possibly unused</span>}
					{n.forward?.state === 'possible' && <span class="badge k-forward" title="Forward declarations can replace this include">fwd</span>}
					{n.state === 'missing' && <span class="badge k-problem">not found</span>}
				</span>
				<span class="ibar"><i class={`c-${n.color}`} style={{ width: `${n.total > 0 ? Math.max(1.5, (n.total / total) * 100) : 0}%` }} /></span>
				<span class="icost">{n.state === 'missing' ? '–' : n.id === 0 ? fmt(n.total) : n.total > 0 ? `+${fmt(n.total)}` : '0'}</span>
			</div>,
		);
		if (isOpen) {
			n.children.forEach((c) => add(includes.nodes[c]));
		}
	};
	add(includes.nodes[0]);
	return <div class="itree" role="tree" aria-label="Include tree">{rows}</div>;
}

// The path that brings the selected header into the file. A click on a step opens its include line
function WhyPath({ includes, node }: { includes: SideIncludes; node?: SideIncludeNode }) {
	if (!node || node.id === 0) {
		return <p class="sub">Select a header to see the path that brings it into the file.</p>;
	}
	const nodes = includes.nodes;
	const target = node.state === 'skipped' && node.first !== undefined ? nodes[node.first] : node;
	const steps: SideIncludeNode[] = [];
	for (let x: SideIncludeNode | undefined = target; x; x = x.parent >= 0 ? nodes[x.parent] : undefined) {
		steps.unshift(x);
	}
	const total = includes.stats.total;
	return (
		<div class="mgroup">
			<div class="sub-title">Why {node.name} is in the file</div>
			<div class="why-path">
				{steps.map((x, i) => (
					<>
						{i > 0 && <span class="arrow">→</span>}
						{x.parent >= 0 && x.line > 0 ? (
							<button type="button" class="link mono" title={`Open ${basename(x.parentPath)} at line ${x.line}`} onClick={() => openPlace(x.parentPath, x.line)}>
								{x.name} (line {x.line})
							</button>
						) : <span class="mono">{x.name}</span>}
					</>
				))}
			</div>
			{node.state === 'skipped' && (
				<p class="sub">
					This include adds nothing: {node.name} came in before, through {nodes[target.parent]?.name ?? 'the file'}. Its include guard or
					#pragma once skips it.
				</p>
			)}
			{node.state === 'entered' && (
				<p class="sub">{node.name} and its includes add {full(node.total)} lines, {percent(node.total, total)} of the translation unit.</p>
			)}
			{node.state === 'missing' && <p class="sub problem">The preprocessor did not find {node.name}.</p>}
			{node.use && (
				<p class="sub">
					First use in the file: {node.use.name} on line {node.use.line}
					{node.use.node !== undefined && node.use.node !== node.id && nodes[node.use.node] ? `, from ${nodes[node.use.node].name}` : ''}.
				</p>
			)}
			{node.isUsed === false && !node.isOwn && (
				<p class="sub">
					The file uses no name and no macro of {node.name}. It also needs no header that only this include brings in. Possibly you can
					remove the include.
				</p>
			)}
			{node.forward && <ForwardCheck includes={includes} node={node} />}
			{node.path && <button type="button" class="link small" onClick={() => openPlace(node.path, 1)}>Open {basename(node.path)}</button>}
		</div>
	);
}

// The details of the forward declarations show at most this number of lines for each type
const MAX_FORWARD_LINES = 12;

// The forward declaration check of an include of the file: the declarations that can replace it, with the lines that
// use each type, or the first line that needs the include. A click on a line opens it
function ForwardCheck({ includes, node }: { includes: SideIncludes; node: SideIncludeNode }) {
	const f = node.forward!;
	const lineLink = (line: number) => (
		<button type="button" class="link mono" title={`Open line ${line}`} onClick={() => openPlace(includes.file, line)}>line {line}</button>
	);
	if (f.state === 'needed') {
		return (
			<p class="sub fwd-needed">
				The file needs the full header: {lineLink(f.blocker.line)} uses <span class="mono">{f.blocker.name}</span>, {f.blocker.kind}.
			</p>
		);
	}
	return (
		<div class="fwd">
			<div class="sub-title">Forward declarations can replace this include</div>
			<div class="fwd-code">
				<pre>{f.text}</pre>
				<button type="button" class="link small" title="Put the forward declarations on the clipboard"
					onClick={() => vscode.postMessage({ type: 'copyForward', text: f.text })}>Copy</button>
			</div>
			{f.types.map((t) => (
				<div class="fwd-type">
					<span class="mono">{t.name}</span>
					{t.lines.slice(0, MAX_FORWARD_LINES).map((l, i) => <>{i > 0 && ', '}{lineLink(l)}</>)}
					{t.lines.length > MAX_FORWARD_LINES && <span class="sub">and {t.lines.length - MAX_FORWARD_LINES} more</span>}
				</div>
			))}
			<p class="sub">The file uses these types only in ways that need no full type, for example through a pointer or a reference.</p>
		</div>
	);
}

const SOURCE_FILE = /\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i;
const MAX_UNITS = 100;
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

interface IncludedByProps {
	includes: SideIncludes;
	includers?: SideIncluders;
	node?: SideIncludeNode;
	onSelect: (id: number) => void;
}

// The places in the translation unit that include the selected header, and the translation units of the compile
// databases that include it. With no selected header, the file of the side view, if it is no source file, for example a
// header or an .inc file of a unity build
function IncludedBy({ includes, includers, node, onSelect }: IncludedByProps) {
	const nodes = includes.nodes;
	const target = node && node.path && node.id !== 0 ? node : !SOURCE_FILE.test(nodes[0].path) ? nodes[0] : undefined;
	useEffect(() => {
		if (target) {
			vscode.postMessage({ type: 'includersShown', file: target.path });
		}
	}, [target?.path]);
	if (!target) {
		return <p class="sub">Select a header in the list of includes to see the files that include it.</p>;
	}
	const places = target.id === 0 ? [] : nodes.filter((n) => n.id > 0 && n.path === target.path);
	return (
		<>
			{places.length > 0 && (
				<div class="mgroup">
					<div class="sub-title">{target.name} is included by</div>
					{places.map((n) => {
						const parent = nodes[n.parent];
						return (
							<button
								type="button"
								class="ref mref"
								title={`Open ${basename(n.parentPath)} at line ${n.line}`}
								onClick={() => {
									onSelect(n.id);
									openPlace(n.parentPath, n.line);
								}}
							>
								<span class={`dot-inline c-${parent.color}`} />
								<span class="mfn">{parent.name}</span>
								<span class={`badge ${n.state === 'skipped' ? 'k-muted' : 'k-thread'}`}>{n.state === 'skipped' ? 'no effect' : 'first include'}</span>
								{n.line > 0 && <span class="line">line {n.line}</span>}
							</button>
						);
					})}
				</div>
			)}
			<UnitList name={target.id === 0 ? includes.name : target.name} includers={includers?.file === target.path ? includers : undefined}
				file={includes.file} />
		</>
	);
}

// The translation units of the compile databases that include a file. A change of the file compiles them again. The
// first request scans all source files of the compile databases
function UnitList({ name, includers, file }: { name: string; includers?: SideIncluders; file: string }) {
	if (!includers || includers.state === 'scanning') {
		return <p class="sub">Looking for the translation units of the compile database that include {name}…</p>;
	}
	if (includers.state === 'failed') {
		return <p class="sub problem">The scan of the compile database failed. {includers.error}</p>;
	}
	const units = includers.units;
	const n = units.length;
	return (
		<div class="verdict units">
			<strong>
				In the compile database: {n === 0 ? 'no translation unit includes it' : `${n} ${n === 1 ? 'translation unit includes' : 'translation units include'} it`}
			</strong>
			{n > 0 && <span class="sub">A change to {name} compiles {n === 1 ? 'this file' : `these ${n} files`} again.</span>}
			{n > 0 && (
				<div class="mgroup">
					{units.slice(0, MAX_UNITS).map((u) => (
						<button type="button" class="ref mref" title={`Open ${u.name}`} onClick={() => openPlace(u.file, 1)}>
							<span class="mfn">{u.name}</span>
							{samePath(u.file, file) && <span class="badge k-shown">this file</span>}
						</button>
					))}
				</div>
			)}
			{n > MAX_UNITS && <span class="sub">And {n - MAX_UNITS} more translation units.</span>}
			{includers.failed > 0 && (
				<span class="sub">The scan could not read {includers.failed} of the {includers.unitCount} translation units.</span>
			)}
		</div>
	);
}
