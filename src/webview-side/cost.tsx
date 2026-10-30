import { withBrackets } from '../side/names';
import type { FromSide, SideCost, SideCostMark, SideRange } from '../side/protocol';
import { vscode } from './vscode';
import type { Wrap } from './wraps';

// The layer of Hidden C++, as in the prototype of the design study: the operations that the compiler adds. Each item
// gets a mark on its code and a chip after the code of its line, in the color of its category. A hover card on a mark or a
// chip gives the detail and the button "Not useful". A connector joins the lookups of a group. The bar has a switch for
// each category, and the details column has the items of the function at the cursor.

const post = (message: FromSide) => vscode.postMessage(message);
const reveal = (line: number) => () => post({ type: 'revealLine', line });

// A chip after the code of a line: the items of one category on the line, with their full texts. Equal texts show one
// time with a count.
export interface CostChip {
	category: string;
	text: string;
	items: number[]; // indexes in cost.marks
}

// The short labels of the categories in the bar
const BAR_LABELS: Record<string, string> = {
	copy: 'Copies', move: 'Moves', conversion: 'Conversions', lifetime: 'Lifetime', destructor: 'Destructors', allocation: 'Allocations',
	lookup: 'Lookups', state: 'State',
};

export interface CostDecorations {
	wraps: Map<number, Wrap[]>;
	chips: Map<number, CostChip[]>;
}

// The marks and the chips of each line. The other lookups of a group get a mark and the chip "same lookup again".
export function costDecorations(cost: SideCost | null): CostDecorations {
	const out: CostDecorations = { wraps: new Map(), chips: new Map() };
	if (!cost) {
		return out;
	}
	const wrap = (r: SideRange, category: string, item: number) =>
		out.wraps.set(r.line, [...(out.wraps.get(r.line) ?? []), { start: r.start, end: r.end, cls: `ck cc-${category}`, cost: item }]);
	const texts = new Map<string, { line: number; chip: CostChip; counts: Map<string, number> }>();
	const chip = (line: number, category: string, text: string, item: number) => {
		const key = `${line}|${category}`;
		const entry = texts.get(key) ?? { line, chip: { category, text: '', items: [] }, counts: new Map<string, number>() };
		entry.counts.set(text, (entry.counts.get(text) ?? 0) + 1);
		if (!entry.chip.items.includes(item)) {
			entry.chip.items.push(item);
		}
		texts.set(key, entry);
	};
	cost.marks.forEach((m, i) => {
		wrap(m, m.category, i);
		chip(m.line, m.category, m.text, i);
		const count = m.related.length + 1;
		m.related.forEach((r, k) => {
			wrap(r, m.category, i);
			chip(r.line, m.category, `same lookup again (${k + 2} of ${count})`, i);
		});
	});
	const order = cost.categories.map((c) => c.id);
	for (const { line, chip: c, counts } of texts.values()) {
		c.text = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(' · ');
		out.chips.set(line, [...(out.chips.get(line) ?? []), c]);
	}
	for (const list of out.chips.values()) {
		list.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
	}
	return out;
}

// The label of a category
function labelOf(cost: SideCost, category: string): string {
	return cost.categories.find((c) => c.id === category)?.label ?? category;
}

// The switches of the categories in the bar of the lenses, with the number of items of the file in each category. A
// switch writes the setting dataflow.cost.categories. The switches stay in one row, which scrolls in a narrow side view.
export function CostGroup({ cost }: { cost: SideCost }) {
	return (
		<span class="lensgroup cats-group" role="group" aria-label="Hidden C++">
			<span class="lens-dot c-write" title="Hidden C++" />
			<span class="cats" role="group" aria-label="Categories">
				{cost.categories.map((c) => (
					<button
						type="button"
						class={`cat cc-${c.id}`}
						aria-pressed={c.enabled}
						title={`${c.label}: ${c.count} in the file${c.heuristic ? '. This category is a heuristic' : ''}`}
						onClick={() => post({ type: 'setCostCategory', id: c.id, enabled: !c.enabled })}
					>
						<span class="swatch" />{BAR_LABELS[c.id] ?? c.label}{c.heuristic ? '*' : ''} <span class="count">{c.count}</span>
					</button>
				))}
			</span>
			{cost.hidden > 0 && (
				<button type="button" class="link" onClick={() => post({ type: 'showHidden' })}
					title="Show the items that you marked as not useful">
					{cost.hidden === 1 ? '1 hidden pattern' : `${cost.hidden} hidden patterns`}: show them again
				</button>
			)}
		</span>
	);
}

// One item in a card or in the details column: the category, the line, the short text, the long text and "Not useful"
function CostItemView({ cost, item, isCard }: {
	cost: SideCost;
	item: { line: number; category: string; text: string; detail: string; pattern: string; heuristic: boolean };
	isCard?: boolean;
}) {
	return (
		<div class={`cost-item cc-${item.category}`}>
			<div class="cost-head">
				<span class="swatch" />
				{isCard
					? <span class="sub">{labelOf(cost, item.category)}, line {item.line}</span>
					: <button type="button" class="link" onClick={reveal(item.line)}>Line {item.line}</button>}
				<span class="cost-text">{item.text}</span>
			</div>
			<div class="sub cost-detail">{item.detail}</div>
			<button type="button" class="link small" title="Hide all items with this pattern in this workspace"
				onClick={() => post({ type: 'notUseful', pattern: item.pattern })}>
				Not useful
			</button>
		</div>
	);
}

// The hover card of a mark or of a chip: the items with their details. The mouse can go into the card to click
// "Not useful". The card of a group of lookups is above its first lookup, so it does not cover the connector.
export function CostCard({ cost, items, left, top, isAbove, onEnter, onLeave }: {
	cost: SideCost;
	items: number[];
	left: number;
	top: number;
	isAbove: boolean;
	onEnter: () => void;
	onLeave: () => void;
}) {
	return (
		<div class={isAbove ? 'card cost-card above' : 'card cost-card'} style={{ left: `${left}px`, top: `${top}px` }} role="dialog"
			aria-label="Hidden C++" onMouseEnter={onEnter} onMouseLeave={onLeave}>
			{items.filter((i) => i < cost.marks.length).map((i) => <CostItemView cost={cost} item={cost.marks[i]} isCard />)}
		</div>
	);
}

// The position of a range in the code: the middle of the text, and the top and the bottom of its row
export interface RangePoint {
	x: number;
	top: number;
	bottom: number;
}

// The connector of a group of lookups: a curve from each lookup to the next lookup, in the sequence of the lines
export function LookupConnector({ mark, pointOf }: { mark: SideCostMark; pointOf: (r: SideRange) => RangePoint }) {
	const points = [mark, ...mark.related].sort((a, b) => a.line - b.line || a.start - b.start).map(pointOf);
	if (points.length < 2) {
		return null;
	}
	const top = Math.min(...points.map((p) => p.top)) - 8;
	const bottom = Math.max(...points.map((p) => p.bottom)) + 8;
	const right = Math.max(...points.map((p) => p.x)) + 16;
	const parts: preact.JSX.Element[] = [];
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i];
		const b = points[i + 1];
		const y1 = a.bottom - top;
		const y2 = b.top - top;
		const bend = Math.max(6, (y2 - y1) / 2);
		parts.push(<path d={`M ${a.x} ${y1} C ${a.x} ${y1 + bend}, ${b.x} ${y2 - bend}, ${b.x} ${y2}`} pathLength={1} />);
	}
	return (
		<svg class="curves connector cc-lookup" style={{ top: `${top}px` }} width={right} height={bottom - top} aria-hidden="true">
			<g class="curve">
				{parts}
				{points.map((p) => <circle cx={p.x} cy={p.bottom - top} r={2.5} />)}
			</g>
		</svg>
	);
}

// The details column of Hidden C++: the items of the function at the cursor, in groups for the categories
export function CostDetails({ cost }: { cost: SideCost | null }) {
	if (!cost) {
		return (
			<div class="details-body">
				<p class="sub">Open a C++ file. Hidden C++ shows the copies, the conversions, the temporaries, the destructors, the allocations, the repeated lookups and the hidden state.</p>
			</div>
		);
	}
	const total = cost.categories.filter((c) => c.enabled).reduce((n, c) => n + c.count, 0);
	const groups = cost.categories.filter((c) => c.enabled)
		.map((c) => ({ category: c, items: cost.items.filter((i) => i.category === c.id) }))
		.filter((g) => g.items.length > 0);
	return (
		<div class="details-body">
			{cost.fn ? (
				<div class="flow-title">
					<span class="flow-name fn-name">Hidden C++ in <span class="mono">{withBrackets(cost.fn)}</span></span>
				</div>
			) : (
				<p>{total === 1 ? '1 item' : `${total} items`} in the file. Put the cursor in a function to see its items.</p>
			)}
			{cost.fn && cost.items.length === 0 && <div class="sub">No items in this function.</div>}
			{groups.map((g) => (
				<div class="cost-group">
					<div class={`cost-group-title cc-${g.category.id}`}>
						<span class="swatch" />{g.category.label} <span class="count">{g.items.length}</span>
						{g.category.heuristic && <span class="sub"> (heuristic)</span>}
					</div>
					{g.items.map((item) => <CostItemView cost={cost} item={item} />)}
				</div>
			))}
			{cost.hidden > 0 && (
				<div class="sub">
					{cost.hidden === 1 ? '1 pattern is hidden. ' : `${cost.hidden} patterns are hidden. `}
					<button type="button" class="link" onClick={() => post({ type: 'showHidden' })}>Show them again</button>
				</div>
			)}
		</div>
	);
}
