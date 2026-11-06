import * as path from 'path';
import type { IncludeModel, IncludeNode, IncludersResult } from '../engine/client';
import type { SideIncludeColor, SideIncludeNode, SideIncluders, SideIncludes } from '../side/protocol';

// Include Hierarchy: makes the data of the side view from the include hierarchy of the engine. This module does not use
// the VS Code API, so the unit tests can call it directly. Lines start at 1.

// An include that adds more than this part of the lines of the translation unit gets a strong hint
const LARGE_SHARE = 0.1;

// The groups with a fixed color. The other groups get the colors of the palette, the group with the most lines first.
const GROUP_COLORS: Record<string, SideIncludeColor> = { 'this file': 'path', 'project headers': 'read', 'C++ standard library': 'muted' };
const PALETTE: SideIncludeColor[] = ['check', 'definition', 'write', 'ripple', 'problem'];

// The hint of an include that forward declarations can replace shows the declarations if they fit, else their count
const MAX_FORWARD_HINT = 60;

export function forwardHint(text: string): string {
	if (!text.includes('\n') && text.length <= MAX_FORWARD_HINT) {
		return `→ ${text}`;
	}
	const n = text.split(';').length - 1;
	return `→ ${n} forward ${n === 1 ? 'declaration' : 'declarations'}`;
}

// For example 950, 12.3k or 1.2M
export function formatLines(n: number): string {
	if (n >= 1e6) {
		return `${(n / 1e6).toFixed(1)}M`;
	}
	if (n >= 1e3) {
		return `${(n / 1e3).toFixed(1)}k`;
	}
	return String(n);
}

// The name of a node as the directive writes it: <vector> or battery/types.hpp. A forced include of the command line
// gets the name of its file.
function nodeName(model: IncludeModel, n: IncludeNode): string {
	if (n.state === 'main') {
		return path.basename(model.files[n.file].path);
	}
	if (n.line === 0) {
		return path.basename(n.spelled.replace(/^["<]|[">]$/g, ''));
	}
	return n.spelled.startsWith('"') ? n.spelled.slice(1, -1) : n.spelled;
}

export function buildSideIncludes(model: IncludeModel, file: string): SideIncludes | null {
	const nodes = model.nodes;
	if (nodes.length === 0 || nodes[0].state !== 'main') {
		return null;
	}

	// the children, the depths and the lines of each node. A parent comes before its children, so the totals go from
	// the last node to the first
	const children = nodes.map((): number[] => []);
	const depth = nodes.map(() => 0);
	nodes.forEach((n, i) => {
		if (n.parent >= 0) {
			children[n.parent].push(i);
			depth[i] = depth[n.parent] + 1;
		}
	});
	const own = nodes.map((n) => (n.state === 'main' || n.state === 'entered' ? model.files[n.file].lines : 0));
	const total = own.slice();
	for (let i = nodes.length - 1; i > 0; i--) {
		if (nodes[i].parent >= 0) {
			total[nodes[i].parent] += total[i];
		}
	}

	// the lines of each group, and its color
	const sums = new Map<string, number>();
	nodes.forEach((n, i) => {
		if (own[i] > 0) {
			const group = model.files[n.file].group;
			sums.set(group, (sums.get(group) ?? 0) + own[i]);
		}
	});
	let next = 0;
	const groups = [...sums.entries()].sort((a, b) => b[1] - a[1]).map(([name, lines]) => ({
		name, lines, color: GROUP_COLORS[name] ?? PALETTE[next++ % PALETTE.length],
	}));
	const colorOf = new Map(groups.map((g) => [g.name, g.color]));

	const names = nodes.map((n) => nodeName(model, n));
	const sideNodes: SideIncludeNode[] = nodes.map((n, i) => {
		const group = n.file >= 0 ? model.files[n.file].group : '';
		return {
			id: i,
			parent: n.parent,
			depth: depth[i],
			children: children[i],
			name: names[i],
			path: n.file >= 0 ? model.files[n.file].path : '',
			line: n.line,
			parentPath: n.parent >= 0 ? model.files[nodes[n.parent].file].path : '',
			group,
			color: n.state === 'missing' ? 'problem' : colorOf.get(group) ?? 'muted',
			state: n.state,
			own: own[i],
			total: total[i],
			isForced: n.parent === 0 && n.line === 0,
			isOwn: !!n.isOwn,
			isUsed: n.isUsed,
			use: n.use,
			first: n.first,
			forward: n.forward,
		};
	});

	// the hints on the include lines of the file
	const top = children[0].filter((i) => nodes[i].line > 0);
	const hints: SideIncludes['hints'] = [];
	for (const i of top) {
		const n = nodes[i];
		if (n.state === 'entered') {
			const text = `+${formatLines(total[i])} ${total[i] === 1 ? 'line' : 'lines'}`;
			hints.push({ line: n.line, text, kind: total[i] / total[0] > LARGE_SHARE ? 'large' : 'cost', node: i });
			if (n.isUsed === false && !n.isOwn) {
				hints.push({ line: n.line, text: 'possibly unused', kind: 'unused', node: i });
			}
			if (n.forward?.state === 'possible') {
				hints.push({ line: n.line, text: forwardHint(n.forward.text), kind: 'forward', node: i });
			}
		} else if (n.state === 'skipped') {
			const by = n.first !== undefined ? nodes[n.first].parent : -1;
			hints.push({ line: n.line, text: `included before, by ${by > 0 ? names[by] : 'this file'}`, kind: 'skipped', node: i });
		} else if (n.state === 'missing') {
			hints.push({ line: n.line, text: 'not found', kind: 'missing', node: i });
		}
	}

	return {
		file,
		name: names[0],
		stats: {
			lines: own[0],
			total: total[0],
			includes: top.length,
			skipped: top.filter((i) => nodes[i].state === 'skipped').length,
			unused: top.filter((i) => nodes[i].isUsed === false && !nodes[i].isOwn).length,
			missing: nodes.filter((n) => n.state === 'missing').length,
			forward: top.filter((i) => nodes[i].forward?.state === 'possible').length,
		},
		groups,
		nodes: sideNodes,
		hints,
	};
}

// Included by in the compile databases: the source files that include a file. The name of a source file is its path in
// the deepest project folder that contains it, else its full path.
export function buildSideIncluders(res: IncludersResult, file: string, roots: string[]): SideIncluders {
	const folders = [...roots].sort((a, b) => b.length - a.length);
	const nameOf = (unit: string): string => {
		for (const root of folders) {
			const rel = path.relative(root, unit);
			if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
				return rel.split(path.sep).join('/');
			}
		}
		return unit;
	};
	return {
		file,
		state: 'ready',
		units: res.units.map((unit) => ({ file: unit, name: nameOf(unit) })).sort((a, b) => a.name.localeCompare(b.name)),
		unitCount: res.unitCount,
		failed: res.failed.length,
		isUnit: res.isUnit,
	};
}
