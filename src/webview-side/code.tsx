import type { SideRow } from '../side/protocol';
import type { Decoration } from './flow';
import type { Wrap } from './wraps';

// The text of a row: the token spans, the marks of Flow Lens, and the boxes of Logic Map and Hidden C++. A part of the
// text gets the classes of its token and of its mark. A box contains the parts of its range and the boxes in its range.
// The boxes must be in the sequence of nestWraps.
export function codeParts(row: SideRow, decorations: Decoration[] | undefined, wraps: Wrap[] | undefined): (string | preact.JSX.Element)[] {
	const text = row.text;
	const points = new Set<number>([0, text.length]);
	for (let i = 0; i + 2 < row.spans.length; i += 3) {
		points.add(row.spans[i]);
		points.add(row.spans[i + 1]);
	}
	for (const d of [...(decorations ?? []), ...(wraps ?? [])]) {
		points.add(Math.min(d.start, text.length));
		points.add(Math.min(d.end, text.length));
	}
	const cuts = [...points].sort((a, b) => a - b);
	const out: (string | preact.JSX.Element)[] = [];
	let span = 0;
	let deco = 0;
	let w = 0;
	// the open boxes, the outer box first
	const open: { wrap: Wrap; children: (string | preact.JSX.Element)[] }[] = [];
	const top = () => (open.length > 0 ? open[open.length - 1].children : out);
	const close = () => {
		const box = open.pop()!;
		top().push(<span class={box.wrap.cls} data-cost={box.wrap.cost} data-detail={box.wrap.detail}>{box.children}</span>);
	};
	for (let k = 0; k + 1 < cuts.length; k++) {
		const a = cuts[k];
		const b = cuts[k + 1];
		while (span + 2 < row.spans.length && row.spans[span + 1] <= a) {
			span += 3;
		}
		while (decorations && deco < decorations.length && decorations[deco].end <= a) {
			deco++;
		}
		const style = span + 2 < row.spans.length && row.spans[span] <= a && b <= row.spans[span + 1] ? row.spans[span + 2] : -1;
		const d = decorations && deco < decorations.length && decorations[deco].start <= a && b <= decorations[deco].end ? decorations[deco] : undefined;
		const piece = text.slice(a, b);
		const cls = [style >= 0 ? `t${style}` : '', d ? d.cls : ''].filter(Boolean).join(' ');
		const part = style < 0 && !d ? piece
			: <span class={cls} data-s={style >= 0 ? style : undefined} data-mark={d ? d.mark : undefined}>{piece}</span>;
		// close the boxes that end before this part, then open the boxes that start at this part or before it
		while (open.length > 0 && open[open.length - 1].wrap.end <= a) {
			close();
		}
		while (wraps && w < wraps.length && wraps[w].start <= a) {
			if (wraps[w].end > a) {
				open.push({ wrap: wraps[w], children: [] });
			}
			w++;
		}
		top().push(part);
	}
	while (open.length > 0) {
		close();
	}
	return out;
}
