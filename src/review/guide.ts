import type * as Api from '../../api/dataflow-api';
import * as path from 'path';
import { resolveActions, type TextChange } from '../lenses/blocks';
import { bandText, changedFunctions, HeatChange, heatFact, HeatModel, hottestChanges, MAX_HOT_CHANGES } from '../lenses/heat';
import type { SideGuide, SideGuideKind, SideGuideStatus, SideGuideStep, SideStepDiff } from '../side/protocol';
import type { DiffLine } from './git';

// A guided review: the user names the files and the folders to review, a language model makes a plan for them, and the
// user goes through the plan step by step in the side view. This file gives the files and their changes to the model,
// checks the plan of the model, changes the state of the guide and writes its summary. Lines start at 1.

export const MAX_GUIDE_STEPS = 20;
export const MAX_STEP_TITLE = 80;
export const MAX_STEP_TEXT = 2000;
export const MAX_STEP_CHECKS = 5;
export const MAX_CHECK = 200;
export const MAX_GUIDE_NOTE = 2000;
export const MAX_GUIDE_SUMMARY = 1000;
export const GUIDE_KINDS: readonly SideGuideKind[] = ['change', 'ripple', 'context', 'risk', 'test'];
export const GUIDE_STATUSES: readonly SideGuideStatus[] = ['todo', 'ok', 'issue', 'question'];
// The two types of a guide, with the names that the model gets from get_view
export const GUIDE_TYPES = ['review', 'diff walk'] as const;
export type GuideType = typeof GUIDE_TYPES[number];

export function guideType(guide: SideGuide): GuideType {
	return guide.kind === 'diff' ? 'diff walk' : 'review';
}

// the limits of the facts of a review, so many files or a large change do not fill the context of the model
export const MAX_REVIEW_FILES = 50;
const MAX_DIFF_LINES = 400;

const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const fileKey = (file: string) => (process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

//-------------------
// The files of a review

export interface ReviewFilesInput {
	root: string; // the folder that the relative paths start at: the git repository, else the folder of the project
	target?: string; // the target branch, for example main. Undefined with no git repository or no target branch
	base?: string; // for example "main (merge base 1a2b3c4)"
	files: { file: string; lineCount: number; hunks: DiffLine[][] }[]; // the C and C++ files under the paths
	missing: string[]; // the paths that do not exist
	skipped: string[]; // the files that are not C or C++ files
	notice?: string; // for example: the repository has no target branch, so the files have no changes
}

// The lines that a hunk changes in the working tree: the added lines, and the line after each removed block. A removed
// block at the end of the file marks the last line
export function markedLines(lines: readonly DiffLine[], lineCount: number): number[] {
	const out: number[] = [];
	lines.forEach((l, i) => {
		if (l.kind === 'added') {
			out.push(l.newLine);
		} else if (l.kind === 'removed' && lines[i - 1]?.kind !== 'removed') {
			out.push(Math.max(1, Math.min(l.newLine, lineCount)));
		}
	});
	return out;
}

// A line of the diff for the model: + for an added line, - for a removed line, with the line in the working tree
export function diffText(line: DiffLine): string {
	const mark = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
	const at = line.kind === 'removed' ? '' : String(line.newLine);
	return `${mark}${at.padStart(5)} | ${line.text}`;
}

// The facts that the model needs for a plan: the C and C++ files under the paths of the user, with their number of
// lines, and the diff of each changed file against the target branch. The paths are relative to the root. With the heat
// of the changed files, a changed file has the heat of its changed functions, and hottestChanges gives the changed
// functions of all files, the hottest first. The model reads the files with the other tools
export function reviewFacts(input: ReviewFilesInput, heat?: ReadonlyMap<string, HeatModel>): Omit<Api.ReviewFacts, 'callGraph' | 'noHeat'> {
	const rel = (file: string) => path.relative(input.root, file).replace(/\\/g, '/');
	const changes: HeatChange[] = [];
	const files = input.files.slice(0, MAX_REVIEW_FILES).map((f): Api.ReviewFacts['files'][number] => {
		if (f.hunks.length === 0) {
			return { file: rel(f.file), lines: f.lineCount, isChanged: false };
		}
		const lines = f.hunks.flatMap((h, i) => [...(i > 0 ? ['  ... |'] : []), ...h.map(diffText)]);
		const model = heat?.get(f.file);
		const fns = model ? changedFunctions(model, f.hunks.flatMap((h) => markedLines(h, f.lineCount))) : [];
		changes.push(...fns.map((fn) => ({ file: f.file, fn, hunks: [] })));
		return {
			file: rel(f.file),
			lines: f.lineCount,
			isChanged: true,
			changedLines: f.hunks.flat().filter((l) => l.kind === 'added').map((l) => l.newLine),
			...(fns.length > 0 ? {
				changedFunctions: fns.map((fn) => ({
					function: fn.qualifiedName || fn.name, lines: [fn.first, fn.last], score: fn.score, band: bandText(fn.band), isReachComplete: fn.isReachComplete,
				})),
			} : {}),
			diff: lines.slice(0, MAX_DIFF_LINES).join('\n'),
			...(lines.length > MAX_DIFF_LINES ? { isDiffTruncated: true } : {}),
		};
	});
	return {
		root: input.root,
		...(input.target ? { target: input.target, base: input.base } : {}),
		...(changes.length > 0 ? { hottestChanges: hottestChanges(changes, MAX_HOT_CHANGES).map((c) => ({ ...heatFact(c.fn), file: rel(c.file) })) } : {}),
		files,
		...(input.files.length > MAX_REVIEW_FILES ? { moreFiles: input.files.length - MAX_REVIEW_FILES } : {}),
		...(input.missing.length > 0 ? { notFound: input.missing } : {}),
		...(input.skipped.length > 0 ? { notCpp: input.skipped } : {}),
		...(input.notice ? { notice: input.notice } : {}),
	};
}

//-------------------
// The plan of the model

export interface GuideStepInput {
	title?: unknown;
	file?: unknown;
	lines?: unknown;
	text?: unknown;
	checks?: unknown;
	kind?: unknown;
	actions?: unknown; // the buttons of an extension: [{ id, title }]
}

export interface GuidePlanInput {
	title?: unknown;
	summary?: unknown;
	steps?: unknown;
}

// The file of a step: its full path and its number of lines, or the reason why a step cannot use it, for example a file
// that is not a C or C++ file. Undefined if the project has no such file
export type GuideFileLookup = (file: string) => { file: string; lineCount: number; problem?: string } | undefined;

// Checks the plan of the model. A step with no file uses the file of the step before it, or else the default file. The
// result has a problem for each wrong step, so the model can correct all of them in one call
export function resolveGuidePlan(input: GuidePlanInput, lookup: GuideFileLookup, options: { defaultFile?: string; seq: number; client?: string; target?: string }):
	{ guide?: SideGuide; problems: string[] } {
	const problems: string[] = [];
	if (!Array.isArray(input.steps) || input.steps.length === 0) {
		return { problems: ['Give "steps": a list with one step or more.'] };
	}
	if (input.steps.length > MAX_GUIDE_STEPS) {
		return { problems: [`Give ${MAX_GUIDE_STEPS} steps at most. The plan has ${input.steps.length} steps.`] };
	}
	const steps: SideGuideStep[] = [];
	let lastFile = options.defaultFile;
	input.steps.forEach((raw: GuideStepInput, i) => {
		const n = i + 1;
		if (!raw || typeof raw !== 'object') {
			problems.push(`Step ${n} is not an object.`);
			return;
		}
		if (!isText(raw.title)) {
			problems.push(`Step ${n} has no "title".`);
		}
		if (!isText(raw.text)) {
			problems.push(`Step ${n} has no "text".`);
		}
		const given = isText(raw.file) ? raw.file : lastFile;
		const found = given ? lookup(given) : undefined;
		if (!given) {
			problems.push(`Step ${n} has no "file".`);
		} else if (!found) {
			problems.push(`Step ${n}: the file ${given} is not in the project.`);
		} else if (found.problem) {
			problems.push(`Step ${n}: ${found.problem}`);
		} else {
			lastFile = found.file;
		}
		const lines = raw.lines;
		const isPair = Array.isArray(lines) && lines.length === 2 && lines.every((l) => Number.isInteger(l));
		if (!isPair) {
			problems.push(`Step ${n}: "lines" must be two whole numbers, the first and the last line.`);
		} else if (found && !found.problem && (lines[0] < 1 || lines[0] > lines[1] || lines[1] > found.lineCount)) {
			problems.push(`Step ${n}: the lines ${lines[0]} to ${lines[1]} are not in ${fileName(found.file)}, which has ${found.lineCount} lines.`);
		}
		if (raw.kind !== undefined && !GUIDE_KINDS.includes(raw.kind as SideGuideKind)) {
			problems.push(`Step ${n}: "kind" must be one of ${GUIDE_KINDS.join(', ')}.`);
		}
		if (raw.checks !== undefined && (!Array.isArray(raw.checks) || !raw.checks.every((c) => typeof c === 'string'))) {
			problems.push(`Step ${n}: "checks" must be a list of texts.`);
		}
		const actions = resolveActions(raw.actions, `Step ${n}`, problems);
		if (problems.length > 0 || !found || found.problem || !isPair) {
			return;
		}
		const checks = ((raw.checks as string[] | undefined) ?? []).filter(isText).slice(0, MAX_STEP_CHECKS).map((c) => clip(c.trim(), MAX_CHECK));
		steps.push({
			title: clip((raw.title as string).trim(), MAX_STEP_TITLE),
			file: found.file,
			name: fileName(found.file),
			first: lines[0],
			last: lines[1],
			text: clip((raw.text as string).trim(), MAX_STEP_TEXT),
			checks,
			...(raw.kind ? { kind: raw.kind as SideGuideKind } : {}),
			status: 'todo',
			...(actions ? { actions } : {}),
		});
	});
	if (problems.length > 0) {
		return { problems };
	}
	return {
		guide: {
			title: isText(input.title) ? clip(input.title.trim(), MAX_STEP_TITLE) : 'Review of the changes',
			...(isText(input.summary) ? { summary: clip(input.summary.trim(), MAX_GUIDE_SUMMARY) } : {}),
			...(options.client ? { client: options.client } : {}),
			...(options.target ? { target: options.target } : {}),
			steps,
			current: 0,
			seq: options.seq,
		},
		problems,
	};
}

//-------------------
// The state of the guide

const changeStep = (guide: SideGuide, index: number, change: Partial<SideGuideStep>): SideGuide =>
	({ ...guide, steps: guide.steps.map((s, i) => (i === index ? { ...s, ...change } : s)) });

// The index of a step, from 0, or undefined if the guide has no such step
export function stepIndex(guide: SideGuide, index: number): number | undefined {
	return Number.isInteger(index) && index >= 0 && index < guide.steps.length ? index : undefined;
}

export function withCurrent(guide: SideGuide, index: number): SideGuide {
	const i = stepIndex(guide, index);
	return i === undefined || i === guide.current ? guide : { ...guide, current: i };
}

export function withStatus(guide: SideGuide, index: number, status: SideGuideStatus): SideGuide {
	const i = stepIndex(guide, index);
	return i === undefined || guide.steps[i].status === status ? guide : changeStep(guide, i, { status });
}

export function withNote(guide: SideGuide, index: number, note: string): SideGuide {
	const i = stepIndex(guide, index);
	const text = note.trim();
	return i === undefined ? guide : changeStep(guide, i, { note: text ? clip(text, MAX_GUIDE_NOTE) : undefined });
}

//-------------------
// Edits and sessions

// The lines of a range after a change of the text, as the model layers move. A line in the change goes to the start of
// the change if it is the first line of the range and the change starts after the start of the line. Else it goes to
// the last line of the new text. Lines from 1
function moveRange(first: number, last: number, change: TextChange): [number, number] {
	const { start, end } = change.range;
	const added = change.text.split('\n').length - 1;
	const delta = added - (end.line - start.line);
	const map = (line: number, isFirst: boolean): number => {
		const l = line - 1;
		if (l < start.line) {
			return line;
		}
		if (l > end.line) {
			return line + delta;
		}
		return (isFirst && l === start.line && start.character > 0 ? start.line : start.line + added) + 1;
	};
	const from = map(first, true);
	return [from, Math.max(from, map(last, false))];
}

// The last line of a step with its diff: the diff can have lines of context after the step, and a removed block at the
// end of the file
function stepExtent(s: SideGuideStep): number {
	const d = s.diff;
	return d ? Math.max(s.last, ...d.rows.map((r) => r.at), ...d.removed.map((r) => r.at)) : s.last;
}

// Moves the lines of the diff of a step of a diff walk with a change of the text. A changed line in the change loses the
// box of its changed characters, because its text is new. A removed row keeps its line in the base
function moveStepDiff(diff: SideStepDiff, change: TextChange): SideStepDiff {
	const one = (line: number) => moveRange(line, line, change)[0];
	const isEdited = (line: number) => line - 1 >= change.range.start.line && line - 1 <= change.range.end.line;
	return {
		...diff,
		rows: diff.rows.map((r) => ({ ...r, line: r.kind === 'removed' ? r.line : one(r.line), at: one(r.at) })),
		added: diff.added.map(([a, b]) => moveRange(a, b, change)),
		changed: diff.changed.filter((c) => !isEdited(c.line)).map((c) => ({ ...c, line: one(c.line) })),
		removed: diff.removed.map((r) => ({ ...r, at: one(r.at) })),
	};
}

// Moves the lines of the steps in a file with the changes of an edit. A step whose lines the edit deleted keeps the line
// of the change, so the plan keeps its steps. The diff of a step of a diff walk moves with the step. Returns the same
// guide if no step moved
export function moveGuide(guide: SideGuide, file: string, changes: readonly TextChange[]): SideGuide {
	const key = fileKey(file);
	let isMoved = false;
	const steps = guide.steps.map((s) => {
		if (fileKey(s.file) !== key) {
			return s;
		}
		let [first, last] = [s.first, s.last];
		let diff = s.diff;
		for (const change of changes) {
			// a change after all lines of the step does not move it
			if (change.range.start.line + 1 > stepExtent({ ...s, first, last, diff })) {
				continue;
			}
			[first, last] = moveRange(first, last, change);
			diff = diff && moveStepDiff(diff, change);
		}
		if (first === s.first && last === s.last && diff === s.diff) {
			return s;
		}
		isMoved = true;
		return { ...s, first, last, ...(diff ? { diff } : {}) };
	});
	return isMoved ? { ...guide, steps } : guide;
}

// The diff of a step that moved a number of lines, for a new session
function shiftStepDiff(diff: SideStepDiff, shift: number): SideStepDiff {
	if (shift === 0) {
		return diff;
	}
	return {
		...diff,
		rows: diff.rows.map((r) => ({ ...r, line: r.kind === 'removed' ? r.line : r.line + shift, at: r.at + shift })),
		added: diff.added.map(([a, b]) => [a + shift, b + shift]),
		changed: diff.changed.map((c) => ({ ...c, line: c.line + shift })),
		removed: diff.removed.map((r) => ({ ...r, at: r.at + shift })),
	};
}

// The lines of a file in a session: the text of a line from 1, and the number of lines. Undefined if the file is gone
export type GuideFileLines = (file: string) => { text: (line: number) => string | undefined; count: number } | undefined;

// A guide for a later session of VS Code: the guide, and the text of the first and the last line of each step, with no
// space at the start and the end
export interface StoredGuide {
	guide: SideGuide;
	texts: { first?: string; last?: string }[];
}

export function storeGuide(guide: SideGuide, lines: GuideFileLines): StoredGuide {
	return {
		guide,
		texts: guide.steps.map((s) => {
			const l = lines(s.file);
			return { first: l?.text(s.first)?.trim(), last: l?.text(s.last)?.trim() };
		}),
	};
}

// Finds the steps of a stored guide in the text of a new session. A step moves to the nearest place where its first and
// its last line have their stored texts. A step that the text does not have keeps its lines in the file. A step of a
// file that is gone goes away. Returns undefined if no step stays
export function restoreGuide(stored: StoredGuide, lines: GuideFileLines): SideGuide | undefined {
	const steps: SideGuideStep[] = [];
	let current = stored.guide.current;
	stored.guide.steps.forEach((s, i) => {
		const l = lines(s.file);
		if (!l || l.count < 1) {
			if (i < stored.guide.current) {
				current -= 1;
			}
			return;
		}
		const texts = stored.texts[i] ?? {};
		const isSame = (line: number, text: string | undefined) => text !== undefined && l.text(line)?.trim() === text;
		let shift: number | undefined;
		for (let d = 0; d < l.count && shift === undefined; d++) {
			shift = (d === 0 ? [0] : [d, -d]).find((x) => s.first + x >= 1 && s.last + x <= l.count && isSame(s.first + x, texts.first) && isSame(s.last + x, texts.last));
		}
		const first = Math.min(Math.max(1, s.first + (shift ?? 0)), l.count);
		steps.push({
			...s, first, last: Math.min(Math.max(first, s.last + (shift ?? 0)), l.count), ...(s.diff ? { diff: shiftStepDiff(s.diff, shift ?? 0) } : {}),
		});
	});
	if (steps.length === 0) {
		return undefined;
	}
	return { ...stored.guide, steps, current: Math.min(Math.max(0, current), steps.length - 1) };
}

//-------------------
// Progress and summary

const STATUS_TEXT: Record<SideGuideStatus, string> = { todo: 'not reviewed', ok: 'OK', issue: 'issue', question: 'question' };

// The progress, for example "2 of 5 steps reviewed: 1 issue"
export function guideProgress(guide: SideGuide): string {
	const done = guide.steps.filter((s) => s.status !== 'todo').length;
	const count = (status: SideGuideStatus) => guide.steps.filter((s) => s.status === status).length;
	const issues = count('issue');
	const questions = count('question');
	const marks = [
		...(issues > 0 ? [issues === 1 ? '1 issue' : `${issues} issues`] : []),
		...(questions > 0 ? [questions === 1 ? '1 question' : `${questions} questions`] : []),
	];
	return `${done} of ${guide.steps.length} steps reviewed${marks.length > 0 ? `: ${marks.join(', ')}` : ''}`;
}

// The guide for the model in get_view: the step that the user looks at, and the marks of the user
export function guideFacts(guide: SideGuide): Api.GuideFacts {
	return {
		...(guide.kind === 'diff' ? { kind: 'diff walk', base: guide.base } : {}),
		title: guide.title,
		currentStep: guide.current + 1,
		progress: guideProgress(guide),
		steps: guide.steps.map((s, i) => ({
			step: i + 1, title: s.title, file: s.name, lines: [s.first, s.last], status: s.status, ...(s.note ? { hasNote: true } : {}),
			...(s.diff ? { added: s.diff.plus, removed: s.diff.minus } : {}),
		})),
	};
}

// The summary of the guide in Markdown, for example for a comment on the pull request. A step of a diff walk also gives
// its number of added and removed lines
export function guideSummary(guide: SideGuide): string {
	const out = [`## ${guide.title}`, ''];
	if (guide.summary) {
		out.push(guide.summary, '');
	}
	if (guide.kind === 'diff' && guide.base) {
		out.push(`Changes against ${guide.base}.`, '');
	}
	out.push(`${guideProgress(guide)}.`, '');
	guide.steps.forEach((s, i) => {
		const box = s.status === 'todo' ? '[ ]' : '[x]';
		const lines = s.first === s.last ? `${s.first}` : `${s.first}-${s.last}`;
		const stats = s.diff ? `, +${s.diff.plus} −${s.diff.minus}` : '';
		out.push(`- ${box} ${i + 1}. **${s.title}** (\`${s.name}:${lines}\`${stats}): ${STATUS_TEXT[s.status]}`);
		if (s.note) {
			out.push(...s.note.split(/\r?\n/).map((l) => `  > ${l}`));
		}
	});
	return out.join('\n');
}
