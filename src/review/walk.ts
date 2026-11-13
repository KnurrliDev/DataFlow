import type * as Api from '../../api/dataflow-api';
import * as path from 'path';
import { changedPart } from '../side/model';
import type { SideGuide, SideGuideKind, SideGuideStep, SideStepDiff, SideStepRow } from '../side/protocol';
import { bandText, changedFunctions, HeatChange, HeatFunction, heatFact, HeatModel, hottestChanges, MAX_HOT_CHANGES } from '../lenses/heat';
import type { DiffLine } from './git';
import {
	diffText, GUIDE_KINDS, markedLines, MAX_CHECK, MAX_GUIDE_SUMMARY, MAX_STEP_CHECKS, MAX_STEP_TEXT, MAX_STEP_TITLE,
} from './guide';

// A diff walk: DataFlow or a language model goes through the changes of a diff, one step after the other. Each step has
// the hunks of one file. The side view marks the added and the removed lines of the current step in the code, and the
// tab Guide shows the diff of the step. This file makes the hunks of a diff and the default steps, checks the plan of a
// model, and writes the facts for the model. Lines start at 1, in the working tree.

// A walk has a maximum of this number of steps, so the tab Guide stays short
export const MAX_WALK_STEPS = 40;
// The tab Guide shows a maximum of this number of rows of the diff of a step
const MAX_STEP_ROWS = 160;
// The card of a removed block shows a maximum of this number of lines
const MAX_REMOVED_TEXTS = 40;
// The facts for the model have a maximum of this number of lines of diff, so a large change does not fill the context
// of the model. The model reads the other hunks with the read tools
const MAX_FACT_LINES = 1500;

const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

//-------------------
// The hunks of a diff

// A function of the engine in a changed file
export interface WalkFunction {
	name: string; // the title for the user, for example process()
	qualified: string; // the qualified name, for example electricity::power_ctrl::process
	first: number;
	last: number;
}

export interface WalkFile {
	file: string; // the full path
	lineCount: number; // the number of lines in the working tree
	hunks: DiffLine[][];
	isNew?: boolean; // the base does not have the file
	functions?: WalkFunction[]; // undefined if the engine did not give the functions of the file
}

// The changes of a diff for a walk
export interface WalkInput {
	root: string; // the git repository. The relative paths start at it
	title: string; // the title of a walk of the command, for example "Changes that are not committed"
	base: string; // for example "HEAD (1a2b3c4)" or "main (merge base 1a2b3c4)"
	baseCommit: string;
	files: WalkFile[];
	deleted: string[]; // the C and C++ files that the diff deletes. The side view cannot show them
	other: string[]; // the changed files that are not C or C++ files
	notice?: string;
}

export interface WalkHunk {
	id: string; // h1, h2 and so on, in the sequence of the files and of the lines
	file: string;
	lines: DiffLine[];
	first: number; // the first and the last changed line. A removed block marks the line after it
	last: number;
	plus: number; // the number of added lines
	minus: number; // the number of removed lines
	functions: WalkFunction[]; // the functions with a changed line
	newFunctions: WalkFunction[]; // the functions that the hunk adds with all their lines
	isNewFile: boolean;
}

// The hunks of the files, with an id for each hunk
export function walkHunks(files: readonly WalkFile[]): WalkHunk[] {
	const out: WalkHunk[] = [];
	for (const f of files) {
		for (const lines of f.hunks) {
			const marked = markedLines(lines, f.lineCount);
			if (marked.length === 0) {
				continue;
			}
			const added = new Set(lines.filter((l) => l.kind === 'added').map((l) => l.newLine));
			const functions = (f.functions ?? []).filter((fn) => marked.some((m) => m >= fn.first && m <= fn.last));
			const isAllAdded = (fn: WalkFunction): boolean => {
				for (let line = fn.first; line <= fn.last; line++) {
					if (!added.has(line)) {
						return false;
					}
				}
				return true;
			};
			out.push({
				id: `h${out.length + 1}`,
				file: f.file,
				lines,
				first: marked.reduce((a, b) => Math.min(a, b)),
				last: marked.reduce((a, b) => Math.max(a, b)),
				plus: added.size,
				minus: lines.filter((l) => l.kind === 'removed').length,
				functions,
				newFunctions: functions.filter(isAllAdded),
				isNewFile: !!f.isNew,
			});
		}
	}
	return out;
}

//-------------------
// The default steps

const isSameFunction = (a: WalkHunk, b: WalkHunk) => a.file === b.file && a.functions.length === 1 && b.functions.length === 1
	&& a.functions[0].qualified === b.functions[0].qualified && a.functions[0].first === b.functions[0].first;

// The default steps: the hunks of one function make one step. A hunk in no function, or in more than one function, is
// one step. With more than MAX_WALK_STEPS steps, each file is one step, and the files after MAX_WALK_STEPS files are not
// in the walk
export function walkGroups(hunks: readonly WalkHunk[]): { groups: WalkHunk[][]; skipped: WalkHunk[] } {
	const byFunction: WalkHunk[][] = [];
	for (const h of hunks) {
		const last = byFunction[byFunction.length - 1];
		if (last && isSameFunction(last[last.length - 1], h)) {
			last.push(h);
		} else {
			byFunction.push([h]);
		}
	}
	if (byFunction.length <= MAX_WALK_STEPS) {
		return { groups: byFunction, skipped: [] };
	}
	const byFile: WalkHunk[][] = [];
	for (const h of hunks) {
		const last = byFile[byFile.length - 1];
		if (last && last[0].file === h.file) {
			last.push(h);
		} else {
			byFile.push([h]);
		}
	}
	return { groups: byFile.slice(0, MAX_WALK_STEPS), skipped: byFile.slice(MAX_WALK_STEPS).flat() };
}

// The functions of a list with no copies
const uniqueFunctions = (fns: readonly WalkFunction[]) => [...new Map(fns.map((f) => [`${f.qualified}@${f.first}`, f])).values()];

// The names of functions for a title, for example "a() and b()", or "a(), b() and 3 more"
function namesText(fns: readonly WalkFunction[]): string {
	const names = [...new Set(fns.map((f) => f.name))];
	return names.length <= 2 ? names.join(' and ') : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

// The title of a default step
export function groupTitle(group: readonly WalkHunk[]): string {
	if (group[0].isNewFile) {
		return clip(`New file ${fileName(group[0].file)}`, MAX_STEP_TITLE);
	}
	const fns = uniqueFunctions(group.flatMap((h) => h.functions));
	const added = uniqueFunctions(group.flatMap((h) => h.newFunctions));
	if (fns.length > 0 && added.length === fns.length) {
		return clip(`New ${added.length === 1 ? 'function' : 'functions'} ${namesText(added)}`, MAX_STEP_TITLE);
	}
	if (fns.length > 0) {
		return clip(`Changes in ${namesText(fns)}`, MAX_STEP_TITLE);
	}
	const first = Math.min(...group.map((h) => h.first));
	const last = Math.max(...group.map((h) => h.last));
	return first === last ? `Changes at line ${first}` : `Changes at lines ${first}-${last}`;
}

// The text of a default step: the facts of its changes
export function groupText(group: readonly WalkHunk[]): string {
	const plus = group.reduce((n, h) => n + h.plus, 0);
	const minus = group.reduce((n, h) => n + h.minus, 0);
	if (group[0].isNewFile) {
		return `A new file with ${plural(plus, 'line', 'lines')}.`;
	}
	const fns = uniqueFunctions(group.flatMap((h) => h.functions));
	const counts = [
		...(plus > 0 ? [`${plural(plus, 'line', 'lines')} added`] : []),
		...(minus > 0 ? [`${plural(minus, 'line', 'lines')} removed`] : []),
	].join(', ');
	const where = fns.length === 1 ? ` in \`${fns[0].qualified}\`` : fns.length > 1 ? ` in ${fns.length} functions` : '';
	const parts = group.length > 1 ? ` The step has ${group.length} parts of the diff.` : '';
	return `${counts}${where}.${parts}`;
}

//-------------------
// The steps

// The diff of a step: the rows for the tab Guide, and the marks of the code view. A run of removed lines and the added
// lines after it make pairs, as in the story of Change Ripple: removed line k and added line k
export function stepDiff(group: readonly WalkHunk[]): SideStepDiff {
	const rows: SideStepRow[] = [];
	const added: [number, number][] = [];
	const changed: SideStepDiff['changed'] = [];
	const removed: SideStepDiff['removed'] = [];
	let plus = 0;
	let minus = 0;
	group.forEach((h, n) => {
		const hunk = h.lines;
		if (n > 0) {
			const before = group[n - 1].lines;
			const after = before[before.length - 1];
			const gap = hunk[0].newLine - after.newLine - (after.kind === 'removed' ? 0 : 1);
			rows.push({ kind: 'fold', line: hunk[0].newLine, at: hunk[0].newLine, text: '', count: Math.max(0, gap) });
		}
		for (let i = 0; i < hunk.length;) {
			if (hunk[i].kind === 'context') {
				rows.push({ kind: 'context', line: hunk[i].newLine, at: hunk[i].newLine, text: hunk[i].text });
				i++;
				continue;
			}
			let j = i;
			while (j < hunk.length && hunk[j].kind === 'removed') {
				j++;
			}
			let k = j;
			while (k < hunk.length && hunk[k].kind === 'added') {
				k++;
			}
			const rem = hunk.slice(i, j);
			const add = hunk.slice(j, k);
			rem.forEach((r, m) => {
				const part = add[m] ? changedPart(r.text, add[m].text, true) : undefined;
				rows.push({ kind: 'removed', line: r.oldLine ?? r.newLine, at: r.newLine, text: r.text, ...(part ? { changed: part } : {}) });
			});
			add.forEach((a, m) => {
				const part = rem[m] ? changedPart(rem[m].text, a.text, false) : undefined;
				rows.push({ kind: 'added', line: a.newLine, at: a.newLine, text: a.text, ...(part ? { changed: part } : {}) });
				if (part) {
					changed.push({ line: a.newLine, start: part[0], end: part[1] });
				}
			});
			if (add.length > 0) {
				added.push([add[0].newLine, add[add.length - 1].newLine]);
			}
			if (rem.length > 0) {
				removed.push({ at: rem[0].newLine, count: rem.length, texts: rem.slice(0, MAX_REMOVED_TEXTS).map((r) => r.text) });
			}
			plus += add.length;
			minus += rem.length;
			i = k;
		}
	});
	if (rows.length > MAX_STEP_ROWS) {
		const hidden = rows.length - MAX_STEP_ROWS;
		const at = rows[MAX_STEP_ROWS].at;
		rows.length = MAX_STEP_ROWS;
		rows.push({ kind: 'fold', line: at, at, text: '', count: hidden });
	}
	return { rows, added, changed, removed, plus, minus };
}

// A step with the hunks of one file, from the first changed line of its hunks to the last changed line
function walkStep(group: readonly WalkHunk[], fields: { title: string; text: string; checks?: string[]; kind?: SideGuideKind }): SideGuideStep {
	const file = group[0].file;
	return {
		title: fields.title,
		file,
		name: fileName(file),
		first: Math.min(...group.map((h) => h.first)),
		last: Math.max(...group.map((h) => h.last)),
		text: fields.text,
		checks: fields.checks ?? [],
		...(fields.kind ? { kind: fields.kind } : {}),
		status: 'todo',
		diff: stepDiff(group),
	};
}

// The paths of a list for a text, relative to the root, with a maximum of four names
function pathsText(root: string, files: readonly string[]): string {
	const names = files.map((f) => path.relative(root, f).replace(/\\/g, '/'));
	return names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`;
}

// The summary of a walk of the command: the number of files and of changed lines, and the files that the walk does not show
function walkSummary(input: WalkInput, hunks: readonly WalkHunk[], skipped: readonly WalkHunk[]): string {
	const files = new Set(hunks.map((h) => h.file)).size;
	const plus = hunks.reduce((n, h) => n + h.plus, 0);
	const minus = hunks.reduce((n, h) => n + h.minus, 0);
	const out = [`${plural(files, 'file', 'files')}: ${plural(plus, 'line', 'lines')} added, ${plural(minus, 'line', 'lines')} removed.`];
	if (input.deleted.length > 0) {
		out.push(`Deleted files: ${pathsText(input.root, input.deleted)}.`);
	}
	if (input.other.length > 0) {
		out.push(`Changed files that are not C or C++ files: ${pathsText(input.root, input.other)}.`);
	}
	if (skipped.length > 0) {
		const skippedFiles = [...new Set(skipped.map((h) => h.file))];
		out.push(`A walk has a maximum of ${MAX_WALK_STEPS} steps, so the changes of ${pathsText(input.root, skippedFiles)} are not in the walk.`);
	}
	if (input.notice) {
		out.push(input.notice);
	}
	return clip(out.join(' '), MAX_GUIDE_SUMMARY);
}

// The title of a walk of the command against a ref. HEAD gives the changes that are not committed. A local or a remote
// branch gives the changes of the active branch against the branch. A commit or a tag gives the changes since the ref.
export function walkTitle(ref: string, branches: { local: string[]; remote: string[] }, active: string | undefined): string {
	if (ref === 'HEAD') {
		return 'Changes that are not committed';
	}
	if (!branches.local.includes(ref) && !branches.remote.includes(ref)) {
		return `Changes since ${ref}`;
	}
	return active ? `Changes of ${active} against ${ref}` : `Changes against ${ref}`;
}

// The walk of the command: the default steps with the facts of their changes. Undefined if the diff has no hunk
export function commandWalk(input: WalkInput, seq: number): SideGuide | undefined {
	const hunks = walkHunks(input.files);
	if (hunks.length === 0) {
		return undefined;
	}
	const { groups, skipped } = walkGroups(hunks);
	return {
		kind: 'diff',
		title: clip(input.title, MAX_STEP_TITLE),
		summary: walkSummary(input, hunks, skipped),
		base: input.base,
		baseCommit: input.baseCommit,
		steps: groups.map((g) => walkStep(g, { title: groupTitle(g), text: groupText(g) })),
		current: 0,
		seq,
	};
}

//-------------------
// The plan of a model

export interface WalkStepInput {
	title?: unknown;
	text?: unknown;
	hunks?: unknown;
	checks?: unknown;
	kind?: unknown;
}

export interface WalkPlanInput {
	title?: unknown;
	summary?: unknown;
	steps?: unknown;
	allHunks?: boolean; // false: no steps for the hunks that no step names. Default: true
}

// The ids of hunks for a text, for example "h1, h4 and h7"
function idsText(ids: readonly string[]): string {
	return ids.length <= 1 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

// Checks the plan of a model for a diff walk. Each step names its hunks with the ids of get_diff, and all hunks of a
// step are in one file. The hunks that no step names get default steps after the steps of the plan, so the walk shows
// all changes. With allHunks false, the walk has only the steps of the plan, and notShown names the other hunks. The
// result has a problem for each wrong step, so the model can correct all of them in one call
export function resolveWalkPlan(input: WalkPlanInput, hunks: readonly WalkHunk[], options: { input: WalkInput; seq: number; client?: string }):
	{ guide?: SideGuide; problems: string[]; added: WalkHunk[][]; notShown: string[] } {
	if (!Array.isArray(input.steps) || input.steps.length === 0) {
		return { problems: ['Give "steps": a list with one step or more.'], added: [], notShown: [] };
	}
	if (input.steps.length > MAX_WALK_STEPS) {
		return { problems: [`Give ${MAX_WALK_STEPS} steps at most. The plan has ${input.steps.length} steps.`], added: [], notShown: [] };
	}
	const problems: string[] = [];
	const indexOf = new Map(hunks.map((h, i) => [h.id, i]));
	const used = new Set<string>();
	const planned: { group: WalkHunk[]; raw: WalkStepInput }[] = [];
	input.steps.forEach((raw: WalkStepInput, i) => {
		const n = i + 1;
		if (!raw || typeof raw !== 'object') {
			problems.push(`Step ${n} is not an object.`);
			return;
		}
		const before = problems.length;
		if (!isText(raw.title)) {
			problems.push(`Step ${n} has no "title".`);
		}
		if (!isText(raw.text)) {
			problems.push(`Step ${n} has no "text".`);
		}
		let group: WalkHunk[] | undefined;
		const ids = raw.hunks;
		if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
			problems.push(`Step ${n}: "hunks" must be a list of one hunk id or more, for example ["h1", "h2"].`);
		} else {
			const unknown = ids.filter((id: string) => !indexOf.has(id.trim()));
			if (unknown.length > 0) {
				const range = hunks.length === 1 ? 'The diff has only the hunk h1.' : `The hunks of get_diff are h1 to h${hunks.length}.`;
				problems.push(`Step ${n}: ${idsText(unknown)} ${unknown.length === 1 ? 'is' : 'are'} not in the diff. ${range}`);
			} else {
				group = [...new Set(ids.map((id: string) => indexOf.get(id.trim())!))].sort((a, b) => a - b).map((x) => hunks[x]);
				const files = new Set(group.map((h) => h.file));
				if (files.size > 1) {
					problems.push(`Step ${n}: the hunks ${idsText(group.map((h) => h.id))} are in ${files.size} files. All hunks of a step must be in one file, so make one step for each file.`);
				}
			}
		}
		if (raw.kind !== undefined && !GUIDE_KINDS.includes(raw.kind as SideGuideKind)) {
			problems.push(`Step ${n}: "kind" must be one of ${GUIDE_KINDS.join(', ')}.`);
		}
		if (raw.checks !== undefined && (!Array.isArray(raw.checks) || !raw.checks.every((c) => typeof c === 'string'))) {
			problems.push(`Step ${n}: "checks" must be a list of texts.`);
		}
		if (problems.length === before && group) {
			planned.push({ group, raw });
			group.forEach((h) => used.add(h.id));
		}
	});
	if (problems.length > 0) {
		return { problems, added: [], notShown: [] };
	}
	const rest = hunks.filter((h) => !used.has(h.id));
	const isAll = input.allHunks !== false;
	const restGroups = isAll ? walkGroups(rest) : { groups: [], skipped: [] };
	if (restGroups.skipped.length > 0 || planned.length + restGroups.groups.length > MAX_WALK_STEPS) {
		return {
			problems: [`The hunks ${idsText(rest.map((h) => h.id))} are in no step. They need more steps, and a walk has a maximum of ${MAX_WALK_STEPS} steps. `
				+ 'Put these hunks in the steps of the plan, or give allHunks false.'],
			added: [],
			notShown: [],
		};
	}
	const steps = [
		...planned.map(({ group, raw }) => walkStep(group, {
			title: clip((raw.title as string).trim(), MAX_STEP_TITLE),
			text: clip((raw.text as string).trim(), MAX_STEP_TEXT),
			checks: ((raw.checks as string[] | undefined) ?? []).filter(isText).slice(0, MAX_STEP_CHECKS).map((c) => clip(c.trim(), MAX_CHECK)),
			kind: raw.kind as SideGuideKind | undefined,
		})),
		...restGroups.groups.map((g) => walkStep(g, {
			title: groupTitle(g), text: `${groupText(g)} The plan of the model has no step for this change, so DataFlow added this step.`,
		})),
	];
	return {
		guide: {
			kind: 'diff',
			title: isText(input.title) ? clip(input.title.trim(), MAX_STEP_TITLE) : clip(options.input.title, MAX_STEP_TITLE),
			...(isText(input.summary) ? { summary: clip(input.summary.trim(), MAX_GUIDE_SUMMARY) } : {}),
			...(options.client ? { client: options.client } : {}),
			base: options.input.base,
			baseCommit: options.input.baseCommit,
			steps,
			current: 0,
			seq: options.seq,
		},
		problems: [],
		added: restGroups.groups,
		notShown: isAll ? [] : rest.map((h) => h.id),
	};
}

//-------------------
// The facts for the model

// The facts of a diff for the model in get_diff: the hunks of each changed file with their ids and their diff, and the
// default steps. The paths are relative to the root. The diff of a hunk after MAX_FACT_LINES lines is not in the facts.
// With the heat of the changed files, each hunk has the heat of the functions that it changes, and hottestChanges gives
// the changed functions, the hottest first
export function walkFacts(input: WalkInput, hunks: readonly WalkHunk[], heat?: ReadonlyMap<string, HeatModel>): Omit<Api.DiffFacts, 'note' | 'callGraph' | 'noHeat'> {
	const rel = (file: string) => path.relative(input.root, file).replace(/\\/g, '/');

	// the changed functions of each hunk with their heat, and each changed function with its hunks
	const heatOf = new Map<string, HeatFunction[]>();
	const changes = new Map<string, HeatChange>();
	for (const h of hunks) {
		const model = heat?.get(h.file);
		if (!model) {
			continue;
		}
		const lineCount = input.files.find((f) => f.file === h.file)?.lineCount ?? h.last;
		const fns = changedFunctions(model, markedLines(h.lines, lineCount));
		heatOf.set(h.id, fns);
		for (const fn of fns) {
			const key = `${h.file}\n${fn.first}`;
			const change = changes.get(key) ?? { file: h.file, fn, hunks: [] };
			change.hunks.push(h.id);
			changes.set(key, change);
		}
	}
	const stepHeat = (group: readonly WalkHunk[]) => Math.max(-1, ...group.flatMap((h) => (heatOf.get(h.id) ?? []).map((fn) => fn.score)));

	let left = MAX_FACT_LINES;
	const files = input.files.map((f): Api.DiffFacts['files'][number] => ({
		file: rel(f.file),
		lines: f.lineCount,
		...(f.isNew ? { isNew: true } : {}),
		hunks: hunks.filter((h) => h.file === f.file).map((h) => {
			const text = h.lines.map(diffText);
			const isShown = text.length <= left;
			if (isShown) {
				left -= text.length;
			}
			const fns = heatOf.get(h.id) ?? [];
			return {
				id: h.id,
				lines: [h.first, h.last],
				added: h.plus,
				removed: h.minus,
				...(h.functions.length > 0 ? { functions: h.functions.map((fn) => fn.qualified) } : {}),
				...(h.newFunctions.length > 0 ? { newFunctions: h.newFunctions.map((fn) => fn.qualified) } : {}),
				...(fns.length > 0 ? {
					heat: fns.map((fn) => ({ function: fn.qualifiedName || fn.name, score: fn.score, band: bandText(fn.band), isReachComplete: fn.isReachComplete })),
				} : {}),
				...(isShown ? { diff: text.join('\n') } : { isDiffTruncated: true }),
			};
		}),
	})).filter((f) => f.hunks.length > 0);
	const { groups, skipped } = walkGroups(hunks);
	return {
		root: input.root,
		base: input.base,
		...(changes.size > 0 ? {
			hottestChanges: hottestChanges([...changes.values()], MAX_HOT_CHANGES).map((c) => ({ ...heatFact(c.fn), file: rel(c.file), hunks: c.hunks })),
		} : {}),
		files,
		suggestedSteps: groups.map((g) => {
			const score = stepHeat(g);
			return { title: groupTitle(g), hunks: g.map((h) => h.id), ...(score >= 0 ? { heat: score } : {}) };
		}),
		...(skipped.length > 0 ? { notInSuggestedSteps: skipped.map((h) => h.id) } : {}),
		...(input.deleted.length > 0 ? { deletedFiles: input.deleted.map(rel) } : {}),
		...(input.other.length > 0 ? { otherChangedFiles: input.other.map(rel) } : {}),
		...(input.notice ? { notice: input.notice } : {}),
	};
}
