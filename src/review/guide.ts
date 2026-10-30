import * as path from 'path';
import type { SideGuide, SideGuideKind, SideGuideStatus, SideGuideStep } from '../side/protocol';
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

// the limits of the facts of a review, so many files or a large change do not fill the context of the model
export const MAX_REVIEW_FILES = 50;
const MAX_DIFF_LINES = 400;

const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;
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

// A line of the diff for the model: + for an added line, - for a removed line, with the line in the working tree
function diffText(line: DiffLine): string {
	const mark = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
	const at = line.kind === 'removed' ? '' : String(line.newLine);
	return `${mark}${at.padStart(5)} | ${line.text}`;
}

// The facts that the model needs for a plan: the C and C++ files under the paths of the user, with their number of
// lines, and the diff of each changed file against the target branch. The paths are relative to the root. The engine
// does not analyze the files for these facts. The model reads them with the other tools
export function reviewFacts(input: ReviewFilesInput): object {
	const rel = (file: string) => path.relative(input.root, file).replace(/\\/g, '/');
	const files = input.files.slice(0, MAX_REVIEW_FILES).map((f) => {
		if (f.hunks.length === 0) {
			return { file: rel(f.file), lines: f.lineCount, isChanged: false };
		}
		const lines = f.hunks.flatMap((h, i) => [...(i > 0 ? ['  ... |'] : []), ...h.map(diffText)]);
		return {
			file: rel(f.file),
			lines: f.lineCount,
			isChanged: true,
			changedLines: f.hunks.flat().filter((l) => l.kind === 'added').map((l) => l.newLine),
			diff: lines.slice(0, MAX_DIFF_LINES).join('\n'),
			...(lines.length > MAX_DIFF_LINES ? { isDiffTruncated: true } : {}),
		};
	});
	return {
		root: input.root,
		...(input.target ? { target: input.target, base: input.base } : {}),
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
}

export interface GuidePlanInput {
	title?: unknown;
	summary?: unknown;
	steps?: unknown;
}

// The file of a step: its full path and its number of lines. Undefined if the project has no such file
export type GuideFileLookup = (file: string) => { file: string; lineCount: number } | undefined;

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
		} else {
			lastFile = found.file;
		}
		const lines = raw.lines;
		const isPair = Array.isArray(lines) && lines.length === 2 && lines.every((l) => Number.isInteger(l));
		if (!isPair) {
			problems.push(`Step ${n}: "lines" must be two whole numbers, the first and the last line.`);
		} else if (found && (lines[0] < 1 || lines[0] > lines[1] || lines[1] > found.lineCount)) {
			problems.push(`Step ${n}: the lines ${lines[0]} to ${lines[1]} are not in ${fileName(found.file)}, which has ${found.lineCount} lines.`);
		}
		if (raw.kind !== undefined && !GUIDE_KINDS.includes(raw.kind as SideGuideKind)) {
			problems.push(`Step ${n}: "kind" must be one of ${GUIDE_KINDS.join(', ')}.`);
		}
		if (raw.checks !== undefined && (!Array.isArray(raw.checks) || !raw.checks.every((c) => typeof c === 'string'))) {
			problems.push(`Step ${n}: "checks" must be a list of texts.`);
		}
		if (problems.length > 0 || !found || !isPair) {
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
export function guideFacts(guide: SideGuide): object {
	return {
		title: guide.title,
		currentStep: guide.current + 1,
		progress: guideProgress(guide),
		steps: guide.steps.map((s, i) => ({
			step: i + 1, title: s.title, file: s.name, lines: [s.first, s.last], status: s.status, ...(s.note ? { hasNote: true } : {}),
		})),
	};
}

// The summary of the review in Markdown, for example for a comment on the pull request
export function guideSummary(guide: SideGuide): string {
	const out = [`## ${guide.title}`, ''];
	if (guide.summary) {
		out.push(guide.summary, '');
	}
	out.push(`${guideProgress(guide)}.`, '');
	guide.steps.forEach((s, i) => {
		const box = s.status === 'todo' ? '[ ]' : '[x]';
		const lines = s.first === s.last ? `${s.first}` : `${s.first}-${s.last}`;
		out.push(`- ${box} ${i + 1}. **${s.title}** (\`${s.name}:${lines}\`): ${STATUS_TEXT[s.status]}`);
		if (s.note) {
			out.push(...s.note.split(/\r?\n/).map((l) => `  > ${l}`));
		}
	});
	return out.join('\n');
}
