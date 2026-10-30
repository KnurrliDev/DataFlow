import { useEffect, useRef } from 'preact/hooks';
import type { SideFlow, SideFlowColor, SideFlowLane, SideFlowMark, SideFlowRole, SideFlowTag, SideMember, SideMemberRef } from '../side/protocol';
import { vscode } from './vscode';

// The layer of Flow Lens in the code view: the rails at the left of the code, the marks on the references, the hints
// of the findings, the hover card and the curves, and the details column.

// The distance between two rail columns, and the space between the rails and the code, in px
const LANE_STEP = 8;
const LANE_PAD = 6;
// A pulse takes 650 ms on a rail, and a maximum of 80 ms for each line
const PULSE_SECONDS = 0.65;

export const ROLE_LABELS: Record<SideFlowRole, [string, string]> = {
	def: ['definition', 'definitions'],
	write: ['write', 'writes'],
	mayWrite: ['possible write', 'possible writes'],
	check: ['check', 'checks'],
	read: ['read', 'reads'],
};

// The width of the rail area, or 0 with no rails
export function laneWidth(flow: SideFlow | null): number {
	return flow && flow.slots > 0 ? LANE_PAD + flow.slots * LANE_STEP + LANE_PAD : 0;
}

// The x of a rail column. Slot 0 is next to the code. The dots of the references are at the edge of the code.
function slotX(width: number, slot: number): number {
	return width - LANE_PAD - LANE_STEP / 2 - slot * LANE_STEP;
}

function dotX(width: number): number {
	return width - 3;
}

// The style of the part of a rail between two nodes
function segmentAt(lane: SideFlowLane, top: number, bottom: number): { color: SideFlowColor; isDashed: boolean } | undefined {
	const s = lane.segments.find((seg) => seg.from <= top && bottom <= seg.to);
	return s && { color: s.isProblem ? 'problem' : lane.color, isDashed: s.isProblem };
}

export interface FlowLaneProps {
	flow: SideFlow;
	line: number;
	rowHeight: number;
	animate: boolean;
	lead?: SideFlowColor; // the color of the guide line to the first reference of the row, if the row has a dot
	leadY: number; // the y of the guide line in the row: the bottom edge of the marks
}

// The rails of one row: the vertical parts, the corners at the first and the last line of a rail, a tick to the code
// at each node, the dots of the nodes, the start of the guide line to the reference, and the pulse
export function FlowLane({ flow, line, rowHeight, animate, lead, leadY }: FlowLaneProps) {
	const width = laneWidth(flow);
	const mid = rowHeight / 2;
	const r = Math.min(4, mid);
	const x0 = dotX(width);
	const parts: preact.JSX.Element[] = [];
	const dots: preact.JSX.Element[] = [];

	// the guide line goes from the dot down to the bottom edge of the marks. In the code, the first mark continues it
	if (lead) {
		parts.push(<path key="hook" d={`M ${x0} ${mid} Q ${x0} ${leadY} ${width} ${leadY}`} class={`hook c-${lead}`} />);
	}

	flow.lanes.forEach((lane, i) => {
		if (line < lane.from || line > lane.to) {
			return;
		}
		const x = slotX(width, lane.slot);
		const node = lane.nodes.find((n) => n.line === line);
		const path = (d: string, color: SideFlowColor, isDashed: boolean, key: string) =>
			parts.push(<path key={key} d={d} class={`rail c-${color}${isDashed ? ' dashed' : ''}`} />);

		if (lane.from === lane.to) {
			// a definition with its uses on the same line
		} else if (line === lane.from) {
			const s = segmentAt(lane, line, line + 1) ?? { color: lane.color, isDashed: false };
			path(`M ${x0} ${mid} H ${x + r} Q ${x} ${mid} ${x} ${mid + r} V ${rowHeight}`, s.color, s.isDashed, `${i}t`);
		} else if (line === lane.to) {
			const s = segmentAt(lane, line - 1, line) ?? { color: lane.color, isDashed: false };
			path(`M ${x} 0 V ${mid - r} Q ${x} ${mid} ${x + r} ${mid} H ${x0}`, s.color, s.isDashed, `${i}b`);
		} else {
			const up = segmentAt(lane, line - 1, line);
			const down = segmentAt(lane, line, line + 1);
			if (up) {
				path(`M ${x} 0 V ${mid}`, up.color, up.isDashed, `${i}u`);
			}
			if (down) {
				path(`M ${x} ${mid} V ${rowHeight}`, down.color, down.isDashed, `${i}d`);
			}
			if (node) {
				path(`M ${x} ${mid} H ${x0}`, node.color, false, `${i}n`);
			}
		}
		if (node) {
			const radius = node.isDef ? 3.4 : 2.6;
			dots.push(<circle key={`${i}o`} cx={x0} cy={mid} r={radius} class={`dot c-${node.color}${node.isHollow ? ' hollow' : ''}`} />);
		}

		// the pulse goes down the rail in the sequence of the lines. Each row moves it through its own part
		if (animate && flow.pulse > 0 && lane.to > lane.from) {
			const s = Math.min(0.08, PULSE_SECONDS / (lane.to - lane.from + 1));
			const y0 = line === lane.from ? mid : 0;
			const y1 = line === lane.to ? mid : rowHeight;
			const delay = line === lane.from ? 0 : (line - lane.from - 0.5) * s;
			parts.push(
				<circle
					key={`${i}p${flow.pulse}`}
					cx={x}
					cy={0}
					r={3}
					class={`pulse c-${lane.color}`}
					style={{ '--y0': `${y0}px`, '--y1': `${y1}px`, '--delay': `${delay}s`, '--dur': `${((y1 - y0) / rowHeight) * s}s` }}
				/>,
			);
		}
	});

	return <>{parts}{dots}</>;
}

// A part of the text of a row with a mark of Flow Lens
export interface Decoration {
	start: number;
	end: number;
	cls: string;
	mark: number; // the index in flow.marks
}

export interface FlowDecorations {
	marks: Map<number, Decoration[]>;
	hints: Map<number, string[]>;
	tags: Map<number, SideFlowTag[]>; // the tags of a member trace, for example the file and the line of the declaration
	leads: Map<number, SideFlowColor>; // the lines with a guide line from the dot to the first reference, and its color
}

// The marks, the hints and the guide lines of each line
export function flowDecorations(flow: SideFlow | null): FlowDecorations {
	const marks = new Map<number, Decoration[]>();
	const hints = new Map<number, string[]>();
	const tags = new Map<number, SideFlowTag[]>();
	const leads = new Map<number, SideFlowColor>();
	if (!flow) {
		return { marks, hints, tags, leads };
	}
	for (const t of flow.tags ?? []) {
		tags.set(t.line, [...(tags.get(t.line) ?? []), t]);
	}
	flow.marks.forEach((m, i) => {
		const list = marks.get(m.line) ?? [];
		list.push({ start: m.start, end: m.end, cls: m.finding ? 'mk mk-finding' : `mk mk-${m.role}`, mark: i });
		marks.set(m.line, list);
	});
	// a line with a dot on a rail gets a guide line from the dot to its first reference
	const dotLines = new Set(flow.lanes.flatMap((lane) => lane.nodes.map((n) => n.line)));
	for (const [line, list] of marks) {
		list.sort((a, b) => a.start - b.start);
		if (dotLines.has(line)) {
			const m = flow.marks[list[0].mark];
			list[0].cls += ' lead';
			leads.set(line, m.finding ? 'problem' : colorOf(m.role));
		}
	}
	for (const f of flow.findings) {
		const list = hints.get(f.line) ?? [];
		const text = `${flow.name}: ${f.text}`;
		if (!list.includes(text)) {
			list.push(text);
		}
		hints.set(f.line, list);
	}
	return { marks, hints, tags, leads };
}

// The text of a hover card: the role, the definitions that get to a use, the uses of a definition, and the finding
export function FlowCard({ flow, mark, left, top }: { flow: SideFlow; mark: number; left: number; top: number }) {
	const m = flow.marks[mark];
	const lines = (list: number[]) => [...new Set(list.map((i) => flow.marks[i].line))].sort((a, b) => a - b).join(', ');
	const role = ROLE_LABELS[m.role][0];
	const sources = m.from.length > 0 ? `Value from line ${lines(m.from)}` : m.role === 'def' ? 'Declaration' : undefined;
	const uses = m.to.length > 0 ? `Gets to line ${lines(m.to)}` : (m.role === 'def' || m.role === 'write') ? 'No use gets this value' : undefined;
	return (
		<div class="card" style={{ left: `${left}px`, top: `${top}px` }} role="tooltip">
			<div class="card-title"><span class={`dot-inline c-${m.finding ? 'problem' : colorOf(m.role)}`} />{flow.name}: {role}, line {m.line}</div>
			{sources && <div>{sources}</div>}
			{uses && <div>{uses}</div>}
			{m.finding && <div class="problem">{m.finding}</div>}
		</div>
	);
}

export function colorOf(role: SideFlowRole): SideFlowColor {
	switch (role) {
		case 'def':
			return 'definition';
		case 'write':
		case 'mayWrite':
			return 'write';
		case 'check':
			return 'check';
		default:
			return 'read';
	}
}

// The position of a mark in the code: the middle of the name, and the top and the bottom of its row
export interface MarkPoint {
	x: number;
	top: number;
	bottom: number;
}

// The left and the right edge of the text of a row in the content of the view, or undefined for a row with no text
export type TextSpanOf = (line: number) => [number, number] | undefined;

const cubic = (a: number, b: number, c: number, d: number, t: number) =>
	(1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;

// The lane of a curve between two rows: the left edge of the text of the rows between them, less a gap. Undefined if
// the direct curve does not go over the text of these rows. The test uses points of the curve
function curveLane(x1: number, y1: number, x2: number, y2: number, bend: number, lines: [number, number], rowHeight: number,
	textOf: TextSpanOf): number | undefined {
	let left = Infinity;
	for (let line = lines[0]; line <= lines[1]; line++) {
		left = Math.min(left, textOf(line)?.[0] ?? Infinity);
	}
	if (left === Infinity) {
		return undefined;
	}
	const SAMPLES = 48;
	for (let i = 1; i < SAMPLES; i++) {
		const t = i / SAMPLES;
		const x = cubic(x1, x1, x2, x2, t);
		const line = Math.floor(cubic(y1, y1 + bend, y2 - bend, y2, t) / rowHeight) + 1;
		const span = line >= lines[0] && line <= lines[1] ? textOf(line) : undefined;
		if (span && x >= span[0] - 2 && x <= span[1] + 2) {
			return left - 6;
		}
	}
	return undefined;
}

// A path along the border of the first row to the lane, along the lane, and along the border of the last row, with
// round corners. The borders of the rows are between the lines of text
function lanePath(x1: number, y1: number, x2: number, y2: number, lane: number): string {
	const dy = Math.sign(y2 - y1) || 1;
	const r = Math.max(0, Math.min(4, Math.abs(y2 - y1) / 2, Math.abs(x1 - lane), Math.abs(x2 - lane)));
	const s1 = Math.sign(x1 - lane);
	const s2 = Math.sign(x2 - lane);
	return `M ${x1} ${y1} H ${lane + s1 * r} Q ${lane} ${y1}, ${lane} ${y1 + dy * r} V ${y2 - dy * r} Q ${lane} ${y2}, ${lane + s2 * r} ${y2} H ${x2}`;
}

// The curves from the definitions that get to a use, or from a definition to its uses. A curve leaves the definition
// at the bottom of its row and comes into the use from the top of its row, or the reverse for a use above the
// definition, for example in a loop. If the curve goes over the text of the rows between, it goes around this text at
// the left.
export function FlowCurves({ flow, mark, pointOf, textOf, rowHeight }: {
	flow: SideFlow;
	mark: number;
	pointOf: (m: SideFlowMark) => MarkPoint;
	textOf: TextSpanOf;
	rowHeight: number;
}) {
	const m = flow.marks[mark];
	const pairs: [number, number][] = [...m.from.map((f): [number, number] => [f, mark]), ...m.to.map((t): [number, number] => [mark, t])];
	if (pairs.length === 0) {
		return null;
	}
	const curves = pairs.map(([a, b]) => {
		const ma = flow.marks[a];
		const mb = flow.marks[b];
		const pa = pointOf(ma);
		const pb = pointOf(mb);
		const isDown = pb.top >= pa.bottom;
		const c = { x1: pa.x, y1: isDown ? pa.bottom : pa.top, x2: pb.x, y2: isDown ? pb.top : pb.bottom, color: colorOf(ma.role) };
		const bend = Math.sign(c.y2 - c.y1 || 1) * Math.max(10, Math.abs(c.y2 - c.y1) / 2);
		const lines: [number, number] = [Math.min(ma.line, mb.line) + 1, Math.max(ma.line, mb.line) - 1];
		const lane = lines[0] <= lines[1] ? curveLane(c.x1, c.y1, c.x2, c.y2, bend, lines, rowHeight, textOf) : undefined;
		return { ...c, bend, lane };
	});
	const top = Math.min(...curves.flatMap((c) => [c.y1, c.y2])) - 8;
	const bottom = Math.max(...curves.flatMap((c) => [c.y1, c.y2])) + 8;
	const right = Math.max(...curves.flatMap((c) => [c.x1, c.x2])) + 16;
	return (
		<svg class="curves" style={{ top: `${top}px` }} width={right} height={bottom - top} aria-hidden="true">
			{curves.map((c, i) => {
				const y1 = c.y1 - top;
				const y2 = c.y2 - top;
				const d = c.lane !== undefined ? lanePath(c.x1, y1, c.x2, y2, c.lane)
					: `M ${c.x1} ${y1} C ${c.x1} ${y1 + c.bend}, ${c.x2} ${y2 - c.bend}, ${c.x2} ${y2}`;
				return (
					<g key={i} class={`curve c-${c.color}${c.lane !== undefined ? ' lane' : ''}`}>
						<path d={d} pathLength={1} />
						<circle cx={c.x1} cy={y1} r={2.5} />
						<circle cx={c.x2} cy={y2} r={2.5} />
					</g>
				);
			})}
		</svg>
	);
}

// The details column of Flow Lens: the variable, the counts, the findings, the references and the variables of the
// function
export function FlowDetails({ flow }: { flow: SideFlow | null }) {
	if (!flow) {
		return (
			<div class="details-body">
				<p class="sub">
					Put the cursor on a variable or on a data member of a class in the editor, or click it in the code. Flow Lens traces it.
				</p>
			</div>
		);
	}
	if (flow.member) {
		return <MemberDetails flow={flow} member={flow.member} />;
	}
	const reveal = (line: number) => () => vscode.postMessage({ type: 'revealLine', line });
	const roles = (Object.keys(ROLE_LABELS) as SideFlowRole[]).filter((role) => flow.counts[role] > 0);

	// one row for each line and role. A count shows more than one reference
	const rows: preact.JSX.Element[] = [];
	const marks = [...flow.marks].sort((a, b) => a.line - b.line || a.start - b.start);
	for (let i = 0; i < marks.length;) {
		const m = marks[i];
		let count = 1;
		while (i + count < marks.length && marks[i + count].line === m.line && marks[i + count].role === m.role && !marks[i + count].finding && !m.finding) {
			count++;
		}
		rows.push(
			<button type="button" class="ref" onClick={reveal(m.line)} key={i}>
				<span class={`dot-inline c-${m.finding ? 'problem' : colorOf(m.role)}`} />
				<span class="line">{m.line}</span>
				{ROLE_LABELS[m.role][0]}{count > 1 ? ` ×${count}` : ''}
				{m.finding && <span class="problem"> {m.finding}</span>}
			</button>,
		);
		i += count;
	}

	return (
		<div class="details-body">
			<div class="flow-title">
				<span class="flow-name mono">{flow.name}</span>
				<button type="button" class="link" onClick={() => vscode.postMessage({ type: 'clearTrace' })}>Clear</button>
			</div>
			<div class="sub mono">{flow.type}</div>
			<div class="sub">{flow.storage}, line {flow.declLine}</div>
			<div class="flow-counts">{roles.map((role) => `${flow.counts[role]} ${ROLE_LABELS[role][flow.counts[role] === 1 ? 0 : 1]}`).join(', ')}</div>
			{flow.findings.map((f) => (
				<button type="button" class="link finding" onClick={reveal(f.line)}>Line {f.line}: {f.text}</button>
			))}
			{!flow.hasCfg && <p class="sub">Clang made no control flow graph for this function. So Flow Lens shows the references, but no rails.</p>}
			<div class="refs">{rows}</div>
			<div class="sub">Variables of {flow.fn}</div>
			<VariableChips flow={flow} />
		</div>
	);
}

// The text of the role of an access of a member. A definition is the declaration or an initializer of a constructor.
function memberRole(r: SideMemberRef): string {
	if (r.role === 'def') {
		return r.isDecl ? '' : 'initializer';
	}
	return ROLE_LABELS[r.role][0];
}

// The number of accesses for each role, for example "2 writes, 3 reads". The declaration is not an access.
function memberCounts(member: SideMember): string {
	const counts = new Map<string, number>();
	for (const r of member.groups.flatMap((g) => g.refs)) {
		if (!r.isDecl) {
			const role = r.role === 'def' ? 'initializer' : r.role;
			counts.set(role, (counts.get(role) ?? 0) + 1);
		}
	}
	const label = (role: string, n: number) => (role === 'initializer' ? (n === 1 ? 'initializer' : 'initializers') : ROLE_LABELS[role as SideFlowRole][n === 1 ? 0 : 1]);
	return ['initializer', ...Object.keys(ROLE_LABELS)].filter((role) => counts.has(role)).map((role) => `${counts.get(role)} ${label(role, counts.get(role)!)}`).join(', ');
}

// The details column of a data member of a class: the declaration, the counts, the race check, the accesses in each
// file with the thread and the locks, and the data members of the class
function MemberDetails({ flow, member }: { flow: SideFlow; member: SideMember }) {
	const open = (file: string, line: number, col = 0) => () => vscode.postMessage({ type: 'openPlace', file, line, col });
	const parse = (file: string) => () => vscode.postMessage({ type: 'parseMemberFile', file });
	const s = member.summary;
	const cls = member.className || member.label;
	const found = member.files.filter((f) => f.state === 'found');
	const isPartial = member.files.some((f) => f.state === 'found' || f.state === 'parsing' || f.state === 'failed');
	return (
		<div class="details-body">
			<div class="flow-title">
				<span class="flow-name mono">{flow.name}</span>
				<button type="button" class="link" onClick={() => vscode.postMessage({ type: 'clearTrace' })}>Clear</button>
			</div>
			<div class="sub mono">{flow.type}</div>
			<button type="button" class="link" title={`Open ${member.decl.name} at line ${member.decl.line}`} onClick={open(member.decl.file, member.decl.line)}>
				{member.storage}, {member.decl.name}:{member.decl.line}
			</button>
			{member.init && <div class="sub">Default value: <span class="mono">{member.init}</span></div>}
			<div class="stats">
				<span class="stat">{s.files === 1 ? '1 file' : `${s.files} files`}</span>
				<span class="stat">{s.functions === 1 ? '1 function' : `${s.functions} functions`}</span>
				<span class="stat">{s.threads}</span>
				<span class="stat">{s.locks}</span>
			</div>
			<div class="flow-counts">{memberCounts(member)}</div>
			<MemberFiles member={member} onOpen={open} onParse={parse} />
			{member.search === 'searching' && <p class="sub">Searching the project for the other source files of {cls}…</p>}
			{found.length > 1 && (
				<button type="button" class="link small" onClick={() => vscode.postMessage({ type: 'parseMemberFiles' })}>
					Parse all {found.length} other source files
				</button>
			)}
			{member.verdict && (
				<div class={`verdict ${member.verdict.kind}`}>
					<strong>{member.verdict.kind === 'race' ? 'Possible race' : isPartial ? 'No race found in the parsed files' : 'No race found'}</strong>
					<p>{member.verdict.text}</p>
					{member.verdict.places.length > 0 && (
						<span class="places">
							{member.verdict.places.map((p) => (
								<button type="button" class="link" onClick={open(p.file, p.line)}>{p.name}:{p.line}</button>
							))}
						</span>
					)}
					<p class="sub">
						The check uses the thread starts, the joins, the lock guards and the lock() calls in the parsed files. It cannot see
						a condition, for example a state, that keeps two accesses apart.
					</p>
				</div>
			)}
			{member.groups.map((g) => (
				<div class="mgroup">
					<div class="mgroup-head">
						<span class="mono">{g.name}</span>
						{g.isShown && <span class="badge k-shown">in the side view</span>}
					</div>
					{g.refs.map((r) => (
						<button type="button" class="ref mref" title={`Open ${g.name} at line ${r.line}`} onClick={open(g.file, r.line, r.col)}>
							<span class={`dot-inline c-${colorOf(r.role)}`} />
							<span class="line">{r.line}</span>
							<span class="mfn">{r.fn}</span>
							{memberRole(r) && <span class="sub">{memberRole(r)}</span>}
							{r.object && !r.isWhole && <span class="badge k-object" title={`An access through ${r.object}, not through this`}>of {r.object}</span>}
							{r.object && r.isWhole && <span class="badge k-object" title={`A change of the whole object ${r.object}, for example an assignment or a call that gets the object by reference. It can change the member`}>all of {r.object}</span>}
							{r.thread && <span class="badge k-thread" title={r.threadTitle}>{r.thread}</span>}
							{r.locks.map((l) => <span class="badge k-lock" title={`A lock guard holds ${l} here`}>{l}</span>)}
						</button>
					))}
				</div>
			))}
			<p class="sub">{memberFilesNote(member, cls, flow.name, found.length)}</p>
			{member.className && <div class="sub">Members of {cls}</div>}
			{member.className && <VariableChips flow={flow} />}
		</div>
	);
}

// The note about the files of the trace: the search, the files that are not parsed, and the files that the search
// cannot find. The search finds the files with Class::, and the files that include the header and name the member
function memberFilesNote(member: SideMember, cls: string, name: string, found: number): string {
	const what = member.className ? `${cls}:: or the header and the name ${name}` : `the header and the name ${name}`;
	const publicNote = member.access === 'public' ? ' A file that gets the header through a different header is not a part of the search.' : '';
	if (member.search === 'searching') {
		return `The trace contains the source file of the editor and its headers.${publicNote}`;
	}
	if (found > 0) {
		return `${found === 1 ? 'One other source file has' : `${found} other source files have`} ${what}. Parse ${found === 1 ? 'it' : 'them'} to add the accesses to the trace.${publicNote}`;
	}
	return `The trace has all source files of the project with ${what}.${publicNote}`;
}

// The files of a member trace as buttons: a click opens the first access in the file. A different source file of the
// class has a button that parses it
function MemberFiles({ member, onOpen, onParse }: { member: SideMember; onOpen: (file: string, line: number, col?: number) => () => void; onParse: (file: string) => () => void }) {
	return (
		<div class="mfiles" role="group" aria-label="Files of the trace">
			{member.files.map((f) => {
				if (f.state === 'trace' && f.first) {
					return (
						<button type="button" class="var" aria-pressed={f.isShown} title={`Open ${f.name} at line ${f.first.line}`} onClick={onOpen(f.file, f.first.line, f.first.col)}>
							{f.name} · {f.count}
						</button>
					);
				}
				const title = f.state === 'failed' ? f.error : `${f.name} has ${f.count} ${f.count === 1 ? 'mention' : 'mentions'} of the member`;
				return (
					<span class="mfile" title={title}>
						<span class="mono">{f.name}</span>
						{f.state === 'found' && <button type="button" class="link" onClick={onParse(f.file)}>Parse</button>}
						{f.state === 'parsing' && <span class="sub">parsing…</span>}
						{f.state === 'empty' && <span class="sub">no access</span>}
						{f.state === 'failed' && <span class="problem">failed</span>}
					</span>
				);
			})}
		</div>
	);
}

// The variables of the function as buttons. A click traces the variable. If two or more variables have the same name,
// for example in the sections of a test case, the button also shows the line of the declaration.
export function VariableChips({ flow }: { flow: SideFlow }) {
	const counts = new Map<string, number>();
	for (const v of flow.variables) {
		counts.set(v.name, (counts.get(v.name) ?? 0) + 1);
	}
	const current = flow.variables.find((v) => v.isCurrent)?.index;

	// the Flow bar shows the buttons in one row. It scrolls the button of the traced variable into view
	const box = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const chip = box.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
		if (!box.current || !chip || box.current.scrollWidth <= box.current.clientWidth) {
			return;
		}
		const outer = box.current.getBoundingClientRect();
		const inner = chip.getBoundingClientRect();
		if (inner.left < outer.left) {
			box.current.scrollLeft -= outer.left - inner.left + 8;
		} else if (inner.right > outer.right) {
			box.current.scrollLeft += inner.right - outer.right + 8;
		}
	}, [flow.file, flow.fn, current]);

	return (
		<span class="vars" role="group" aria-label="Variables of the function" ref={box}>
			{flow.variables.map((v) => (
				<button
					type="button"
					class="var mono"
					aria-pressed={v.isCurrent}
					title={`${v.type}, line ${v.declLine}`}
					onClick={() => vscode.postMessage({ type: 'traceVariable', index: v.index })}
				>
					{v.name}
					{counts.get(v.name)! > 1 && <span class="var-line">:{v.declLine}</span>}
				</button>
			))}
		</span>
	);
}
