import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { activeGuide, ActiveGuide, GuideText, indentGuides } from '../side/guides';
import type {
	SideCalls, SideCardKind, SideCost, SideFlow, SideFlowColor, SideFlowMark, SideFlowTag, SideIncludes, SideLogic, SideModel, SideNoteKind,
	SideRange, SideRipple, SideRow, SideSettings, SideThreadItem, SideThreads, SideWhy,
} from '../side/protocol';
import { CallHint, callHints } from './calls';
import { codeParts } from './code';
import { CostCard, CostChip, costDecorations, LookupConnector, RangePoint } from './cost';
import { Decoration, FlowCard, FlowCurves, flowDecorations, FlowLane, laneWidth, MarkPoint } from './flow';
import { chipText, chipTitle, type DiffChip, type WalkMarks } from './guide';
import { lexSpans } from '../side/model';
import { IncludeHint, includeHints } from './includes';
import { LogicHint, logicDecorations, WhyCard } from './logic';
import { commentClass, DetailCard, detailBoxes, DetailMark, ModelBarMark, ModelTag, modelDecorations } from './model';
import { rippleDecorations } from './ripple';
import { ThreadHint, threadDecorations } from './threads';
import { vscode } from './vscode';
import { nestWraps, Wrap } from './wraps';

// The code of the file with virtual rows: the view renders only the visible rows and a margin. Each line of the file
// is one row with no wrap, so the scroll sync can use line numbers.

// The rows above and below the visible rows
const OVERSCAN = 12;
// The mouse must stay this time on a line number before the card "Why does this line run" opens
const WHY_DELAY_MS = 250;
// The distance in px between the bars of two levels of blocks of a model, beside the line numbers
const BAR_STEP = 5;
// The width of the symbol of a detail of a model at the end of a line in px, as .detail-mark gives it
const DETAIL_MARK_PX = 16;

export interface CodeViewProps {
	file?: string;
	rows: (SideRow | undefined)[];
	inactive?: [number, number][]; // the ranges of lines that a condition of the preprocessor skips, as #if 0
	lineCount: number;
	maxColumns: number; // the longest line, with the tabs expanded
	settings: SideSettings;
	cursor?: number;
	cardAt?: { line: number; col: number; seq: number }; // the position of the command "Show Card at Cursor"
	scrollTo?: { line: number; seq: number }; // a scroll from the extension. seq changes for each scroll
	flow: SideFlow | null;
	logic: SideLogic | null;
	cost: SideCost | null;
	includes: SideIncludes | null;
	calls: SideCalls | null;
	threads: SideThreads | null;
	threadItem?: SideThreadItem; // the selected item of Threads and races
	ripple: SideRipple | null;
	model: SideModel | null; // the blocks and the notes of a language model
	guideLines?: { first: number; last: number; label: string; isWalk: boolean }; // the lines of the current step of a guide
	diff?: WalkMarks; // the marks of a diff walk in the file: the added and the removed lines
	why?: SideWhy; // the last answer to the question why a line runs
	stepLine?: number; // the line of a step of the path: the step of "Play path", or the step under the mouse
	reveal?: { line: number; seq: number }; // the view scrolls to the line if it is not visible. seq changes for each step
	center?: { line: number; seq: number }; // a line from the extension for the middle part of the view. seq changes for each line
	isFlowOn: boolean;
	animate: boolean;
	traceable: Set<number>; // the style indices of variables and parameters
	callable: Set<number>; // the style indices of functions and methods
	typeNames: Set<number>; // the style indices of classes, enums and type aliases
	navigable: Set<number>; // the style indices of names: Ctrl+click goes to their definition
	includeFile: number; // the style index of a string: on an #include line, the file of the include
	onContextPoint: (x: number, y: number) => void; // the place of a click of the menu, in the window
	onGoToDefinition: (line: number, col: number, isCallable: boolean) => void; // Ctrl+click on a name. col is a UTF-16 column from 0
	onHistory: (isBack: boolean) => void; // the mouse buttons Back and Forward
	onScroll: (line: number) => void; // the user scrolled. line is the first visible line
	onSelect: (line: number, col: number) => void; // the user clicked a position
	onSelectRange: (range: { line: number; col: number; endLine: number; endCol: number }) => void; // the user selected code
	onTrace: (line: number, col: number) => void; // the user clicked a variable
	onIncludeHint: (node: number) => void; // the user clicked a hint of Include Hierarchy
	onCallHint: (fn: number) => void; // the user clicked a hint of Call Hierarchy. fn is the called function
	onThreadHint: () => void; // the user clicked a tag of Threads and races
	onModelTag: (block?: string) => void; // the user clicked a title or a note of the model
	onRendered: (rows: number) => void; // called after each render, for the time of the render
}

// The place of a line in the current step of a guided review, for the border around the lines of the step
function reviewStepOf(lines: { first: number; last: number } | undefined, line: number): RowProps['reviewStep'] {
	if (!lines || line < lines.first || line > lines.last) {
		return undefined;
	}
	return lines.first === lines.last ? 'only' : line === lines.first ? 'first' : line === lines.last ? 'last' : 'mid';
}

interface RowProps {
	line: number;
	row?: SideRow;
	isCursor: boolean;
	guides: number;
	active?: ActiveGuide;
	settings: SideSettings;
	flow: SideFlow | null;
	decorations?: Decoration[];
	wraps?: Wrap[];
	hints?: string[];
	flowTags?: SideFlowTag[];
	logicHints?: LogicHint[];
	endsWidth: number; // the width of the full hints at the end of the row in px: the hints of Flow Lens and Logic Map
	isShortEnds: boolean; // the full hints at the end of the row go over the code, so the row shows a dot for them
	onEndsFocus: (el: HTMLElement | null) => void; // the dot got or lost the focus of the keyboard
	detailMarks?: DetailMark[]; // the symbols of the details of a model whose code starts on the line
	onDetailFocus: (el: HTMLElement | null) => void; // a symbol of a detail got or lost the focus of the keyboard
	chips?: CostChip[];
	includeHints?: IncludeHint[];
	onIncludeHint: (node: number) => void;
	callHints?: CallHint[];
	onCallHint: (fn: number) => void;
	threadLane?: 'worker' | 'both'; // the line runs on a worker thread
	threadHints?: ThreadHint[];
	onThreadHint: () => void;
	ripple?: string; // the classes of the line for Change Ripple
	rippleHints?: string[];
	modelBars?: ModelBarMark[]; // the bars of the blocks of the model on the line, one for each level
	noteKind?: SideNoteKind; // the color of a range that the model highlighted
	modelTags?: ModelTag[];
	onModelTag: (block?: string) => void;
	animate: boolean;
	isDim: boolean; // the traced variable is selected, and the line has no reference of it
	isInactive: boolean; // a condition of the preprocessor skips the line
	isPathStep: boolean; // the line of a step of the path of Logic Map
	isStep: boolean; // the line of the current step of the path
	reviewStep?: 'first' | 'mid' | 'last' | 'only'; // the line is in the current step of a guide
	reviewTag?: string; // the step of a guide, on its first line
	isWalk: boolean; // the guide is a diff walk
	diffClass?: string; // the classes of a diff walk: an added line, or a line after removed lines
	diffChip?: DiffChip; // the removed lines of the current step of a diff walk at the line
	onChipFocus: (el: HTMLElement | null) => void; // the chip of removed lines got or lost the focus of the keyboard
	lead?: SideFlowColor; // the color of the guide line from the dot to the first reference
	leadY: number;
}

function Row(props: RowProps) {
	const { line, row, settings, flow } = props;
	const parts: (string | preact.JSX.Element)[] = [];
	// the indent guides, at the start of each level of indent
	for (let level = 1; level <= props.guides; level++) {
		const active = props.active;
		const isActive = !!active && active.first <= line && line <= active.last && level === active.level;
		parts.push(
			<span
				class={isActive ? `guide lvl-${(level - 1) % 30} active` : `guide lvl-${(level - 1) % 30}`}
				style={{ left: `calc(${(level - 1) * settings.indentSize} * (1ch + ${settings.letterSpacing}px))` }}
			/>,
		);
	}
	if (row) {
		parts.push(...codeParts(row, props.decorations, props.wraps));
	}
	// the lane with the rails of Flow Lens, next to the code
	const width = laneWidth(flow);
	const classes = `row${props.isCursor ? ' cursor' : ''}${props.isDim ? ' dim' : ''}${props.isInactive ? ' inactive' : ''}${
		props.isPathStep ? ' path-step' : ''}${props.isStep ? ' step' : ''}${
		props.ripple ? ` ${props.ripple}` : ''}${props.threadLane ? ` lane-${props.threadLane}` : ''}${
		props.noteKind ? ` note-${props.noteKind}` : ''}${props.reviewStep ? ` rg-line rg-${props.reviewStep}${props.isWalk ? ' rg-walk' : ''}` : ''}${
		props.diffClass ? ` ${props.diffClass}` : ''}`;
	const shortTexts = props.isShortEnds ? endTexts(props.hints, props.logicHints) : [];
	return (
		<div class={classes} data-line={line}>
			<span class="ln">
				{props.modelBars?.map((b) => <span class={`mbar lv-${Math.min(b.level, 4)}${b.isFirst ? ' first' : ''}${b.isLast ? ' last' : ''}`} />)}
				{line}
			</span>
			{flow && width > 0 && (
				<span class="lane" aria-hidden="true">
					<svg width={width} height={settings.rowHeight} viewBox={`0 0 ${width} ${settings.rowHeight}`}>
						<FlowLane flow={flow} line={line} rowHeight={settings.rowHeight} animate={props.animate} lead={props.lead} leadY={props.leadY} />
					</svg>
				</span>
			)}
			<span class="code">{parts}</span>
			{(props.reviewTag || props.diffChip || props.modelTags || props.flowTags || props.includeHints || props.callHints || props.threadHints || props.chips
				|| props.rippleHints) && (
				<span class="tags">
					{props.reviewTag && <span class="hint rg-tag"><span class="rg-pill">{props.isWalk ? 'diff' : 'review'}</span>{props.reviewTag}</span>}
					{props.diffChip && (
						<button type="button" class="hint df-chip" data-del-line={line} aria-label={`${chipTitle(props.diffChip)}: ${props.diffChip.texts.join('\n')}`}
							onFocus={(e) => props.onChipFocus(e.currentTarget as HTMLElement)} onBlur={() => props.onChipFocus(null)}>
							{chipText(props.diffChip)}
						</button>
					)}
					{props.modelTags?.map((t) => (t.kind === 'comment' ? (
						<button type="button" class={`hint model-tag k-comment${commentClass(t.color)}`} title={t.title} onClick={() => props.onModelTag(t.block)}>
							{t.text}
						</button>
					) : (
						<button type="button" class={`hint model-tag k-${t.kind}`} title={t.title} onClick={() => props.onModelTag(t.block)}>
							<span class="mpill">model</span>{t.text}
						</button>
					)))}
					{props.threadHints?.map((h) => (
						<button type="button" class={`hint thread-hint k-${h.kind}`} title={h.title} onClick={props.onThreadHint}>{h.text}</button>
					))}
					{props.callHints?.map((h) => (
						<button type="button" class={`hint call-hint k-${h.kind}`} title={h.title} onClick={() => props.onCallHint(h.to)}>{h.text}</button>
					))}
					{props.includeHints?.map((h) => (
						<button type="button" class={`hint inc-hint k-${h.kind}`} title="Show the include in Include Hierarchy" onClick={() => props.onIncludeHint(h.node)}>
							{h.text}
						</button>
					))}
					{props.flowTags?.map((t) => (
						<button
							type="button"
							class={`hint flow-tag k-${t.kind}`}
							title={t.title}
							onClick={() => vscode.postMessage({ type: 'openPlace', file: t.file, line: t.target, col: t.col })}
						>
							{t.text}
						</button>
					))}
					{props.chips?.map((c) => <span class={`hint cost-chip cc-${c.category}`} data-items={c.items.join(',')}>{c.text}</span>)}
					{props.rippleHints?.map((h) => <span class="hint ripple">{h}</span>)}
				</span>
			)}
			{(props.hints || props.logicHints || props.detailMarks) && (
				<span class={props.isShortEnds ? 'ends short' : 'ends'} data-width={props.endsWidth}>
					{props.isShortEnds ? (shortTexts.length > 0 && (
						<button
							type="button"
							class="hint end-mark"
							aria-label={shortTexts.join('\n')}
							onFocus={(e) => props.onEndsFocus(e.currentTarget as HTMLElement)}
							onBlur={() => props.onEndsFocus(null)}
						>
							<span class="end-dot" aria-hidden="true" />
							{shortTexts.length > 1 ? shortTexts.length : ''}
						</button>
					)) : (
						<>
							{props.hints?.map((h) => <span class="hint problem" title={h}>{h}</span>)}
							{props.logicHints?.map((h) => <span class={`hint ${h.kind}`} title={h.text}>{h.text}</span>)}
						</>
					)}
					{props.detailMarks?.map((d) => (
						<button type="button" class="hint detail-mark" data-detail-mark={d.id} aria-label={`Detail of the model: ${d.title}`}
							onFocus={(e) => props.onDetailFocus(e.currentTarget as HTMLElement)} onBlur={() => props.onDetailFocus(null)}>
							i
						</button>
					))}
				</span>
			)}
		</div>
	);
}

// The texts of the hints at the end of a row: the warnings of Flow Lens and of Logic Map
function endTexts(hints?: string[], logicHints?: LogicHint[]): string[] {
	return [...(hints ?? []), ...(logicHints ?? []).map((h) => h.text)];
}

// The card of the dot at the end of a long line: the full hints. It is right-aligned with the dot
function EndsCard(props: { texts: string[]; right: number; top: number; isAbove: boolean; onEnter: () => void; onLeave: () => void }) {
	return (
		<div class={props.isAbove ? 'card ends-card above' : 'card ends-card'} role="tooltip"
			style={{ right: `${props.right}px`, top: `${props.top}px` }} onMouseEnter={props.onEnter} onMouseLeave={props.onLeave}>
			{props.texts.map((t) => <div class="ends-item">{t}</div>)}
		</div>
	);
}

// The card of a chip of removed lines of a diff walk: the removed lines with the tokens of the lexer. The card starts at
// the left edge of the chip. If its right edge is outside of the visible part of the view, it moves to the left
function RemovedCard(props: {
	chip: DiffChip; left: number; top: number; isAbove: boolean; minLeft: number; maxRight: number; onEnter: () => void; onLeave: () => void;
}) {
	const { chip } = props;
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (el && props.left + el.offsetWidth > props.maxRight) {
			el.style.left = `${Math.max(props.minLeft, props.maxRight - el.offsetWidth)}px`;
		}
	});
	return (
		<div ref={ref} class={props.isAbove ? 'card df-card above' : 'card df-card'} role="tooltip" style={{ left: `${props.left}px`, top: `${props.top}px` }}
			onMouseEnter={props.onEnter} onMouseLeave={props.onLeave}>
			<div class="card-title">{chipTitle(chip)}</div>
			<div class="df-card-rows">
				{chip.texts.map((t) => <div class="df-card-row">{codeParts({ line: 0, text: t, spans: lexSpans(t) }, undefined, undefined)}</div>)}
				{chip.count > chip.texts.length && <div class="df-card-more">{`⋯ ${chip.count - chip.texts.length} more lines`}</div>}
			</div>
		</div>
	);
}

// The visual column of a UTF-16 column, with each tab to the next tab stop
function visualColumn(text: string, col: number, tabSize: number): number {
	let out = 0;
	for (let i = 0; i < Math.min(col, text.length); i++) {
		out = text[i] === '\t' ? out + tabSize - (out % tabSize) : out + 1;
	}
	return out;
}

export function CodeView(props: CodeViewProps) {
	const { rows, lineCount, settings, flow, logic, cost } = props;
	const rowHeight = settings.rowHeight;
	const scroller = useRef<HTMLDivElement>(null);
	const spacer = useRef<HTMLDivElement>(null);
	const measure = useRef<HTMLSpanElement>(null);
	const probe = useRef<HTMLDivElement>(null);
	const [top, setTop] = useState(0);
	const [height, setHeight] = useState(0);
	const [charWidth, setCharWidth] = useState(8);
	const [leadY, setLeadY] = useState(rowHeight - 2);
	const [hover, setHover] = useState<{ mark: number; left: number; top: number } | undefined>(undefined);
	const [whyAt, setWhyAt] = useState<{ line: number; left: number; top: number } | undefined>(undefined);
	const whyTimer = useRef(0);
	const whyClose = useRef(0);
	const [costAt, setCostAt] = useState<{ key: string; items: number[]; left: number; top: number; isAbove: boolean } | undefined>(undefined);
	const costClose = useRef(0);
	// the card of a detail of a model, which the symbol of the detail at the end of its line opens
	const [detailAt, setDetailAt] = useState<{ id: string; left: number; top: number; isAbove: boolean } | undefined>(undefined);
	const detailClose = useRef(0);
	// the lines with a dot for the hints at the end of the row, and the card of a dot
	const [shortEnds, setShortEnds] = useState<ReadonlySet<number>>(() => new Set());
	const shortEndsRef = useRef(shortEnds);
	const reportedWidth = useRef(0); // the width of the view in the last message, for the tests
	const [endsAt, setEndsAt] = useState<{ line: number; right: number; top: number; isAbove: boolean } | undefined>(undefined);
	const endsClose = useRef(0);
	// the card of the removed lines of a diff walk, which the chip of the removed lines opens
	const [chipAt, setChipAt] = useState<{ line: number; left: number; top: number; isAbove: boolean; minLeft: number; maxRight: number } | undefined>(undefined);
	const chipClose = useRef(0);
	const expectedTop = useRef<number | undefined>(undefined); // the scroll position after the last scroll from the extension
	const reportedLine = useRef(0);
	const frame = useRef(0);

	// On a long line, the full hints at the end of the row stay at the right edge of the view, over the code. Such a row
	// shows a dot at the right edge, and the card of the dot shows the full hints. The place of the full hints after the
	// code and their width do not change with the form, so the form does not change again after a render. The function
	// uses only refs, because the observer of the size keeps the function of the first render
	const updateShortEnds = () => {
		const el = scroller.current;
		if (!el) {
			return;
		}
		const right = el.getBoundingClientRect().left + el.clientWidth;
		const next = new Set<number>();
		el.querySelectorAll<HTMLElement>('.rows > .row > .ends').forEach((ends) => {
			const before = ends.previousElementSibling;
			const margin = parseFloat(getComputedStyle(ends).marginLeft) || 0;
			if (before && before.getBoundingClientRect().right + margin + Number(ends.dataset.width) > right) {
				next.add(Number((ends.parentElement as HTMLElement).dataset.line));
			}
		});
		const old = shortEndsRef.current;
		const isNew = next.size !== old.size || [...next].some((line) => !old.has(line));
		if (isNew) {
			shortEndsRef.current = next;
			setShortEnds(next);
		}
		if (isNew || el.clientWidth !== reportedWidth.current) {
			reportedWidth.current = el.clientWidth;
			vscode.postMessage({ type: 'shortEnds', lines: [...next].sort((a, b) => a - b), width: el.clientWidth });
		}
	};
	useLayoutEffect(updateShortEnds);

	useLayoutEffect(() => {
		const el = scroller.current!;
		const observer = new ResizeObserver(() => {
			setHeight(el.clientHeight);
			updateShortEnds();
		});
		observer.observe(el);
		setHeight(el.clientHeight);
		return () => observer.disconnect();
	}, []);

	// the width of one character of the editor font, with the letter spacing. The bottom edge of a mark in a row, for
	// the guide lines: the middle of the last pixel row of the mark
	useLayoutEffect(() => {
		const el = measure.current;
		if (el) {
			setCharWidth(el.getBoundingClientRect().width / 10);
		}
		const mark = probe.current?.querySelector('.mk');
		if (probe.current && mark) {
			setLeadY(mark.getBoundingClientRect().bottom - probe.current.getBoundingClientRect().top - 0.5);
		}
	}, [settings.letterSpacing, settings.rowHeight]);

	// A scroll from the extension. The scroll event that it causes is not a scroll of the user.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el || !props.scrollTo) {
			return;
		}
		el.scrollTop = (props.scrollTo.line - 1) * rowHeight;
		expectedTop.current = el.scrollTop;
		reportedLine.current = props.scrollTo.line;
		setTop(el.scrollTop);
	}, [props.scrollTo?.seq, rowHeight, props.file]);

	useEffect(() => () => {
		cancelAnimationFrame(frame.current);
		clearTimeout(whyTimer.current);
		clearTimeout(whyClose.current);
		clearTimeout(costClose.current);
		clearTimeout(endsClose.current);
		clearTimeout(detailClose.current);
		clearTimeout(chipClose.current);
	}, []);

	// a new trace removes the card of the old trace. A new file removes the card of a line. New items of Hidden C++
	// remove the card of the old items. New hints remove the card of a dot
	useEffect(() => setHover(undefined), [flow]);
	useEffect(() => setWhyAt(undefined), [props.file, logic?.fn]);
	useEffect(() => setCostAt(undefined), [cost]);
	useEffect(() => setEndsAt(undefined), [props.file, flow, logic]);
	useEffect(() => setChipAt(undefined), [props.file, props.diff]);

	// A step of "Play path", or a place that the extension shows with no text editor: if its line is not in the middle
	// part of the view, the view scrolls the line to the middle. This scroll is a scroll of the user, so a text editor
	// follows.
	const toMiddle = (line: number | undefined) => {
		const el = scroller.current;
		if (!el || !line) {
			return;
		}
		const y = (line - 1) * rowHeight;
		if (y < el.scrollTop + el.clientHeight * 0.15 || y + rowHeight > el.scrollTop + el.clientHeight * 0.85) {
			el.scrollTop = Math.max(0, y - el.clientHeight / 2);
		}
	};
	useLayoutEffect(() => toMiddle(props.reveal?.line), [props.reveal?.seq]);
	useLayoutEffect(() => toMiddle(props.center?.line), [props.center?.seq]);

	// A maximum of one update and one message for each frame
	const onScroll = () => {
		cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => {
			const el = scroller.current;
			if (!el) {
				return;
			}
			setTop(el.scrollTop);
			updateShortEnds(); // a scroll to the right can give the hints of a long line the space after the code
			if (expectedTop.current !== undefined && Math.abs(el.scrollTop - expectedTop.current) < 1) {
				return;
			}
			expectedTop.current = undefined;
			const line = Math.min(Math.max(1, lineCount), Math.round(el.scrollTop / rowHeight) + 1);
			if (line !== reportedLine.current) {
				reportedLine.current = line;
				props.onScroll(line);
			}
		});
	};

	// The column of a point in the text of a row, from the text nodes before the point
	const columnAt = (rowEl: HTMLElement, x: number, y: number): number => {
		const code = rowEl.querySelector('.code');
		const range = document.caretRangeFromPoint(x, y);
		if (!code || !range || !code.contains(range.startContainer)) {
			return 0;
		}
		const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
		let col = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node === range.startContainer) {
				return col + range.startOffset;
			}
			col += node.textContent?.length ?? 0;
		}
		return col;
	};

	// An end of a selection in the code: its line, and its UTF-16 column from 0. An end in a line number is the start of
	// its line, and an end after the code, for example in a hint, is the end of its line
	const selectionEnd = (node: Node, offset: number): { line: number; col: number } | undefined => {
		const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
		const rowEl = el?.closest('.rows > .row') as HTMLElement | null;
		const line = Number(rowEl?.dataset.line);
		if (!rowEl || !(line > 0)) {
			return undefined;
		}
		const length = rows[line - 1]?.text.length ?? 0;
		const code = rowEl.querySelector('.code');
		if (code && code.contains(node)) {
			const range = document.createRange();
			range.setStart(code, 0);
			range.setEnd(node, offset);
			return { line, col: Math.min(length, range.toString().length) };
		}
		if (node === rowEl) {
			const codeIndex = [...rowEl.childNodes].findIndex((c) => (c as Element).classList?.contains('code'));
			return { line, col: offset <= codeIndex ? 0 : length };
		}
		return { line, col: rowEl.querySelector('.ln')?.contains(node) ? 0 : length };
	};

	// The menu of the name of a function gets "Show Calls", and the menu of the name of a class, an enum or a type alias
	// gets "Outline", with the place of the name. VS Code reads the data-vscode-context of the element of the click and of
	// its parents after this handler, so the handler sets the place here
	const onContextMenu = (e: MouseEvent) => {
		const el = scroller.current;
		if (!el) {
			return;
		}
		const target = e.target as HTMLElement;
		const token = target.closest('[data-s]') as HTMLElement | null;
		const rowEl = target.closest('.rows > .row') as HTMLElement | null;
		const line = Number(rowEl?.dataset.line);
		const style = Number(token?.dataset.s);
		const isName = !!token && !!rowEl && line > 0;
		const kind = isName && props.callable.has(style) ? 'dataflowCallable' : isName && props.typeNames.has(style) ? 'dataflowType' : undefined;
		el.dataset.vscodeContext = JSON.stringify(kind ? { [kind]: true, line, col: columnAt(rowEl!, e.clientX, e.clientY) } : {});
		props.onContextPoint(e.clientX, e.clientY);
	};

	// The key for "go to definition" with the mouse, as in the text editor: Ctrl (Cmd on macOS), or Alt if the key for more
	// cursors is Ctrl. The handlers of the window read the current props through the ref
	const goto = useRef({ key: settings.gotoKey, navigable: props.navigable, includeFile: props.includeFile, rows });
	goto.current = { key: settings.gotoKey, navigable: props.navigable, includeFile: props.includeFile, rows };
	const isGotoKey = (e: MouseEvent | KeyboardEvent) => {
		const key = goto.current.key;
		return key === 'alt' ? e.altKey : key === 'meta' ? e.metaKey : e.ctrlKey;
	};

	// The token that Ctrl+click goes from: a name, or the file of an #include. Undefined for other text
	const gotoTarget = (target: EventTarget | null): { el: HTMLElement; rowEl: HTMLElement; line: number; style: number } | undefined => {
		const el = target instanceof Element ? target.closest('[data-s]') as HTMLElement | null : null;
		const rowEl = el?.closest('.rows > .row') as HTMLElement | null;
		const line = Number(rowEl?.dataset.line);
		if (!el || !rowEl || !(line > 0) || !el.closest('.code')) {
			return undefined;
		}
		const { navigable, includeFile, rows: lines } = goto.current;
		const style = Number(el.dataset.s);
		const isInclude = style === includeFile && /^\s*#\s*(include|import)\b/.test(lines[line - 1]?.text ?? '');
		return navigable.has(style) || isInclude ? { el, rowEl, line, style } : undefined;
	};

	// While the key is down, the name under the mouse gets an underline and a hand pointer, as a link in the text editor
	const linkEl = useRef<HTMLElement | null>(null);
	const mouseAt = useRef<{ x: number; y: number } | undefined>(undefined);
	const setLink = (el: HTMLElement | null) => {
		if (linkEl.current !== el) {
			linkEl.current?.classList.remove('goto-link');
			el?.classList.add('goto-link');
			linkEl.current = el;
		}
	};
	const onMouseMove = (e: MouseEvent) => {
		mouseAt.current = { x: e.clientX, y: e.clientY };
		setLink(isGotoKey(e) ? gotoTarget(e.target)?.el ?? null : null);
	};
	const onMouseLeave = () => {
		mouseAt.current = undefined;
		setLink(null);
	};
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const at = mouseAt.current;
			setLink(at && isGotoKey(e) ? gotoTarget(document.elementFromPoint(at.x, at.y))?.el ?? null : null);
		};
		const onBlur = () => setLink(null);
		window.addEventListener('keydown', onKey);
		window.addEventListener('keyup', onKey);
		window.addEventListener('blur', onBlur);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('keyup', onKey);
			window.removeEventListener('blur', onBlur);
		};
	}, []);

	// A mouse down with the key on a name starts no text selection
	const onMouseDown = (e: MouseEvent) => {
		if (e.button === 0 && isGotoKey(e) && gotoTarget(e.target)) {
			e.preventDefault();
		}
	};

	// A click moves the cursor of the text editor. A click on a variable also traces it. A selection of code goes to the
	// extension, for the text editor and for the MCP server. A click in a card does nothing. Ctrl+click on a name goes to
	// its definition. The mouse buttons Back and Forward go through the places of these jumps
	const onMouseUp = (e: MouseEvent) => {
		if (e.button === 3 || e.button === 4) {
			e.preventDefault();
			props.onHistory(e.button === 3);
			return;
		}
		if (e.button === 0 && isGotoKey(e)) {
			const at = gotoTarget(e.target);
			if (at) {
				setLink(null);
				// a list of more than one definition shows near the click
				props.onContextPoint(e.clientX, e.clientY);
				props.onGoToDefinition(at.line, columnAt(at.rowEl, e.clientX, e.clientY), props.callable.has(at.style));
				return;
			}
		}
		const selection = window.getSelection();
		const target = e.target as HTMLElement;
		if (e.button === 0 && !target.closest('.card') && selection && !selection.isCollapsed && selection.rangeCount > 0) {
			const range = selection.getRangeAt(0);
			const a = selectionEnd(range.startContainer, range.startOffset);
			const b = selectionEnd(range.endContainer, range.endOffset);
			if (a && b && (a.line < b.line || (a.line === b.line && a.col < b.col))) {
				props.onSelectRange({ line: a.line, col: a.col, endLine: b.line, endCol: b.col });
			}
			return;
		}
		if (e.button !== 0 || (selection && !selection.isCollapsed) || target.closest('.card') || target.closest('.flow-tag')
			|| target.closest('.inc-hint') || target.closest('.call-hint') || target.closest('.thread-hint') || target.closest('.model-tag')
			|| target.closest('.end-mark')) {
			return;
		}
		const rowEl = target.closest('.row') as HTMLElement | null;
		const line = Number(rowEl?.dataset.line);
		if (!rowEl || !(line > 0)) {
			return;
		}
		const col = columnAt(rowEl, e.clientX, e.clientY);
		const token = target.closest('[data-s]') as HTMLElement | null;
		if (props.isFlowOn && (target.closest('[data-mark]') || (token && props.traceable.has(Number(token.dataset.s))))) {
			props.onTrace(line, col);
		} else {
			props.onSelect(line, col);
		}
	};

	// The card "Why does this line run" closes a short time after the mouse goes out of the line number or the card
	const closeWhy = () => {
		clearTimeout(whyTimer.current);
		clearTimeout(whyClose.current);
		whyClose.current = window.setTimeout(() => setWhyAt(undefined), 200);
	};
	const keepWhy = () => clearTimeout(whyClose.current);
	// The card of Hidden C++ closes in the same way
	const closeCost = () => {
		clearTimeout(costClose.current);
		costClose.current = window.setTimeout(() => setCostAt(undefined), 200);
	};
	const keepCost = () => clearTimeout(costClose.current);
	// The card of a detail closes in the same way
	const closeDetail = () => {
		clearTimeout(detailClose.current);
		detailClose.current = window.setTimeout(() => setDetailAt(undefined), 200);
	};
	const keepDetail = () => clearTimeout(detailClose.current);

	// The card of a detail: below its symbol at the end of the line, or above it in the lower part of the view. The right
	// edge of the card is near the symbol, and the card stays in the visible part of the view
	const showDetailCard = (el: HTMLElement) => {
		const scrollEl = scroller.current;
		const id = el.dataset.detailMark;
		if (!spacer.current || !scrollEl || !id) {
			return;
		}
		keepDetail();
		if (detailAt?.id === id) {
			return;
		}
		const rect = el.getBoundingClientRect();
		const base = spacer.current.getBoundingClientRect();
		const view = scrollEl.getBoundingClientRect();
		// the card is a maximum of 440 px wide, with its padding and its border
		const width = Math.min(440, scrollEl.clientWidth - 24);
		const left = Math.max(scrollEl.scrollLeft + 8, Math.min(rect.right - base.left - width, scrollEl.scrollLeft + scrollEl.clientWidth - width - 8));
		const isAbove = rect.bottom > view.top + scrollEl.clientHeight * 0.55;
		setDetailAt({ id, left, top: isAbove ? rect.top - base.top - 4 : rect.bottom - base.top + 4, isAbove });
	};
	const onDetailFocus = (el: HTMLElement | null) => {
		if (el) {
			showDetailCard(el);
		} else {
			closeDetail();
		}
	};
	// The card of a dot at the end of a long line closes in the same way
	const closeEnds = () => {
		clearTimeout(endsClose.current);
		endsClose.current = window.setTimeout(() => setEndsAt(undefined), 200);
	};
	const keepEnds = () => clearTimeout(endsClose.current);

	// The card of a dot: below the dot, or above it in the lower part of the view. Its right edge is at the right edge
	// of the dot, so the card stays in the visible part of the view
	const showEndsCard = (el: HTMLElement) => {
		const scrollEl = scroller.current;
		const line = Number((el.closest('.row') as HTMLElement | null)?.dataset.line);
		if (!spacer.current || !scrollEl || !(line > 0)) {
			return;
		}
		keepEnds();
		if (endsAt?.line === line) {
			return;
		}
		const rect = el.getBoundingClientRect();
		const base = spacer.current.getBoundingClientRect();
		const view = scrollEl.getBoundingClientRect();
		const isAbove = rect.bottom > view.top + scrollEl.clientHeight * 0.6;
		setEndsAt({ line, right: base.right - rect.right, top: isAbove ? rect.top - base.top - 4 : rect.bottom - base.top + 4, isAbove });
	};
	const onEndsFocus = (el: HTMLElement | null) => {
		if (el) {
			showEndsCard(el);
		} else {
			closeEnds();
		}
	};

	// The card of a chip of removed lines closes in the same way. It shows below the chip, or above it in the lower part of
	// the view, and the card moves into the visible part of the view
	const closeChip = () => {
		clearTimeout(chipClose.current);
		chipClose.current = window.setTimeout(() => setChipAt(undefined), 200);
	};
	const keepChip = () => clearTimeout(chipClose.current);
	const showChipCard = (el: HTMLElement) => {
		const scrollEl = scroller.current;
		const line = Number(el.dataset.delLine);
		if (!spacer.current || !scrollEl || !(line > 0)) {
			return;
		}
		keepChip();
		if (chipAt?.line === line) {
			return;
		}
		const rect = el.getBoundingClientRect();
		const base = spacer.current.getBoundingClientRect();
		const view = scrollEl.getBoundingClientRect();
		const minLeft = scrollEl.scrollLeft + 8;
		const isAbove = rect.bottom > view.top + scrollEl.clientHeight * 0.55;
		setChipAt({
			line, left: Math.max(minLeft, rect.left - base.left), top: isAbove ? rect.top - base.top - 4 : rect.bottom - base.top + 4, isAbove,
			minLeft, maxRight: scrollEl.scrollLeft + scrollEl.clientWidth - 8,
		});
	};
	const onChipFocus = (el: HTMLElement | null) => {
		if (el) {
			showChipCard(el);
		} else {
			closeChip();
		}
	};

	// The card of an item of Hidden C++: a mark in the code, or a chip at the end of a line. The card stays in the
	// visible part of the view.
	const showCostCard = (el: HTMLElement) => {
		const scrollEl = scroller.current;
		if (!spacer.current || !scrollEl) {
			return;
		}
		keepCost();
		const items = el.dataset.cost !== undefined ? [Number(el.dataset.cost)] : (el.dataset.items ?? '').split(',').filter(Boolean).map(Number);
		const rect = el.getBoundingClientRect();
		const base = spacer.current.getBoundingClientRect();
		const key = `${items.join(',')}@${Math.round(rect.top)}`;
		if (costAt?.key === key || items.length === 0) {
			return;
		}
		// the card is a maximum of 420 px wide, with its padding and its border
		const cardLeft = Math.max(scrollEl.scrollLeft + 8, Math.min(rect.left - base.left, scrollEl.scrollLeft + scrollEl.clientWidth - 460));
		const isAbove = items.some((i) => cost?.marks[i]?.related.some((r) => r.line > cost.marks[i].line));
		setCostAt({ key, items, left: cardLeft, top: isAbove ? rect.top - base.top - 4 : rect.bottom - base.top + 4, isAbove });
	};

	// the hover card of a reference of Flow Lens, the card of an item of Hidden C++, and the card of a line number of the
	// function of Logic Map
	const onMouseOver = (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		const markEl = target.closest('[data-detail-mark]') as HTMLElement | null;
		if (markEl) {
			showDetailCard(markEl);
		}
		const costEl = cost && !target.closest('[data-mark]') ? target.closest('[data-cost], .cost-chip') as HTMLElement | null : null;
		if (costEl) {
			showCostCard(costEl);
		}
		const endMark = target.closest('.end-mark') as HTMLElement | null;
		if (endMark) {
			showEndsCard(endMark);
		}
		const chipEl = target.closest('.df-chip') as HTMLElement | null;
		if (chipEl) {
			showChipCard(chipEl);
		}
		const ln = target.closest('.ln') as HTMLElement | null;
		if (ln && logic && spacer.current) {
			const line = Number((ln.parentElement as HTMLElement).dataset.line);
			if (line >= logic.first && line <= logic.last) {
				keepWhy();
				if (whyAt?.line !== line) {
					clearTimeout(whyTimer.current);
					const rect = ln.getBoundingClientRect();
					const base = spacer.current.getBoundingClientRect();
					const at = { line, left: rect.right - base.left - 8, top: rect.bottom - base.top + 2 };
					whyTimer.current = window.setTimeout(() => {
						setWhyAt(at);
						vscode.postMessage({ type: 'why', line });
					}, WHY_DELAY_MS);
				}
			}
		}
		const el = target.closest('[data-mark]') as HTMLElement | null;
		if (el) {
			showFlowCard(el);
		}
	};
	// The hover card of a reference of Flow Lens, below the reference
	const showFlowCard = (el: HTMLElement) => {
		const mark = Number(el.dataset.mark);
		if (!flow || !spacer.current || hover?.mark === mark) {
			return;
		}
		const rect = el.getBoundingClientRect();
		const base = spacer.current.getBoundingClientRect();
		setHover({ mark, left: rect.left - base.left, top: rect.bottom - base.top + 4 });
	};

	// The command "Show Card at Cursor" gives the cards to the keyboard. The card is the card of the reference of Flow
	// Lens at the cursor, else the card of a detail of a model at the cursor, else the card of the items of Hidden C++ at
	// the cursor or on its line, else the card of the dot at the end of the line. The function returns false if the row of the line is not rendered yet, or if its dot
	// comes with the next render. The extension closes the card when the cursor moves
	const openCardAt = (at: { line: number; col: number }): boolean => {
		const row = scroller.current?.querySelector<HTMLElement>(`.rows > .row[data-line="${at.line}"]`);
		if (!row) {
			return false;
		}
		const isAt = (r: SideRange) => r.line === at.line && r.start <= at.col && at.col <= r.end;
		const mark = flow?.marks.findIndex(isAt) ?? -1;
		const item = cost?.marks.findIndex(isAt) ?? -1;
		const markEl = mark >= 0 ? row.querySelector<HTMLElement>(`[data-mark="${mark}"]`) : null;
		const isInPlace = (p: { line: number; col: number; endLine: number; endCol: number }) => (at.line > p.line || (at.line === p.line && at.col >= p.col))
			&& (at.line < p.endLine || (at.line === p.endLine && at.col <= p.endCol));
		// the detail of the code at the cursor, else a detail with its symbol on the line of the cursor
		const detail = [...detailDecos.places].find(([, p]) => isInPlace(p))?.[0] ?? detailDecos.marks.get(at.line)?.[0]?.id;
		const detailEl = detail ? scroller.current?.querySelector<HTMLElement>(`[data-detail-mark="${detail}"]`) ?? null : null;
		const costEl = (item >= 0 ? row.querySelector<HTMLElement>(`[data-cost="${item}"]`) : null) ?? row.querySelector<HTMLElement>('.cost-chip');
		const dotEl = row.querySelector<HTMLElement>('.end-mark');
		let kind: SideCardKind | null = null;
		if (markEl) {
			showFlowCard(markEl);
			kind = 'flow';
		} else if (detailEl) {
			showDetailCard(detailEl);
			kind = 'detail';
		} else if (costEl) {
			showCostCard(costEl);
			kind = 'cost';
		} else if (dotEl) {
			showEndsCard(dotEl);
			kind = 'ends';
		} else if (shortEndsRef.current.has(at.line)) {
			return false;
		}
		vscode.postMessage({ type: 'card', kind, line: at.line });
		return true;
	};
	// a card for a line that is not rendered: the view scrolls the line to its middle, and the card opens after the render
	const pendingCard = useRef<{ line: number; col: number } | undefined>(undefined);
	useLayoutEffect(() => {
		const at = props.cardAt;
		pendingCard.current = undefined;
		if (!at) {
			setHover(undefined);
			setCostAt(undefined);
			setEndsAt(undefined);
			setDetailAt(undefined);
			return;
		}
		const el = scroller.current;
		if (!openCardAt(at) && el) {
			pendingCard.current = at;
			el.scrollTop = Math.max(0, (at.line - 1) * rowHeight - el.clientHeight / 2);
			setTop(el.scrollTop);
		}
	}, [props.cardAt?.seq]);
	useLayoutEffect(() => {
		if (pendingCard.current && openCardAt(pendingCard.current)) {
			pendingCard.current = undefined;
		}
	});
	const onMouseOut = (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		const related = e.relatedTarget as HTMLElement | null;
		if (target.closest('.ln') && !related?.closest?.('.why-card')) {
			closeWhy();
		}
		const fromCost = target.closest('[data-cost], .cost-chip');
		if (fromCost && !related?.closest?.('.cost-card') && fromCost !== related?.closest?.('[data-cost], .cost-chip')) {
			closeCost();
		}
		const fromEnd = target.closest('.end-mark');
		if (fromEnd && !related?.closest?.('.ends-card') && fromEnd !== related?.closest?.('.end-mark')) {
			closeEnds();
		}
		const fromMark = target.closest('[data-detail-mark]');
		if (fromMark && !related?.closest?.('.detail-card') && fromMark !== related?.closest?.('[data-detail-mark]')) {
			closeDetail();
		}
		const fromChip = target.closest('.df-chip');
		if (fromChip && !related?.closest?.('.df-card') && fromChip !== related?.closest?.('.df-chip')) {
			closeChip();
		}
		const from = target.closest('[data-mark]');
		const to = related?.closest?.('[data-mark]');
		if (from && from !== to) {
			setHover(undefined);
		}
	};

	const firstLine = Math.max(1, Math.floor(top / rowHeight) + 1 - OVERSCAN);
	const lastLine = Math.min(lineCount, Math.ceil((top + height) / rowHeight) + OVERSCAN);
	useLayoutEffect(() => props.onRendered(Math.max(0, lastLine - firstLine + 1)));

	const text: GuideText = {
		lineCount,
		tabSize: settings.tabSize,
		indentSize: settings.indentSize,
		text: (line) => rows[line - 1]?.text ?? '',
	};
	const guides = settings.guides && lastLine >= firstLine ? indentGuides(text, firstLine, lastLine) : [];
	const active = settings.guides && settings.activeGuide && props.cursor && props.cursor <= lineCount
		? activeGuide(text, props.cursor, firstLine, lastLine) : undefined;
	const decorations = useMemo(() => flowDecorations(flow), [flow]);
	const incHints = useMemo(() => includeHints(props.includes), [props.includes]);
	const callHintMap = useMemo(() => callHints(props.calls), [props.calls]);
	const logicDecos = useMemo(() => logicDecorations(logic), [logic]);
	const costDecos = useMemo(() => costDecorations(cost), [cost]);
	const rippleDecos = useMemo(() => rippleDecorations(props.ripple), [props.ripple]);
	const threadDecos = useMemo(() => threadDecorations(props.threads, props.threadItem), [props.threads, props.threadItem]);
	const modelDecos = useMemo(() => modelDecorations(props.model), [props.model]);
	const detailDecos = useMemo(() => detailBoxes(props.model, (line) => rows[line - 1]?.text, detailAt?.id), [props.model, rows, detailAt?.id]);
	// the boxes of Logic Map and of Hidden C++ on each line, in the sequence for codeParts
	const wraps = useMemo(() => {
		const out = new Map<number, Wrap[]>();
		for (const source of [logicDecos.wraps, costDecos.wraps, threadDecos.wraps, detailDecos.wraps, props.diff?.wraps ?? new Map<number, Wrap[]>()]) {
			for (const [line, list] of source) {
				out.set(line, [...(out.get(line) ?? []), ...list]);
			}
		}
		for (const [line, list] of out) {
			out.set(line, nestWraps(list));
		}
		return out;
	}, [logicDecos, costDecos, threadDecos, detailDecos, props.diff]);

	const gutter = Math.max(4, String(lineCount).length);
	const lanes = laneWidth(flow);
	// the line numbers have space for the bars of two levels of blocks. Each level after the second makes them wider
	const barsExtra = Math.max(0, modelDecos.levels - 2) * BAR_STEP;
	// the position of a reference for the curves: the middle of the name, and the top and the bottom of its row
	// the left edge of the code in the content of the view: the line numbers and the lane come first
	const codeLeft = gutter * (charWidth - settings.letterSpacing) + 26 + barsExtra + lanes;
	const pointOfRange = (r: SideRange): RangePoint => {
		const rowText = rows[r.line - 1]?.text ?? '';
		const start = visualColumn(rowText, r.start, settings.tabSize);
		const end = visualColumn(rowText, r.end, settings.tabSize);
		return { x: codeLeft + ((start + end) / 2) * charWidth, top: (r.line - 1) * rowHeight + 1, bottom: r.line * rowHeight - 1 };
	};
	const pointOf = (m: SideFlowMark): MarkPoint => pointOfRange(m);
	// the left and the right edge of the text of a row, for the curves that go around the text
	const textOf = (line: number): [number, number] | undefined => {
		const text = rows[line - 1]?.text ?? '';
		const start = text.search(/\S/);
		return start < 0 ? undefined : [codeLeft + visualColumn(text, start, settings.tabSize) * charWidth,
			codeLeft + visualColumn(text, text.trimEnd().length, settings.tabSize) * charWidth];
	};
	// the width of the full end of a row, as the styles of .ends give it: the hints in the editor font, the symbols of the
	// details, a gap of 12 px between two items, and a padding of 16 px
	const endsWidth = (texts: string[], marks = 0): number => texts.length + marks === 0 ? 0
		: texts.reduce((n, t) => n + t.length, 0) * charWidth + marks * DETAIL_MARK_PX + 12 * (texts.length + marks - 1) + 16;
	// the lookup of the card of Hidden C++ that has a group, for the connector
	const lookup = cost && costAt ? costAt.items.map((i) => cost.marks[i]).find((m) => m?.category === 'lookup' && m.related.length > 0) : undefined;

	const items = [];
	for (let line = firstLine; line <= lastLine; line++) {
		items.push(
			<Row
				key={line}
				line={line}
				row={rows[line - 1]}
				isCursor={line === props.cursor}
				guides={guides[line - firstLine] ?? 0}
				active={active}
				settings={settings}
				flow={flow}
				decorations={decorations.marks.get(line)}
				wraps={wraps.get(line)}
				hints={decorations.hints.get(line)}
				flowTags={decorations.tags.get(line)}
				logicHints={logicDecos.hints.get(line)}
				endsWidth={endsWidth(endTexts(decorations.hints.get(line), logicDecos.hints.get(line)), detailDecos.marks.get(line)?.length)}
				isShortEnds={shortEnds.has(line)}
				onEndsFocus={onEndsFocus}
				detailMarks={detailDecos.marks.get(line)}
				onDetailFocus={onDetailFocus}
				chips={costDecos.chips.get(line)}
				includeHints={incHints.get(line)}
				onIncludeHint={props.onIncludeHint}
				callHints={callHintMap.get(line)}
				onCallHint={props.onCallHint}
				threadLane={threadDecos.lanes.get(line)}
				threadHints={threadDecos.hints.get(line)}
				onThreadHint={props.onThreadHint}
				ripple={rippleDecos.lines.get(line)}
				rippleHints={rippleDecos.hints.get(line)}
				modelBars={modelDecos.bars.get(line)}
				noteKind={modelDecos.notes.get(line)}
				modelTags={modelDecos.tags.get(line)}
				onModelTag={props.onModelTag}
				animate={props.animate}
				isDim={!!flow && flow.isSelected && !decorations.marks.has(line)}
				isInactive={!!props.inactive?.some(([a, b]) => a <= line && line <= b)}
				isPathStep={logicDecos.steps.has(line)}
				isStep={line === props.stepLine}
				reviewStep={reviewStepOf(props.guideLines, line)}
				reviewTag={props.guideLines?.first === line ? props.guideLines.label : undefined}
				isWalk={!!props.guideLines?.isWalk}
				diffClass={props.diff?.lines.get(line)}
				diffChip={props.diff?.chips.get(line)}
				onChipFocus={onChipFocus}
				lead={decorations.leads.get(line)}
				leadY={leadY}
			/>,
		);
	}

	// The space below the last line lets the last line go to the top, as in the text editor
	const contentHeight = lineCount * rowHeight + Math.max(0, height - rowHeight);
	const why = whyAt && props.why?.line === whyAt.line && props.why.items ? props.why : undefined;
	return (
		<div
			class="scroller"
			ref={scroller}
			tabIndex={0}
			role="region"
			aria-label={props.file ? `Code of ${props.file}` : 'Code'}
			onScroll={onScroll}
			onMouseDown={onMouseDown}
			onMouseUp={onMouseUp}
			onMouseMove={onMouseMove}
			onMouseLeave={onMouseLeave}
			onContextMenu={onContextMenu}
			onMouseOver={onMouseOver}
			onMouseOut={onMouseOut}
			style={{
				'--row-height': `${rowHeight}px`,
				'--gutter': `${gutter}ch`,
				'--bars-extra': `${barsExtra}px`,
				'tabSize': String(settings.tabSize),
				'fontFeatureSettings': settings.ligatures,
				'letterSpacing': `${settings.letterSpacing}px`,
			}}
		>
			<span class="measure" ref={measure} aria-hidden="true">0000000000</span>
			<div class="row probe" ref={probe} aria-hidden="true"><span class="code"><span class="mk">0</span></span></div>
			<div
				class="spacer"
				ref={spacer}
				style={{ height: `${contentHeight}px`, minWidth: `calc(${gutter + props.maxColumns}ch + ${lanes + barsExtra + 56}px)` }}
			>
				<div class="rows" style={{ transform: `translateY(${(firstLine - 1) * rowHeight}px)` }}>{items}</div>
				{flow && hover && hover.mark < flow.marks.length && (
					<FlowCurves flow={flow} mark={hover.mark} pointOf={pointOf} textOf={textOf} rowHeight={rowHeight} />
				)}
				{flow && hover && hover.mark < flow.marks.length && <FlowCard flow={flow} mark={hover.mark} left={hover.left} top={hover.top} />}
				{logic && whyAt && why && <WhyCard why={why} left={whyAt.left} top={whyAt.top} onEnter={keepWhy} onLeave={closeWhy} />}
				{lookup && <LookupConnector mark={lookup} pointOf={pointOfRange} />}
				{cost && costAt && (
					<CostCard cost={cost} items={costAt.items} left={costAt.left} top={costAt.top} isAbove={costAt.isAbove} onEnter={keepCost}
						onLeave={closeCost} />
				)}
				{detailAt && props.model?.details.some((d) => d.id === detailAt.id) && (
					<DetailCard detail={props.model.details.find((d) => d.id === detailAt.id)!} left={detailAt.left} top={detailAt.top}
						isAbove={detailAt.isAbove} onEnter={keepDetail} onLeave={closeDetail} />
				)}
				{chipAt && props.diff?.chips.get(chipAt.line) && (
					<RemovedCard chip={props.diff.chips.get(chipAt.line)!} left={chipAt.left} top={chipAt.top} isAbove={chipAt.isAbove} minLeft={chipAt.minLeft}
						maxRight={chipAt.maxRight} onEnter={keepChip} onLeave={closeChip} />
				)}
				{endsAt && shortEnds.has(endsAt.line) && (
					<EndsCard texts={endTexts(decorations.hints.get(endsAt.line), logicDecos.hints.get(endsAt.line))} right={endsAt.right}
						top={endsAt.top} isAbove={endsAt.isAbove} onEnter={keepEnds} onLeave={closeEnds} />
				)}
			</div>
		</div>
	);
}
