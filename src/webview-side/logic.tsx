import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { isMacroCall } from '../side/names';
import type { FromSide, SideLogic, SideLogicMark, SideStep, SideWhy } from '../side/protocol';
import { vscode } from './vscode';
import type { Wrap } from './wraps';

// The layer of Logic Map, as in the prototype of the design study. Logic Map shows one path through the function. Each
// decision has an option: the choice of the user, or the default option, which runs the most lines. The code view
// marks the lines of the steps, the events and the pointers that can be null. The path panel in
// the details column tells the path as a trail of steps, with the events, the returns and the warnings. "Play path"
// goes through the steps and shows each step in the code.

// The time of one step of "Play path", as in the prototype
export const PLAY_STEP_MS = 650;

export interface LogicHint {
	text: string;
	kind: 'problem';
}

export interface LogicDecorations {
	wraps: Map<number, Wrap[]>;
	hints: Map<number, LogicHint[]>;
	steps: Set<number>; // the lines of the steps of the path
}

// The boxes, the hints and the lines of the steps of the code view. The lines that the path cannot reach keep their
// colors: the lines of the steps get a background, as the steps of "Play path".
export function logicDecorations(logic: SideLogic | null): LogicDecorations {
	const out: LogicDecorations = { wraps: new Map(), hints: new Map(), steps: new Set(logic?.hasCfg ? logic.steps.map((s) => s.line) : []) };
	if (!logic) {
		return out;
	}
	const push = <T,>(map: Map<number, T[]>, line: number, item: T) => map.set(line, [...(map.get(line) ?? []), item]);
	const wrap = (m: SideLogicMark, cls: string) => push(out.wraps, m.line, { start: m.start, end: m.end, cls });
	logic.events.forEach((e) => wrap(e, 'lk lk-event'));
	logic.problems.forEach((p) => wrap(p, 'lk lk-null'));
	// an event has a box, but no hint. A line gets only the hints of its warnings, so the end of the row stays short
	for (const h of logic.hints) {
		push(out.hints, h.line, { text: h.text, kind: 'problem' });
	}
	return out;
}

const post = (message: FromSide) => vscode.postMessage(message);
const setChoice = (key: string, value: string) => post({ type: 'setChoice', key, value });
const reveal = (line: number) => () => post({ type: 'revealLine', line });

const NO_CFG = 'No path: Clang made no control flow graph for this function.';

export function deadText(logic: SideLogic): string {
	const n = logic.dead.length;
	return !logic.hasCfg ? NO_CFG : n === 0 ? 'All lines run' : n === 1 ? '1 line cannot run' : `${n} lines cannot run`;
}

// The short name of a function with (), for example process() for electricity::power_ctrl::process. A lambda gets its
// number and its function, for example "lambda 1 in process()" for electricity::power_ctrl::process::(lambda 1). The
// text of a macro call stays, for example TEST_CASE("split")
function shortName(fn: string): string {
	if (isMacroCall(fn)) {
		return fn;
	}
	const parts = fn.split('::');
	const last = parts.pop() ?? fn;
	const lambda = /^\(lambda (\d+)\)$/.exec(last);
	return lambda ? `lambda ${lambda[1]} in ${parts.pop() ?? ''}()` : `${last}()`;
}

type SideChange = NonNullable<SideStep['changes']>[number];

// The texts of the kinds of the changed data of an effect step
const EFFECT_KINDS: Record<SideChange['kind'], string> = {
	member: 'data member', global: 'global variable', parameter: 'object of a parameter', capture: 'captured variable',
};

// What the code does with the data, for example "total +=", "++g_count" or "items.push_back()"
function changeText(change: SideChange): string {
	const action = change.action;
	if (/^[A-Za-z_]\w*$/.test(action)) {
		return `${change.target}.${action}()`;
	}
	return action === '++' || action === '--' ? `${action}${change.target}` : `${change.target} ${action}`;
}

// The text of a step in the trail. An effect step with one change shows the change, else the changed data
function stepText(step: SideStep): string {
	if (step.kind === 'return' || step.kind === 'end') {
		return returnText(step);
	}
	return step.kind === 'effect' && step.changes?.length === 1 ? changeText(step.changes[0]) : step.text;
}

// The second line of an effect step: the line and the kind of the data, or the lines and the number of the changes
function effectSub(step: SideStep): string {
	const changes = step.changes ?? [];
	if (changes.length === 1) {
		return `line ${step.line} · ${EFFECT_KINDS[changes[0].kind]}`;
	}
	const first = changes[0]?.line ?? step.line;
	const last = changes.at(-1)?.line ?? step.line;
	return `${first === last ? `line ${first}` : `lines ${first}–${last}`} · ${changes.length} changes`;
}

// The summary shows a maximum of this number of changed data
const MAX_CHANGES = 6;

// The changed data of the path, each one time. A click shows the first line that changes it.
function ChangeList({ logic }: { logic: SideLogic }) {
	const first = new Map<string, number>();
	for (const c of logic.steps.flatMap((s) => s.changes ?? [])) {
		if (!first.has(c.target)) {
			first.set(c.target, c.line);
		}
	}
	if (first.size === 0) {
		return <span class="sub">none</span>;
	}
	const all = [...first];
	return (
		<span class="events-line">
			{all.slice(0, MAX_CHANGES).map(([text, line]) => (
				<button type="button" class="link mono" title={`Line ${line}`} onClick={reveal(line)}>{text}</button>
			))}
			{all.length > MAX_CHANGES && (
				<span class="sub" title={all.slice(MAX_CHANGES).map(([text, line]) => `${text} (line ${line})`).join('\n')}>
					{all.length - MAX_CHANGES} more
				</span>
			)}
		</span>
	);
}

// The text of a return: the returned value, or the keyword for a return with no value
function returnText(step: SideStep): string {
	return step.kind === 'end' ? 'end of the function' : step.text ? `return ${step.text}` : 'return';
}

// The events on the path, in the sequence of the path. A click shows the line. With more events than max, the list is
// a count.
function EventList({ logic, max = Infinity }: { logic: SideLogic; max?: number }) {
	if (logic.events.length > max) {
		return <span class="sub" title={logic.events.map((e) => `${e.label} (line ${e.line})`).join('\n')}>{logic.events.length} events</span>;
	}
	return (
		<span class="events-line">
			{logic.events.map((e, i) => (
				<>
					{i > 0 && <span class="sub" aria-hidden="true">→</span>}
					<button type="button" class="link event mono" title={`Line ${e.line}`} onClick={reveal(e.line)}>{e.label}</button>
				</>
			))}
		</span>
	);
}

// The returned values of the path. A click shows the line.
function ReturnList({ logic }: { logic: SideLogic }) {
	const returns = logic.steps.filter((s) => s.kind === 'return' || s.kind === 'end');
	if (returns.length === 0) {
		return <span class="sub">none</span>;
	}
	return (
		<span class="events-line">
			{returns.map((r) => (
				<button type="button" class="link mono" title={`Line ${r.line}: ${returnText(r)}`} onClick={reveal(r.line)}>
					{r.kind === 'end' ? 'end of the function' : r.text || 'no value'}
				</button>
			))}
		</span>
	);
}

// The bar shows a maximum of this number of events and warnings. The path panel shows all. Flow Lens uses the same
// maximum for its problems
const BAR_EVENTS = 4;
export const BAR_WARNINGS = 2;

export interface PlayProps {
	animate: boolean;
	isPlaying: boolean;
	onPlay: () => void; // starts or stops "Play path"
}

function PlayButton({ isPlaying, onPlay, cls }: PlayProps & { cls: string }) {
	return (
		<button type="button" class={cls} aria-pressed={isPlaying} onClick={onPlay} title="Go through the steps of the path">
			{isPlaying ? '■ Stop' : '▶ Play path'}
		</button>
	);
}

// The controls of Logic Map in the bar of the lenses: the lines that cannot run, the events, the returns and the
// warnings of the path, "Play path" and Reset
export function LogicGroup({ logic, play }: { logic: SideLogic | null; play: PlayProps }) {
	const warnings = logic?.warnings ?? [];
	const more = warnings.slice(BAR_WARNINGS);
	return (
		<span class="lensgroup" role="group" aria-label="Logic Map">
			<span class="lens-dot c-path" title="Logic Map" />
			<span class="sub">{logic ? deadText(logic) : 'Put the cursor in a function.'}</span>
			{logic && logic.events.length > 0 && <><span class="sub">Events:</span><EventList logic={logic} max={BAR_EVENTS} /></>}
			{warnings.slice(0, BAR_WARNINGS).map((w) => (
				<button type="button" class="link finding" title={w.text} onClick={reveal(w.line)}>Line {w.line}: {w.short}</button>
			))}
			{more.length > 0 && (
				<span class="problem" title={more.map((w) => `Line ${w.line}: ${w.text}`).join('\n')}>
					{more.length === 1 ? '1 more warning' : `${more.length} more warnings`}
				</span>
			)}
			{logic?.hasCfg && play.animate && logic.steps.length > 0 && <PlayButton {...play} cls="lens" />}
			{logic?.hasChoices && <button type="button" class="lens" onClick={() => post({ type: 'resetChoices' })}>Reset</button>}
		</span>
	);
}

// Why a line runs: the choices that the line needs, and a button that sets them
export function WhyText({ why }: { why: SideWhy }) {
	if (!why.items) {
		return <div class="sub">Logic Map has no statement on line {why.line}.</div>;
	}
	if (why.items.length === 0) {
		return <div>Line {why.line} runs on all paths.</div>;
	}
	return (
		<div>
			<div>Line {why.line} runs if:</div>
			<ol class="why-list">
				{why.items.map((item) => (
					<li><span class="mono">{item.text}</span> = {item.options ? `one of ${item.options.join(', ')}` : item.option}</li>
				))}
			</ol>
			<button type="button" class="link" onClick={() => post({ type: 'applyWhy', line: why.line })}>Use these choices</button>
		</div>
	);
}

// The card of a line number: why the line runs. The mouse can go into the card to click the button.
export function WhyCard({ why, left, top, onEnter, onLeave }: {
	why: SideWhy;
	left: number;
	top: number;
	onEnter: () => void;
	onLeave: () => void;
}) {
	return (
		<div class="card why-card" style={{ left: `${left}px`, top: `${top}px` }} role="dialog" aria-label={`Why line ${why.line} runs`}
			onMouseEnter={onEnter} onMouseLeave={onLeave}>
			<WhyText why={why} />
		</div>
	);
}

// The option of a decision step. A switch or an else-if chain gets a list. The other decisions get buttons, for example
// yes and no. A default option has an outline, and a choice of the user is full.
function StepChoice({ step }: { step: SideStep }) {
	const options = step.options ?? [];
	const title = step.isSet ? 'Your choice' : 'The default: the option that runs the most lines';
	if (options.length > 3) {
		return (
			<select class={step.isSet ? 'choice set' : 'choice'} aria-label={step.text} title={title} value={step.value}
				onChange={(e) => setChoice(step.key!, (e.target as HTMLSelectElement).value)}>
				{options.map((option) => <option value={option}>{option}</option>)}
			</select>
		);
	}
	return (
		<span class={step.isSet ? 'seg set' : 'seg'} role="group" aria-label={step.text} title={title}>
			{options.map((option) => (
				<button type="button" aria-pressed={option === step.value} onClick={() => setChoice(step.key!, option)}>{option}</button>
			))}
		</span>
	);
}

// The text of the second line of a step
function StepSub({ step }: { step: SideStep }) {
	switch (step.kind) {
		case 'decision':
			return <span class="step-sub">line {step.line}<StepChoice step={step} /></span>;
		case 'event':
			return <span class="step-sub">line {step.line} · event{step.problem && <span class="problem"> · {step.problem}</span>}</span>;
		case 'warning':
			return <span class="step-sub">line {step.line} · <span class="problem">no null check on the path</span></span>;
		case 'effect':
			return <span class="step-sub">{effectSub(step)}</span>;
		default:
			return <span class="step-sub">line {step.line} · {step.kind === 'end' ? 'the function ends' : 'return'}</span>;
	}
}

// The trail of the path: one row for each step, on a vertical line. A diamond is a decision, a dot is an event, a
// warning or a return. A click on a step shows its line. During "Play path", a dot moves to the current step.
function Trail({ logic, current, onHover }: { logic: SideLogic; current?: number; onHover: (line?: number) => void }) {
	const list = useRef<HTMLOListElement>(null);
	const [cursorTop, setCursorTop] = useState<number | undefined>(undefined);
	useLayoutEffect(() => {
		const row = current === undefined ? undefined : list.current?.children[current] as HTMLElement | undefined;
		setCursorTop(row ? row.offsetTop + 7 : undefined);
		row?.scrollIntoView({ block: 'nearest' });
	}, [current, logic.steps]);
	return (
		<ol class="trail" ref={list} aria-label={`Steps of the path through ${shortName(logic.fn)}`}>
			{logic.steps.map((step, i) => (
				<li
					class={`step k-${step.kind}${i === current ? ' current' : ''}${step.problem ? ' has-problem' : ''}`}
					data-line={step.line}
					aria-current={i === current ? 'step' : undefined}
					onMouseEnter={() => onHover(step.line)}
					onMouseLeave={() => onHover(undefined)}
				>
					<span class={`node ${step.kind === 'decision' && step.isSet ? 'set' : ''}`} aria-hidden="true" />
					<button type="button" class="step-text mono" title={`${stepText(step)} · line ${step.line}`} onClick={reveal(step.line)}>
						{stepText(step)}
					</button>
					<StepSub step={step} />
				</li>
			))}
			{cursorTop !== undefined && <span class="trail-cursor" style={{ top: `${cursorTop}px` }} aria-hidden="true" />}
		</ol>
	);
}

// The path panel of Logic Map in the details column: the summary of the path, the trail of its steps, and why the line
// of the cursor runs
export function LogicDetails({ logic, play, current, onHover }: {
	logic: SideLogic | null;
	play: PlayProps;
	current?: number; // the step of "Play path"
	onHover: (line?: number) => void; // the mouse is on a step. The code view marks its line
}) {
	if (!logic) {
		return (
			<div class="details-body">
				<p class="sub">Put the cursor in a function. Logic Map shows one path through the function, with the default choices.</p>
			</div>
		);
	}
	const name = shortName(logic.fn);
	return (
		<div class="details-body">
			<div class="flow-title">
				<span class="flow-name fn-name" title={logic.fn}>Path through <span class="mono">{name}</span></span>
				{logic.hasChoices && <button type="button" class="link" onClick={() => post({ type: 'resetChoices' })}>Reset</button>}
			</div>
			<div class="path-actions">
				<span class="sub">{deadText(logic)}</span>
				<span class="grow" />
				{logic.hasCfg && play.animate && logic.steps.length > 0 && <PlayButton {...play} cls="lens" />}
			</div>
			{logic.hasCfg && (
				<div class="summary">
					<span class="sub">Events</span>
					{logic.events.length > 0 ? <EventList logic={logic} /> : <span class="sub">none</span>}
					<span class="sub">Returns</span>
					<ReturnList logic={logic} />
					<span class="sub">Changes</span>
					<ChangeList logic={logic} />
				</div>
			)}
			{logic.warnings.map((w) => (
				<button type="button" class="callout" onClick={reveal(w.line)}>{w.text}</button>
			))}
			{logic.hasCfg && logic.steps.length > 0 && <Trail logic={logic} current={current} onHover={onHover} />}
			<div class="why-box">
				{logic.why ? <WhyText why={logic.why} /> : <div class="sub">Put the cursor on a line of the function to see why it runs.</div>}
			</div>
		</div>
	);
}
