import * as path from 'path';
import { assignSlots, findingText, type FlowView, type LineText } from '../lenses/flow';
import type { MemberReference } from '../engine/client';
import { bodyLabel, buildMemberView, fileKey, memberLabel, memberStorage, memberSummary, runsOf, sameFile, threadOf } from '../lenses/member';
import type { TraceState } from '../state/store';
import { functionTitle } from './names';
import type { SideFlow, SideFlowTag, SideMember, SideMemberFile, SideMemberGroup } from './protocol';

// The data of Flow Lens for the side view. This module does not use the VS Code API, so the unit tests can call it.
// Lines start at 1 in the side view. Each rail gets a column. Rails that do not share a line can share a column.

// The marks, the rails, the findings and the counts of a view
function viewParts(view: FlowView): Pick<SideFlow, 'marks' | 'lanes' | 'slots' | 'findings' | 'counts'> {
	const slots = assignSlots(view.lanes, view.lanes.length);
	const from = view.marks.map((): number[] => []);
	const to = view.marks.map((): number[] => []);
	for (const [a, b] of view.edges) {
		to[a].push(b);
		from[b].push(a);
	}
	return {
		marks: view.marks.map((m, i) => ({
			line: m.line + 1, start: m.start, end: m.end, role: m.role, finding: m.finding && findingText(m.finding), from: from[i], to: to[i],
		})),
		lanes: view.lanes.map((lane, i) => ({
			slot: slots[i],
			from: lane.from + 1,
			to: lane.to + 1,
			color: lane.color,
			segments: lane.segments.map((s) => ({ from: s.from + 1, to: s.to + 1, isProblem: s.isProblem })),
			nodes: lane.nodes.map((n) => ({ ...n, line: n.line + 1 })),
		})),
		slots: slots.length > 0 ? Math.max(...slots) + 1 : 0,
		findings: view.findings.map((f) => ({ line: f.line + 1, text: f.text })),
		counts: view.counts,
	};
}

// The trace of a variable in the file of its function
export function buildSideFlow(trace: TraceState, pulse: number): SideFlow {
	const view = trace.view;
	return {
		file: trace.file,
		fn: trace.fn ? functionTitle(trace.fn, true) : '',
		name: view.name,
		type: view.type,
		storage: view.storage,
		declLine: view.declLine + 1,
		...viewParts(view),
		variables: trace.variables.map((v, index) => ({
			index, name: v.name, type: v.type, declLine: v.declLine + 1, isCurrent: index === view.varIndex,
		})),
		pulse,
		isSelected: trace.isSelected,
		hasCfg: view.hasCfg,
	};
}

// The line of the cursor gets the tag of the declaration only if it has this length or less. The tag is after the code,
// so on a longer line it can be outside of the visible area.
const TAG_LINE_MAX = 60;

// The trace of a data member in one file of the trace, or null if the file has no access. In a file other than the
// file of the declaration, a tag on one access tells the file and the line of the declaration, and the class. The tag
// goes on the access that started the trace if its line is short, else on the shortest line with an access, so that it
// stays visible. In the file of the declaration, a tag for each other file tells the number of accesses in it.
export function buildSideMemberFlow(trace: TraceState, file: string, lineText: LineText): SideFlow | null {
	const state = trace.member;
	if (!state || !state.model.refs.some((r) => sameFile(r.file, file))) {
		return null;
	}
	const model = state.model;
	const m = model.member;
	const view = buildMemberView(model, file, lineText);
	const declName = path.basename(m.decl.file);

	const tags: SideFlowTag[] = [];
	if (!sameFile(m.decl.file, file)) {
		const lines = [...new Set(view.marks.map((mark) => mark.line))];
		const isAtShort = !!state.at && sameFile(state.at.file, file) && lines.includes(state.at.line - 1)
			&& (lineText(state.at.line - 1)?.length ?? 0) <= TAG_LINE_MAX;
		const at = isAtShort ? state.at!.line - 1 : lines.sort((a, b) => (lineText(a)?.length ?? 0) - (lineText(b)?.length ?? 0) || a - b)[0];
		if (at !== undefined) {
			tags.push({
				line: at + 1,
				kind: 'decl',
				text: `${declName}:${m.decl.line} · ${memberLabel(model)}${m.init ? ` = ${m.init}` : ''}`,
				title: `${m.type} ${m.qualifiedClass ? `${m.qualifiedClass}::` : ''}${m.name}. Click to open ${declName} at line ${m.decl.line}.`,
				file: m.decl.file,
				target: m.decl.line,
				col: m.decl.col - 1,
			});
		}
	} else {
		const others = new Map<string, MemberReference[]>();
		for (const r of model.refs) {
			if (!sameFile(r.file, file)) {
				const key = fileKey(r.file);
				others.set(key, [...(others.get(key) ?? []), r]);
			}
		}
		for (const refs of others.values()) {
			const name = path.basename(refs[0].file);
			const first = refs.reduce((a, b) => (b.line < a.line ? b : a));
			tags.push({
				line: m.decl.line,
				kind: 'file',
				text: `${refs.length} ${refs.length === 1 ? 'access' : 'accesses'} in ${name}`,
				title: `Click to open ${name} at line ${first.line}.`,
				file: first.file,
				target: first.line,
				col: first.col - 1,
			});
		}
	}

	// the accesses in each file. The file of the declaration comes first, then the files in the sequence of the engine
	const groups: SideMemberGroup[] = [];
	const order = [m.decl.file, ...model.refs.map((r) => r.file)];
	for (const f of order) {
		if (groups.some((g) => sameFile(g.file, f))) {
			continue;
		}
		const refs = model.refs.filter((r) => sameFile(r.file, f)).sort((a, b) => a.line - b.line || a.col - b.col);
		if (refs.length === 0) {
			continue;
		}
		groups.push({
			file: f,
			name: path.basename(f),
			isShown: sameFile(f, file),
			refs: refs.map((r) => {
				const thread = threadOf(model, r.fn);
				const runs = r.fn >= 0 ? runsOf(model, r) : [];

				// a function that more than one thread calls: each thread of the runs. a lock that each caller holds on
				// the way to the access also protects it
				const labels = [...new Set(runs.map((x) => (x.thread < 0 ? 'caller' : model.threads[x.thread].via)))];
				const isMany = labels.length > 1;
				const onTheWay = runs.length > 0 ? runs[0].locks.filter((l) => runs.every((x) => x.locks.includes(l))) : [];
				return {
					line: r.line, col: r.col - 1, role: r.role, fn: bodyLabel(model, r.fn), isDecl: r.fn < 0,
					thread: isMany ? labels.join(', ') : thread?.label,
					threadTitle: isMany ? `Runs on more than one thread: ${labels.join(', ')}.` : thread?.title,
					locks: [...new Set([...(r.locks ?? []), ...onTheWay])], object: r.object, ...(r.whole ? { isWhole: true } : {}),
				};
			}),
		});
	}

	// the files of the trace, with the first access of each file, then the other source files of the class
	const files: SideMemberFile[] = [];
	for (const g of groups) {
		const first = g.refs.find((r) => !r.isDecl) ?? g.refs[0];
		files.push({ file: g.file, name: g.name, state: 'trace', count: g.refs.length, isShown: g.isShown, first: { line: first.line, col: first.col } });
	}
	for (const o of state.others ?? []) {
		if (files.some((f) => sameFile(f.file, o.file))) {
			continue;
		}
		const fileState = o.state === 'parsed' ? 'empty' : o.state;
		files.push({ file: o.file, name: path.basename(o.file), state: fileState, count: o.mentions, isShown: sameFile(o.file, file), error: o.error });
	}

	const summary = memberSummary(model);
	const member: SideMember = {
		className: m.className,
		qualifiedClass: m.qualifiedClass,
		label: memberLabel(model),
		storage: memberStorage(model),
		access: m.access,
		isAtomic: m.isAtomic,
		init: m.init,
		decl: { file: m.decl.file, name: declName, line: m.decl.line },
		files,
		search: state.others ? 'done' : 'searching',
		groups,
		summary: { files: summary.files, functions: summary.functions, threads: summary.threads, locks: summary.locks },
		verdict: summary.verdict && {
			kind: summary.verdict.kind,
			text: summary.verdict.text,
			places: summary.verdict.places.map((p) => ({ ...p, name: path.basename(p.file) })),
		},
	};

	return {
		file,
		fn: m.qualifiedClass,
		name: m.name,
		type: m.type,
		storage: memberStorage(model),
		declLine: m.decl.line,
		...viewParts(view),
		variables: model.fields.map((f, index) => ({ index, name: f.name, type: f.type, declLine: f.line, isCurrent: f.name === m.name })),
		pulse: trace.pulse,
		isSelected: trace.isSelected,
		hasCfg: true,
		tags,
		member,
	};
}
