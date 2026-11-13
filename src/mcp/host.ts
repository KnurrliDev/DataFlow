import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isInside } from '../cdb/project';
import type { CallersModel, EngineClient, EngineFunction, FileResult, LogicModel, LogicOptions, StructureModel } from '../engine/client';
import {
	addDetail, functionLines, MAX_DETAILS, mergeComments, ModelBlockInput, ModelCommentInput, ModelDetailInput, ModelNoteInput, moveModelLayer, ownerOf,
	resolveComments, resolveDetail, resolveNotes, snapBlocks, structureSummary, TextChange, withIds,
} from '../lenses/blocks';
import { callFunctionAt, ExternalCaller } from '../lenses/calls';
import { findingText, LineText, toUtf16Column, toUtf8Column, variableAt } from '../lenses/flow';
import { bandText, HeatModel, unknownCallersText } from '../lenses/heat';
import { buildSideIncludes } from '../lenses/includes';
import { checkChoices, logicFacts } from '../lenses/logic';
import { bodyLabel, fileKey, memberLabel, memberSummary, threadOf } from '../lenses/member';
import { ReviewState, rippleFacts } from '../lenses/ripple';
import { buildSideThreads } from '../lenses/threads';
import { buildControls, Choices, Control } from '../logic/paths';
import { INCLUDE_FILE, isCppFile } from '../review/git';
import {
	guideFacts, GuidePlanInput, guideProgress, GUIDE_STATUSES, GUIDE_TYPES, guideType, MAX_REVIEW_FILES, resolveGuidePlan, reviewFacts, ReviewFilesInput, stepIndex,
	withNote, withStatus,
} from '../review/guide';
import type { RippleModel } from '../review/ripple';
import { groupTitle, resolveWalkPlan, walkFacts, walkHunks, type WalkHunk, type WalkInput, type WalkPlanInput } from '../review/walk';
import type { SideViewController } from '../side/controller';
import type { CodePlace } from '../side/details';
import { functionTitle } from '../side/names';
import { typeNameColumns } from '../side/outline';
import type { SideGuideStatus, SideModel, SideOutlineData, SideOutlineMember, SideOutlinePlace } from '../side/protocol';
import { LENSES, type CallGraphView, type Lens, type StateStore } from '../state/store';
import type * as Api from '../../api/dataflow-api';
import type { FunctionArg, McpHost } from './tools';

// The host of the MCP tools: it gets the data from the engine, and it changes the side view. Each tool works on a file
// of the project. Without a file, a tool uses the file of the active C++ editor. If no C++ editor shows, for example
// while the focus is in the terminal of the MCP client, it uses the file of the side view. With no C++ text editor on
// the screen, for example with Claude Code in the other editor group, the view tools move only the side view.

export interface HostDeps {
	engine(): EngineClient | undefined;
	store: StateStore;
	side: SideViewController;
	currentEditor(): vscode.TextEditor | undefined;
	// the cursor of the C++ editor, else the cursor of the side view
	currentPlace(): { doc: vscode.TextDocument; pos: vscode.Position } | undefined;
	asyncFunctions(uri: vscode.Uri): string[];
	readFunctions(uri: vscode.Uri): string[]; // the functions that only read their arguments, from dataflow.flow.readFunctions
	eventFunctions(uri: vscode.Uri): string[];
	minCopyBytes(uri: vscode.Uri): number;
	headerUnit(doc: vscode.TextDocument): Promise<string | undefined>; // a source file that includes a header with a template
	roots(): string[]; // the folders of the project
	flushChange(doc: vscode.TextDocument): void; // sends a change that waits for its timer
	trace(doc: vscode.TextDocument, pos: vscode.Position): Promise<void>; // starts Flow Lens at the position
	client(): string | undefined; // the name of the MCP client
	// the callers of the function at a position from the call hierarchy of VS Code. Lines from 1, a column of UTF-8 bytes
	// from 1. undefined if no provider answers for C++, 'failed' if the provider failed
	incomingCalls(file: string, line: number, col: number): Promise<ExternalCaller[] | undefined | 'failed'>;
	// the C and C++ files under the paths that the user wants to review, with their changes against the target branch of
	// the git repository, or the reason why no file is available. Paths are absolute, or relative to the project
	reviewFiles(paths: string[]): Promise<ReviewFilesInput | { message: string }>;
	// the changes of a diff walk against a base: "uncommitted", "target", or a commit, a tag or a branch. With paths, only
	// the files under the paths. Or the reason why no diff is available
	walkInput(base: string | undefined, paths?: string[]): Promise<WalkInput | { message: string }>;
	// the header with the definition of a type that a translation unit only declares: the definition provider of VS Code
	// at the place of the name, if a place is known, else a search of the headers of the project
	definitionHeader(name: string, place?: { doc: vscode.TextDocument; pos: vscode.Position }): Promise<string | undefined>;
	// the heat of the functions of a document. The side view does not change
	heat(doc: vscode.TextDocument): Promise<HeatModel>;
	// the callers of a function from the call graph of the engine, at a position with UTF-8 columns from 1. A call graph
	// that is not complete starts its scan, as for the heat
	callers(doc: vscode.TextDocument, at: { line: number; col: number }, depth: number): Promise<FileResult & CallersModel>;
	// the options of Logic Map for a document: the settings of the event functions, of the functions that can give null,
	// and of the null checks
	logicOptions(doc: vscode.TextDocument): LogicOptions;
	// shows the path of Logic Map in a function with the choices of a client, and turns Logic Map on. line is the line of
	// the cursor in the function: Logic Map does not change the choices for this line
	showLogicPath(doc: vscode.TextDocument, model: LogicModel, choices: Choices, line: number): void;
	// turns a lens of the side view on or off, as its switch does
	setLens(lens: Lens, isOn: boolean): void;
	// removes the trace of Flow Lens, as the command Clear Trace does. false if no trace showed
	clearFlow(): boolean;
	// the last review of Change Ripple: its state in the side view, its result, and the root of its repository
	ripple(): { state?: ReviewState; model?: RippleModel; root?: string };
	// runs a review of Change Ripple, as the command Review Changes does, and gives its result. undefined if it failed
	startRipple(): Promise<RippleModel | undefined>;
	// closes Change Ripple, as the button Clear of its bar does. false if no review showed
	clearRipple(): boolean;
	// starts the scan of the call graph, or the scan of the changed files, as the button Scan of the tab Heat does
	scanCallGraph(): void;
	// stops the scan of the call graph, as the button Stop does. false if no scan ran
	stopCallGraph(): boolean;
	// the host of an extension through the API: its notes, details and steps can have buttons. An MCP client gets no
	// event for a click
	isExtension?: boolean;
}

const CPP_LANGUAGES = new Set(['c', 'cpp', 'cuda-cpp']);
const isCpp = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && CPP_LANGUAGES.has(doc.languageId);
const MAX_ITEMS = 200;
// get_review and get_diff compute the heat of the changed files in this time. A file after the time has no heat
const HEAT_FILES_MS = 30000;

// The parse errors of a result, so that the model knows that the facts can be incomplete
function parseNote(res: FileResult): Api.ParseNote {
	return res.errorCount > 0 ? { parseErrors: res.errors.slice(0, 5) } : {};
}

// The outline of a type for a language model: lines from 1, no columns. A member in a different file gets its file. The
// members of the bases give only their names, because a base like AActor has more than a thousand members
const MAX_INHERITED_NAMES = 40;

function outlineFacts(o: SideOutlineData): Omit<Api.OutlineFacts, 'parseErrors'> {
	const place = (p: SideOutlinePlace) => ({ file: p.file, line: p.line });
	const member = (m: SideOutlineMember) => ({
		line: m.line, kind: m.kind, name: m.name,
		...(m.text ? { text: m.text } : {}),
		...(m.access ? { access: m.access } : {}),
		...(m.marks?.length ? { marks: m.marks } : {}),
		...(m.section ? { section: m.section } : {}),
		...(m.annotation ? { annotation: m.annotation } : {}),
		...(m.macro ? { macro: m.macro } : {}),
		...(m.offset !== undefined ? { offset: m.offset, size: m.size } : {}),
		...(m.file !== o.file ? { file: m.file } : {}),
		...(m.definition ? { definition: place(m.definition) } : {}),
	});
	return {
		file: o.file, line: o.line, type: o.qualifiedName, kind: o.kind,
		...(o.template ? { template: o.template } : {}),
		...(o.underlying ? { underlying: o.underlying } : {}),
		...(o.isFinal ? { final: true } : {}),
		...(o.isAbstract ? { abstract: true } : {}),
		...(o.isLibrary ? { library: true } : {}),
		bases: o.bases.map((b) => ({ name: b.name, access: b.access, ...(b.isVirtual ? { virtual: true } : {}), ...(b.offset !== undefined ? { offset: b.offset, size: b.size } : {}) })),
		...(o.layout ? { layout: { size: o.layout.size, align: o.layout.align, padding: o.layout.padding, ...(o.layout.hasVPtr ? { vptr: true } : {}), holes: o.layout.holes } } : {}),
		members: o.members.slice(0, MAX_ITEMS).map(member),
		...(o.members.length > MAX_ITEMS ? { more: o.members.length - MAX_ITEMS } : {}),
		inherited: o.inherited.map((g) => ({
			base: g.base, count: g.members.length, names: g.members.slice(0, MAX_INHERITED_NAMES).map((m) => m.name),
		})),
		...(o.isTruncated ? { truncated: true } : {}),
	};
}

// The state of the scan of the call graph, and the counts of the last complete scan
export function callGraphFacts(graph: CallGraphView | undefined): Api.CallGraphFacts {
	if (!graph) {
		return { state: 'none' };
	}
	const result = graph.result;
	return {
		state: graph.state, done: graph.done, total: graph.total, ...(graph.error ? { error: graph.error } : {}),
		...(result ? {
			lastScan: {
				functions: result.functions, calls: result.calls, sourceFiles: result.units, isComplete: result.isComplete,
				frames: result.frames.slice(0, MAX_ITEMS).map((f) => ({ function: f.name, file: f.file, line: f.line, reason: f.reason })),
				...(result.failed.length > 0 ? { failed: result.failed.slice(0, MAX_ITEMS) } : {}),
			},
		} : {}),
		...(graph.state === 'scanning' ? { note: 'The scan runs. get_heat gives the callers and the frame paths after its end.' } : {}),
	};
}

// True if a step of a plan has buttons
const hasStepActions = (steps: unknown): boolean =>
	Array.isArray(steps) && steps.some((s) => !!s && typeof s === 'object' && (s as { actions?: unknown }).actions !== undefined);

// A position in the function for the engine: the start of its body
function positionOf(fn: EngineFunction): { line: number; col: number } {
	return fn.body ? { line: fn.body.begin.line, col: fn.body.begin.col } : { line: fn.range.begin.line, col: fn.range.begin.col };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The UTF-16 column of a name on a line. For charge.is_dirty, the column of is_dirty after charge. -1 if the line has
// no such name
export function nameColumn(text: string, name: string): number {
	const parts = name.split(/\.|->|::/).filter(Boolean);
	const last = parts[parts.length - 1] ?? name;
	if (parts.length > 1) {
		const pattern = parts.map(escapeRegExp).join('\\s*(?:\\.|->|::)\\s*');
		const m = new RegExp(`\\b${pattern}\\b`).exec(text);
		if (m) {
			return m.index + m[0].length - last.length;
		}
	}
	const m = new RegExp(`\\b${escapeRegExp(last)}\\b`).exec(text);
	return m ? m.index : -1;
}

export class DataFlowMcpHost implements McpHost {
	// the folder and the target branch of the last get_review, for the relative paths of a plan
	private lastReview?: { root: string; target?: string };
	// the changes and the hunks of the last get_diff, for the ids of the hunks in show_diff_walk
	private lastWalk?: { input: WalkInput; hunks: WalkHunk[] };

	constructor(private readonly deps: HostDeps) {}

	//-------------------
	// Read tools

	async view(): Promise<Api.ViewFacts> {
		const { store, side } = this.deps;
		const state = store.state;
		const editor = this.deps.currentEditor();
		const editorDoc = editor && isCpp(editor.document) ? editor.document : undefined;
		const shown = editorDoc ? undefined : side.file;
		const doc = editorDoc ?? (shown ? vscode.workspace.textDocuments.find((d) => fileKey(d.uri.fsPath) === fileKey(shown)) : undefined);
		const file = editorDoc?.uri.fsPath ?? shown;
		const fn = file && state.file === file && state.fn ? state.fn : undefined;
		const selection = doc ? this.selectionOf(doc) : undefined;
		const place = this.deps.currentPlace();
		const cursor = place && file && fileKey(place.doc.uri.fsPath) === fileKey(file) ? place.pos : undefined;
		const layer = file ? this.layerOf(file) : undefined;
		return {
			file: file ?? null,
			lineCount: doc?.lineCount,
			cursor: cursor ? { line: cursor.line + 1, col: cursor.character + 1 } : null,
			selection: doc && selection ? {
				lines: [selection.line, selection.endLine], start: { line: selection.line, col: selection.col + 1 },
				end: { line: selection.endLine, col: selection.endCol + 1 },
				text: doc.getText(new vscode.Range(selection.line - 1, selection.col, selection.endLine - 1, selection.endCol)).slice(0, 2000),
			} : null,
			function: fn ? { name: fn.qualifiedName, ...(fn.macroCall ? { macroCall: fn.macroCall } : {}), lines: [fn.range.begin.line, fn.range.end.line] } : null,
			otherFiles: vscode.window.visibleTextEditors.filter((e) => e.document !== doc && isCpp(e.document)).map((e) => e.document.uri.fsPath),
			sideView: {
				isOpen: side.isOpen, file: side.file ?? null, lenses: Object.entries(state.lenses).filter(([, on]) => on).map(([lens]) => lens),
				modelLayersShown: state.isModelShown,
			},
			model: layer ? {
				functions: [...new Set(layer.blocks.map((b) => b.fn))].map((fn) => ({
					function: fn, blocks: layer.blocks.filter((b) => b.fn === fn).map((b) => `${b.id} ${b.title} (${b.first}-${b.last})`),
				})),
				notes: layer.notes.length, comments: layer.comments.length, details: layer.details.map((d) => `${d.id} ${d.title} (${d.line}-${d.endLine})`),
			} : null,
			...(file ? { otherClients: this.otherLayers(file).map((l) => ({
				client: ownerOf(l), blocks: l.blocks.length, notes: l.notes.length, comments: l.comments.length, details: l.details.length,
			})) } : {}),
			review: state.guide ? guideFacts(state.guide) : null,
			engine: state.engine,
			project: { folders: this.roots(), compileDatabases: state.databases.map((d) => d.makefile ?? d.path) },
		};
	}

	async functions(file?: string): Promise<Api.FunctionListFacts> {
		const { client, file: f } = await this.prepare(file);
		const res = await client.functions(f);
		return {
			file: f,
			functions: res.functions.map((fn) => ({
				name: fn.qualifiedName || fn.name, ...(fn.macroCall ? { macroCall: fn.macroCall } : {}), kind: fn.kind,
				lines: [fn.range.begin.line, fn.range.end.line],
			})),
			...parseNote(res),
		};
	}

	async structure(file: string | undefined, fn: FunctionArg): Promise<Api.StructureFacts> {
		const { doc, model } = await this.structureModel(file, fn);
		return { file: doc.uri.fsPath, ...structureSummary(model), ...parseNote(model) };
	}

	async flow(file: string | undefined, line: number, name: string, show: boolean): Promise<Api.FlowFacts> {
		const { client, doc, file: f } = await this.prepare(file);
		if (line > doc.lineCount) {
			throw new Error(`${path.basename(f)} has ${doc.lineCount} lines.`);
		}
		const text = doc.lineAt(line - 1).text;
		const character = nameColumn(text, name);
		if (character < 0) {
			throw new Error(`Line ${line} has no "${name}": ${text.trim()}`);
		}
		const pos = new vscode.Position(line - 1, character);
		const lineText: LineText = (l) => (l >= 0 && l < doc.lineCount ? doc.lineAt(l).text : undefined);
		if (show) {
			await this.reveal(doc, pos, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			await this.deps.trace(doc, pos);
		}
		const at = { line, col: toUtf8Column(text, character) };
		const shown = show ? { shown: true } : {};

		// a variable of the function
		const flow = await client.flow(f, at, { readFunctions: this.deps.readFunctions(doc.uri) }).catch(() => undefined);
		const index = flow ? variableAt(flow, line - 1, character, lineText) : undefined;
		if (flow && index !== undefined) {
			const v = flow.variables[index];
			return {
				kind: 'variable', name: v.name, type: v.type, storage: v.storage, function: flow.function.qualifiedName,
				refs: flow.refs.filter((r) => r.var === index).map((r) => ({ line: r.line, role: r.role, ...(r.finding ? { finding: findingText(r.finding) } : {}) })),
				...shown,
			};
		}

		// a data member of a class, a static data member or a global variable
		const member = await client.member(f, at, {
			asyncFunctions: this.deps.asyncFunctions(doc.uri), readFunctions: this.deps.readFunctions(doc.uri), roots: this.roots(),
		}).catch(() => undefined);
		if (member) {
			const summary = memberSummary(member);
			const fileOf = (file: string) => (fileKey(file) === fileKey(f) ? undefined : file);
			// the threads of an access: more than one if more than one thread calls its function
			const threadLabel = (t: number) => (t < 0 ? 'caller' : member.threads[t].via);
			return {
				kind: member.member.kind === 'global' ? 'global' : member.member.kind === 'static' ? 'static member' : 'member',
				name: memberLabel(member), type: member.member.type, access: member.member.access,
				...(member.member.isAtomic ? { atomic: true } : {}),
				refs: member.refs.slice(0, MAX_ITEMS).map((r) => ({
					...(fileOf(r.file) ? { file: r.file } : {}), line: r.line, role: r.role, function: bodyLabel(member, r.fn),
					thread: threadOf(member, r.fn)?.label ?? 'caller', ...(r.locks?.length ? { locks: r.locks } : {}),
					...(r.runs && r.runs.length > 1 ? { threads: [...new Set(r.runs.map((x) => threadLabel(x.thread)))] } : {}),
				})),
				threads: summary.threads,
				locks: summary.locks,
				...(summary.verdict ? { verdict: { kind: summary.verdict.kind, text: summary.verdict.text } } : {}),
				...shown,
			};
		}
		throw new Error(`No variable or data member "${name}" on line ${line}.`);
	}

	async calls(file: string | undefined, fn: FunctionArg): Promise<Api.CallFacts> {
		const { client, doc, file: f } = await this.prepare(file);
		const at = await this.selector(client, doc, fn);
		const model = await client.calls(f, {
			eventFunctions: this.deps.eventFunctions(doc.uri), asyncFunctions: this.deps.asyncFunctions(doc.uri), roots: this.roots(),
		});
		const focus = callFunctionAt(model, at.line);
		if (focus < 0) {
			throw new Error(`No function on line ${at.line}.`);
		}
		const name = (i: number) => model.functions[i].qualifiedName || `lambda on line ${model.functions[i].line}`;
		const site = (s: (typeof model.calls)[number]) => ({
			line: s.line, result: s.result,
			...(s.async ? { async: s.async } : {}), ...(s.event ? { event: true } : {}), ...(s.writes?.length ? { writes: s.writes } : {}),
			...(s.into ? { into: s.into } : {}), ...(s.optional ? { optional: s.optional } : {}), ...(s.uncheckedLine ? { uncheckedLine: s.uncheckedLine } : {}),
			...(s.virtualOf !== undefined ? { virtualOf: name(s.virtualOf) } : {}),
		});
		// the callers in other files come from the call hierarchy of VS Code, with no data of the calls. A lambda has no
		// callers in other files
		const info = model.functions[focus];
		const external = info.qualifiedName ? await this.deps.incomingCalls(f, info.line, info.col) : [];
		const others = Array.isArray(external) ? external.filter((c) => fileKey(c.file) !== fileKey(f)) : [];
		return {
			file: f,
			function: name(focus),
			callers: model.calls.filter((s) => s.to === focus).slice(0, MAX_ITEMS).map((s) => ({ caller: name(s.from), ...site(s) })),
			calls: model.calls.filter((s) => s.from === focus).slice(0, MAX_ITEMS).map((s) => ({ callee: name(s.to), where: model.functions[s.to].where, ...site(s) })),
			callersInOtherFiles: others.slice(0, MAX_ITEMS).map((c) => ({ caller: c.name, file: c.file, line: c.line, callLines: c.sites.map((s) => s.line) })),
			note: external === 'failed'
				? 'The call hierarchy of the C/C++ extension failed, so the callers in other files are not in this result.'
				: external === undefined
					? 'No call hierarchy of a C++ extension answered, so the callers in other files are not in this result.'
					: 'callersInOtherFiles comes from the call hierarchy of the C++ extension. It has the lines of the calls, but no data of the calls.',
			...parseNote(model),
		};
	}

	async threads(file?: string): Promise<Api.ThreadFacts> {
		const { client, doc, file: f } = await this.prepare(file);
		const model = await client.threads(f, { asyncFunctions: this.deps.asyncFunctions(doc.uri), roots: this.roots() });
		const side = buildSideThreads(model, f, (l) => (l >= 0 && l < doc.lineCount ? doc.lineAt(l).text : undefined));
		return {
			file: f,
			threads: side.threads.map((t) => ({
				label: t.label, via: t.via, line: t.line, function: t.fn, handle: t.handle, ...(t.isRepeated ? { repeated: true } : {}),
				joins: t.joins.map((j) => `${j.kind} on line ${j.line}`),
			})),
			items: side.items.slice(0, MAX_ITEMS).map((i) => ({
				item: i.label, kind: i.kind, type: i.type, verdict: i.pill, caller: i.caller, worker: i.worker, protection: i.protection, summary: i.summary,
				...(i.fix ? { fix: { line: i.fix.line, text: i.fix.text, before: i.fix.before, after: i.fix.after } } : {}),
			})),
			counts: side.counts,
			...(side.isTruncated ? { truncated: true } : {}),
			...parseNote(model),
		};
	}

	async hidden(file: string | undefined, fn: FunctionArg): Promise<Api.HiddenFacts> {
		const { client, doc, file: f } = await this.prepare(file);
		const at = await this.selector(client, doc, fn);
		// a header with a template: the items of its instantiations come from a source file that includes it
		const unit = await this.deps.headerUnit(doc);
		const minCopyBytes = this.deps.minCopyBytes(doc.uri);
		const model = await client.cost(f, minCopyBytes, undefined, unit).catch((error) => {
			if (!unit) {
				throw error;
			}
			return client.cost(f, minCopyBytes);
		});
		// the innermost function at the line
		let index = -1;
		model.functions.forEach((x, i) => {
			const isIn = x.range.begin.line <= at.line && at.line <= x.range.end.line;
			const best = index >= 0 ? model.functions[index] : undefined;
			if (isIn && (!best || x.range.end.line - x.range.begin.line < best.range.end.line - best.range.begin.line)) {
				index = i;
			}
		});
		if (index < 0) {
			throw new Error(`No function on line ${at.line}.`);
		}
		const items = model.items.filter((i) => i.fn === index);
		return {
			file: f,
			function: model.functions[index].qualifiedName,
			items: items.slice(0, MAX_ITEMS).map((i) => ({ line: i.line, kind: i.kind, text: i.text, detail: i.detail, ...(i.heuristic ? { estimated: true } : {}) })),
			...(items.length > MAX_ITEMS ? { more: items.length - MAX_ITEMS } : {}),
			...parseNote(model),
		};
	}

	async includes(file?: string): Promise<Api.IncludeFacts> {
		const { client, file: f } = await this.prepare(file);
		const model = await client.includes(f, this.roots());
		const side = buildSideIncludes(model, f);
		if (!side) {
			throw new Error(`No include hierarchy for ${path.basename(f)}.`);
		}
		// the translation units that include the file. The first request scans the compile databases
		const units = await client.includers(f, this.roots()).catch(() => undefined);
		return {
			file: f,
			stats: side.stats,
			groups: side.groups.map((g) => ({ group: g.name, lines: g.lines })),
			includes: side.nodes.filter((n) => n.parent === 0).map((n) => ({
				line: n.line, include: n.name, lines: n.total, state: n.state,
				...(n.isUsed === false ? { possiblyUnused: true } : {}),
				...(n.forward ? { forward: n.forward } : {}),
				...(n.first !== undefined ? { includedBefore: side.nodes[n.first]?.parentPath } : {}),
			})),
			largestHeaders: side.nodes.filter((n) => n.state === 'entered').sort((a, b) => b.own - a.own).slice(0, 10).map((n) => ({ file: n.name, lines: n.own })),
			...(units ? {
				includedBy: {
					translationUnits: units.units.slice(0, MAX_ITEMS), count: units.units.length, ofAll: units.unitCount,
					...(units.units.length > MAX_ITEMS ? { more: units.units.length - MAX_ITEMS } : {}),
				},
			} : {}),
			...parseNote(model),
		};
	}

	// The outline of a type by its name, or at a line with its name. A type that the translation unit only declares gets
	// the outline of the header with its definition, as the menu "Outline" does
	// The heat of the functions of a file, the hottest first. With a function, only that function. With lines, only the
	// functions with a line in them, as for the hottest function of a step
	async heat(file: string | undefined, fn: string | undefined, lines?: [number, number]): Promise<Api.HeatFacts> {
		const { doc, file: f } = await this.prepare(file);
		const model = await this.deps.heat(doc);
		let functions = [...model.functions].sort((a, b) => b.score - a.score || a.first - b.first);
		if (fn) {
			functions = functions.filter((h) => h.qualifiedName === fn || h.name === fn || h.qualifiedName.endsWith(`::${fn}`));
			if (functions.length === 0) {
				throw new Error(`No function ${fn} in ${path.basename(f)}. Call list_functions.`);
			}
		}
		if (lines) {
			functions = functions.filter((h) => h.first <= lines[1] && h.last >= lines[0]);
		}
		const scan = this.scanNote();
		return {
			file: f,
			isReachComplete: model.isReachComplete,
			functions: functions.slice(0, MAX_ITEMS).map((h) => ({
				name: h.qualifiedName || h.name, lines: [h.first, h.last], score: h.score, band: bandText(h.band), flames: h.flames,
				reach: h.reach, risk: h.risk, history: h.history, ...(h.isSiloed ? { siloed: true } : {}), isReachComplete: h.isReachComplete,
				...(h.reachUnknown ? { reachUnknown: { ...h.reachUnknown } } : {}),
				...(h.tests ? { tests: { ...h.tests, files: [...h.tests.files] } } : {}),
				reasons: h.reasons.map((r) => `${r.text} (+${r.points} ${r.group})`),
				signals: h.reasons.map((r) => ({ ...r })),
			})),
			...(functions.length > MAX_ITEMS ? { more: functions.length - MAX_ITEMS } : {}),
			...(lines && functions.length === 0
				? { note: `No function${fn ? ` ${fn}` : ''} has a line in the lines ${lines[0]} to ${lines[1]} of ${path.basename(f)}.` } : {}),
			...(scan ? { callGraph: scan } : {}),
			notices: model.notices,
		};
	}

	// The callers of a function in the call graph up to a depth, with the lines of their calls, and its frame paths. A
	// call graph that is not complete starts its scan, as for the heat
	async callers(file: string | undefined, fn: FunctionArg, depth: number | undefined): Promise<Api.CallersFacts> {
		const d = depth ?? 3;
		if (!Number.isInteger(d) || d < 1 || d > 6) {
			throw new Error('"depth" must be a whole number from 1 to 6.');
		}
		const { client, doc, file: f } = await this.prepare(file);
		const at = await this.selector(client, doc, fn);
		const res = await this.deps.callers(doc, at, d);
		const isReady = res.callGraph.state === 'ready';
		const note = !isReady ? this.scanNote() ?? 'The call graph is not complete. Call get_callers again later.'
			: !res.callers ? 'The call graph has no data for the function, for example a function that is newer than the scan. Call get_callers again after the next scan.'
				: undefined;
		return {
			file: f,
			function: res.function ?? '',
			isReachComplete: isReady && !!res.callers,
			callers: (res.callers ?? []).map((c) => ({
				function: c.name, file: c.file, lines: [c.first, c.last], depth: c.depth, calls: c.calls, callLines: [...c.lines],
				...(c.isSignal ? { signal: true } : {}), ...(c.isConnection ? { connection: true } : {}),
			})),
			...(res.isCapped ? { more: true } : {}),
			framePaths: (res.framePaths ?? []).map((p) => ({ reason: p.reason, calls: p.calls, path: [...p.path] })),
			...(res.unknownCallers ? { reachUnknown: { cause: res.unknownCallers.cause, text: unknownCallersText(res.unknownCallers) } } : {}),
			...(note ? { callGraph: note } : {}),
			...parseNote(res),
		};
	}

	// The state of the scan of the call graph for the model. The scan does not block the tools, so the state tells the
	// model when to call get_heat again. Undefined if the call graph is complete or if no scan started
	private scanNote(): string | undefined {
		const graph = this.deps.store.state.callGraph;
		const progress = graph && graph.total > 0 ? `runs: ${graph.done} of ${graph.total} source files` : 'starts';
		return graph?.state === 'scanning'
			? `The scan of the call graph ${progress}. Call get_heat again later for the callers and the frame paths.`
			: graph?.state === 'stopped' ? 'The user stopped the scan of the call graph. The reach has no callers and no frame paths.'
				: graph?.state === 'failed' ? `The scan of the call graph failed: ${graph.error ?? 'no reason'}` : undefined;
	}

	// The heat of the functions of the changed files of get_review and get_diff, one file after the other, in the time
	// HEAT_FILES_MS. The notes tell the state of the scan of the call graph, and the files with no heat: the files after
	// the time, and the files that the engine could not analyze
	private async heatOfFiles(files: readonly string[], rel: (file: string) => string):
		Promise<{ models: Map<string, HeatModel>; notes: { callGraph?: string; noHeat?: string } }> {
		const models = new Map<string, HeatModel>();
		const missing: string[] = [];
		const start = Date.now();
		for (const file of files) {
			if (Date.now() - start >= HEAT_FILES_MS) {
				missing.push(file);
				continue;
			}
			try {
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
				models.set(file, await this.deps.heat(doc));
			} catch {
				missing.push(file);
			}
		}
		const scan = this.scanNote();
		return {
			models,
			notes: {
				...(scan ? { callGraph: scan } : {}),
				...(missing.length > 0 ? {
					noHeat: `${missing.length === 1 ? '1 changed file has' : `${missing.length} changed files have`} no heat, because of the time limit or an error of the engine: ${missing.slice(0, 10).map(rel).join(', ')}. get_heat gives the heat of a file.`,
				} : {}),
			},
		};
	}

	async outline(file: string | undefined, name: string | undefined, line: number | undefined): Promise<Api.OutlineFacts> {
		if (!name && line === undefined) {
			throw new Error('Give the name of the type, or a line with its name.');
		}
		const { client, doc, file: f } = await this.prepare(file);
		type Result = Awaited<ReturnType<EngineClient['outline']>>;
		let result: Result | undefined;
		let place: { doc: vscode.TextDocument; pos: vscode.Position } | undefined;
		if (name) {
			result = await client.outline(f, { name });
			if (result.candidates?.length) {
				throw new Error(`${result.candidates.length} types match ${name}: ${result.candidates.slice(0, 10).join(', ')}. Give the name with its namespaces.`);
			}
		} else {
			if (line! > doc.lineCount) {
				throw new Error(`${path.basename(f)} has ${doc.lineCount} lines.`);
			}
			const text = doc.lineAt(line! - 1).text;
			for (const col of typeNameColumns(text)) {
				result = await client.outline(f, { line: line!, col: toUtf8Column(text, col) });
				if (result.outline || result.declaration) {
					place = { doc, pos: new vscode.Position(line! - 1, col) };
					break;
				}
			}
		}
		if (result && !result.outline && result.declaration) {
			const header = await this.deps.definitionHeader(result.declaration.name, place);
			if (header) {
				result = await client.outline(header, { name: result.declaration.name });
			}
		}
		if (!result?.outline) {
			throw new Error(result?.declaration ? `DataFlow found no definition of ${result.declaration.name}.`
				: name ? `No class, struct, union or enum ${name} in the translation unit of ${path.basename(f)}.`
					: `No class, struct, union or enum on line ${line} of ${path.basename(f)}.`);
		}
		return { ...outlineFacts(result.outline), ...parseNote(result) };
	}

	//-------------------
	// View tools

	async showBlocks(file: string | undefined, fn: FunctionArg, blocks: ModelBlockInput[]): Promise<Api.ShowBlocksResult> {
		const { doc, model } = await this.structureModel(file, fn);
		const title = functionTitle(model.function, true);
		const { blocks: placed, problems } = snapBlocks(model, blocks, title);
		if (problems.length > 0) {
			throw new Error(`The view did not change.\n${problems.join('\n')}`);
		}
		const f = doc.uri.fsPath;
		// the blocks of the other functions stay, so a model can show blocks for each function of a file. The old blocks in
		// the lines of this function go with their notes. The lines select them, because overloads have the same name. The
		// other notes and the comments stay. No await comes between the read of the layer and the write, so calls for two
		// functions at the same time keep both
		const old = this.layerOf(f);
		const [from, to] = functionLines(model);
		const isOther = (first: number, last: number) => last < from || first > to;
		const others = (old?.blocks ?? []).filter((b) => isOther(b.first, b.last));
		const all = [...others, ...placed].sort((a, b) => a.first - b.first || a.level - b.level);
		const notes = (old?.notes ?? []).filter((n) => n.block === undefined || isOther(n.first, n.last));
		this.setLayer({ file: f, fn: title, client: this.deps.client(), blocks: all, notes, comments: old?.comments ?? [], details: old?.details ?? [] });
		this.showLayers();
		await this.reveal(doc, new vscode.Position(Math.max(0, placed[0].first - 1), 0));
		this.deps.side.showDetails('model');
		return {
			file: f,
			function: model.function.qualifiedName,
			shown: placed.length,
			functionsWithBlocks: new Set(all.map((b) => b.fn)).size,
			blocks: placed.map((b) => ({
				id: b.id, ...(b.parent ? { parent: b.parent } : {}), lines: [b.first, b.last], title: b.title,
				...(b.from ? { movedFrom: b.from } : {}),
				...(b.ins.length ? { in: b.ins } : {}),
				...(b.outs.length ? { out: b.outs } : {}),
				...(b.extra.length ? { items: b.extra.map((e) => `${e.kind}: ${e.text} on ${e.line}`) } : {}),
			})),
			...parseNote(model),
		};
	}

	// Notes on ranges or on blocks. append keeps the old notes of the file. Each note gets an id after the ids of the old
	// notes, so a client can remove it
	async highlight(file: string | undefined, ranges: ModelNoteInput[], append = false): Promise<Api.HighlightResult> {
		this.checkActions(Array.isArray(ranges) && ranges.some((r) => !!r && typeof r === 'object' && r.actions !== undefined));
		const doc = await this.document(file);
		const f = doc.uri.fsPath;
		const old = this.layerOf(f);
		const resolved = resolveNotes(ranges, old?.blocks ?? [], [1, doc.lineCount]);
		if (resolved.problems.length > 0) {
			throw new Error(`The view did not change.\n${resolved.problems.join('\n')}`);
		}
		const notes = withIds(resolved.notes, 'n', append ? old?.notes ?? [] : []);
		const all = append ? [...(old?.notes ?? []), ...notes].sort((a, b) => a.first - b.first || a.last - b.last) : notes;
		this.setLayer({ file: f, fn: old?.fn, client: this.deps.client(), blocks: old?.blocks ?? [], notes: all, comments: old?.comments ?? [], details: old?.details ?? [] });
		this.showLayers();
		await this.reveal(doc, new vscode.Position(Math.max(0, notes[0].first - 1), 0));
		return {
			file: f,
			shown: notes.length,
			notesInFile: all.length,
			notes: notes.map((n) => ({ id: n.id!, lines: [n.first, n.last], kind: n.kind, ...(n.block ? { block: n.block, function: n.blockFn } : {}) })),
		};
	}

	// Comments on single lines. append keeps the old comments of the file: a new comment on a line replaces only the old
	// comment of that line. Each comment gets an id after the ids of the old comments
	async comment(file: string | undefined, input: ModelCommentInput[], append: boolean): Promise<Api.CommentLinesResult> {
		const doc = await this.document(file);
		const f = doc.uri.fsPath;
		const old = this.layerOf(f);
		const resolved = resolveComments(input, [1, doc.lineCount]);
		if (resolved.problems.length > 0) {
			throw new Error(`The view did not change.\n${resolved.problems.join('\n')}`);
		}
		const comments = withIds(resolved.comments, 'c', append ? old?.comments ?? [] : []);
		const all = append ? mergeComments(old?.comments ?? [], comments) : comments;
		this.setLayer({
			file: f, fn: old?.fn, client: this.deps.client(), blocks: old?.blocks ?? [], notes: old?.notes ?? [], comments: all, details: old?.details ?? [],
		});
		this.showLayers();
		await this.reveal(doc, new vscode.Position(Math.max(0, comments[0].line - 1), 0));
		return { file: f, shown: comments.length, commentsInFile: all.length, lines: comments.map((c) => c.line), ids: comments.map((c) => c.id!) };
	}

	// Removes the notes, the comments and the details of the client in a file by their ids
	async remove(file: string | undefined, ids: unknown): Promise<Api.RemoveResult> {
		if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.trim().length > 0)) {
			throw new Error('Give "ids": the ids of notes, comments and details, for example ["n1", "c2", "d1"].');
		}
		const doc = await this.document(file);
		const f = doc.uri.fsPath;
		const old = this.layerOf(f);
		const wanted = new Set(ids.map((id: string) => id.trim()));
		const has = (x: { id?: string }) => !!x.id && wanted.has(x.id);
		const removed = old ? [...old.notes, ...old.comments, ...old.details].filter(has).map((x) => x.id!) : [];
		if (old && removed.length > 0) {
			this.setLayer({ ...old, notes: old.notes.filter((n) => !has(n)), comments: old.comments.filter((c) => !has(c)), details: old.details.filter((d) => !has(d)) });
		}
		const layer = this.layerOf(f);
		return {
			file: f, removed, unknown: [...wanted].filter((id) => !removed.includes(id)),
			notesInFile: layer?.notes.length ?? 0, commentsInFile: layer?.comments.length ?? 0, detailsInFile: layer?.details.length ?? 0,
		};
	}

	// A detail on code: an expression on a line, a line, or the selection of the user. The side view shows a symbol at the
	// end of the line, and the symbol shows the text in a card. A detail on the same code replaces the old detail
	async detail(file: string | undefined, input: ModelDetailInput): Promise<Api.AddDetailResult> {
		this.checkActions(input.actions !== undefined);
		const doc = await this.document(file);
		const f = doc.uri.fsPath;
		const old = this.layerOf(f);
		const lineText = (l: number) => (l >= 1 && l <= doc.lineCount ? doc.lineAt(l - 1).text : undefined);
		const { detail, problem } = resolveDetail(input, lineText, doc.lineCount, input.line === undefined ? this.selectionOf(doc) : undefined);
		if (!detail) {
			throw new Error(`The view did not change.\n${problem}`);
		}
		const { details, id } = addDetail(old?.details ?? [], detail);
		if (details.length > MAX_DETAILS) {
			throw new Error(`The view did not change.\nThe file has ${MAX_DETAILS} details. Call clear, or give a detail on the code of an old detail.`);
		}
		this.setLayer({ file: f, fn: old?.fn, client: this.deps.client(), blocks: old?.blocks ?? [], notes: old?.notes ?? [], comments: old?.comments ?? [], details });
		this.showLayers();
		await this.reveal(doc, new vscode.Position(detail.line - 1, detail.col));
		return {
			file: f, id, lines: [detail.line, detail.endLine], code: detail.code.slice(0, 300), title: detail.title, detailsInFile: details.length,
			note: 'The line of the code gets a symbol at its end. The user sees the text when the mouse is on the symbol.',
		};
	}

	// Removes the layers of the client: in all files, or in one file. The layers of the other clients stay
	async clear(file?: string): Promise<Api.ClearResult> {
		const { store } = this.deps;
		const owner = this.owner();
		if (!file) {
			const rest = store.state.modelLayers.filter((l) => ownerOf(l) !== owner);
			const removed = store.state.modelLayers.length - rest.length;
			if (removed > 0) {
				store.update({ modelLayers: rest });
			}
			return { removed };
		}
		const doc = await this.document(file);
		const key = fileKey(doc.uri.fsPath);
		const rest = store.state.modelLayers.filter((l) => fileKey(l.file) !== key || ownerOf(l) !== owner);
		const removed = store.state.modelLayers.length - rest.length;
		if (removed > 0) {
			store.update({ modelLayers: rest });
		}
		return { removed };
	}

	//-------------------
	// Guided review

	// The files that the user wants to review: the C and C++ files under the paths, with the diff of each changed file
	async review(paths: unknown): Promise<Api.ReviewFacts> {
		if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p.trim().length > 0)) {
			throw new Error('Give "paths": the files and the folders that the user wants to review.');
		}
		const files = await this.deps.reviewFiles(paths.map((p: string) => p.trim()));
		if ('message' in files) {
			throw new Error(files.message);
		}
		this.lastReview = { root: files.root, target: files.target };
		if (files.files.length === 0) {
			throw new Error(`The paths have no C or C++ file.${files.missing.length > 0 ? ` These paths do not exist: ${files.missing.join(', ')}.` : ''}`);
		}
		// the heat of the changed functions, so the plan can start with the hottest changes
		const changed = files.files.slice(0, MAX_REVIEW_FILES).filter((f) => f.hunks.length > 0).map((f) => f.file);
		if (changed.length === 0) {
			return reviewFacts(files);
		}
		const { models, notes } = await this.heatOfFiles(changed, (f) => path.relative(files.root, f).replace(/\\/g, '/'));
		return { ...reviewFacts(files, models), ...notes };
	}

	// Shows the plan of a guided review in the side view, at its first step
	async showReviewPlan(plan: GuidePlanInput): Promise<Api.ReviewPlanResult> {
		this.checkActions(hasStepActions(plan.steps));
		const { store, side } = this.deps;
		// the files of the steps: a path relative to the repository or to a folder of the project, or an absolute path
		const files = new Map<string, { file: string; lineCount: number; problem?: string }>();
		const steps = Array.isArray(plan.steps) ? plan.steps : [];
		const given = new Set(steps.map((s) => (s && typeof s === 'object' ? (s as { file?: unknown }).file : undefined)).filter((f): f is string => typeof f === 'string'));
		const current = this.deps.currentEditor()?.document.uri.fsPath ?? side.file;
		for (const name of [...given, ...(current ? [current] : [])]) {
			const full = this.projectFile(name);
			if (!full) {
				continue;
			}
			if (!isCppFile(full)) {
				files.set(name, { file: full, lineCount: 0, problem: `${path.basename(full)} is not a C or C++ file. The side view shows only C and C++ files.` });
				continue;
			}
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
			const found = { file: doc.uri.fsPath, lineCount: doc.lineCount };
			files.set(name, found);
			files.set(found.file, found);
		}
		const { guide, problems } = resolveGuidePlan(plan, (f) => files.get(f), {
			defaultFile: current, seq: (store.state.guide?.seq ?? 0) + 1, client: this.deps.client(), target: this.lastReview?.target,
		});
		if (!guide) {
			throw new Error(`The view did not change.\n${problems.join('\n')}`);
		}
		store.update({ guide });
		await side.goToGuideStep(0);
		side.showDetails('guide');
		const root = this.lastReview?.root;
		const rel = (f: string) => (root && isInside(f, root) ? path.relative(root, f).replace(/\\/g, '/') : f);
		return {
			title: guide.title,
			steps: guide.steps.map((s, i) => ({ step: i + 1, title: s.title, file: rel(s.file), lines: [s.first, s.last] })),
			shown: 1,
			note: 'The side view shows step 1. The user goes to the next step with the button Next, or asks you. get_view gives the step that the user looks at.',
		};
	}

	//-------------------
	// Diff walk

	// The changes of a diff walk: the hunks of the changed C and C++ files against the base, with an id for each hunk
	async diff(base: string | undefined, paths: unknown): Promise<Api.DiffFacts> {
		if (paths !== undefined && (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.trim().length > 0))) {
			throw new Error('"paths" must be a list of files and folders.');
		}
		const input = await this.deps.walkInput(base, (paths as string[] | undefined)?.map((p) => p.trim()));
		if ('message' in input) {
			throw new Error(input.message);
		}
		const hunks = walkHunks(input.files);
		this.lastWalk = { input, hunks };
		if (hunks.length === 0) {
			return { ...walkFacts(input, hunks), note: `No C or C++ file changed against ${input.base}, so a diff walk has no steps.` };
		}
		// the heat of the changed functions, so the plan can start with the hottest changes
		const files = [...new Set(hunks.map((h) => h.file))];
		const { models, notes } = await this.heatOfFiles(files, (f) => path.relative(input.root, f).replace(/\\/g, '/'));
		return { ...walkFacts(input, hunks, models), ...notes };
	}

	// Shows the plan of a diff walk in the side view, at its first step
	async showDiffWalk(plan: WalkPlanInput): Promise<Api.DiffWalkResult> {
		this.checkActions(hasStepActions(plan.steps));
		const { store, side } = this.deps;
		const walk = this.lastWalk;
		if (!walk) {
			throw new Error('Call get_diff first. The steps of a diff walk name the hunks of get_diff.');
		}
		if (walk.hunks.length === 0) {
			throw new Error(`The last get_diff has no hunks: no C or C++ file changed against ${walk.input.base}.`);
		}
		const { guide, problems, added, notShown } = resolveWalkPlan(plan, walk.hunks, {
			input: walk.input, seq: (store.state.guide?.seq ?? 0) + 1, client: this.deps.client(),
		});
		if (!guide) {
			throw new Error(`The view did not change.\n${problems.join('\n')}`);
		}
		store.update({ guide });
		await side.goToGuideStep(0);
		side.showDetails('guide');
		const root = walk.input.root;
		const rel = (f: string) => (isInside(f, root) ? path.relative(root, f).replace(/\\/g, '/') : f);
		const planned = guide.steps.length - added.length;
		return {
			title: guide.title,
			steps: guide.steps.map((s, i) => ({ step: i + 1, title: s.title, file: rel(s.file), lines: [s.first, s.last], ...(i >= planned ? { addedByDataFlow: true } : {}) })),
			...(added.length > 0 ? {
				addedSteps: added.map((g) => ({ title: groupTitle(g), hunks: g.map((h) => h.id) })),
				addedNote: 'Your plan has no step for these hunks, so DataFlow added a step for each of them after your steps. To change this, call show_diff_walk again with all hunks.',
			} : {}),
			...(notShown.length > 0 ? { notShown } : {}),
			shown: 1,
			note: 'The side view shows step 1 with its diff. The user goes to the next step with the button Next, or asks you. get_view gives the step that the user looks at.',
		};
	}

	// Goes to a step of the guided review or of the diff walk, and adds a note or a mark to it
	async reviewStep(step: number, note: unknown, status: string | undefined): Promise<Api.ReviewStepResult> {
		const { store, side } = this.deps;
		const guide = store.state.guide;
		if (!guide) {
			throw new Error('No guided review or diff walk shows. Call show_review_plan or show_diff_walk first.');
		}
		const index = step - 1;
		if (stepIndex(guide, index) === undefined) {
			throw new Error(`The ${guide.kind === 'diff' ? 'diff walk' : 'review'} has ${guide.steps.length} steps. Give a step from 1 to ${guide.steps.length}.`);
		}
		if (status !== undefined && !GUIDE_STATUSES.includes(status as SideGuideStatus)) {
			throw new Error(`"status" must be one of ${GUIDE_STATUSES.join(', ')}.`);
		}
		if (note !== undefined && typeof note !== 'string') {
			throw new Error('"note" must be a text.');
		}
		let next = guide;
		if (typeof note === 'string') {
			next = withNote(next, index, note);
		}
		if (status) {
			next = withStatus(next, index, status as SideGuideStatus);
		}
		if (next !== guide) {
			store.update({ guide: next });
		}
		await side.goToGuideStep(index);
		side.showDetails('guide');
		const s = next.steps[index];
		return { step, title: s.title, file: s.file, lines: [s.first, s.last], status: s.status, progress: guideProgress(next) };
	}

	// Closes the guided review or the diff walk, as the button Close review or Close walk of the user does. The state of
	// the workspace then also has no guide. With a kind, only a guide of this kind closes
	async closeGuide(kind: string | undefined): Promise<Api.CloseGuideResult> {
		if (kind !== undefined && !(GUIDE_TYPES as readonly string[]).includes(kind)) {
			throw new Error(`"kind" must be one of ${GUIDE_TYPES.map((t) => `"${t}"`).join(', ')}.`);
		}
		const { store } = this.deps;
		const guide = store.state.guide;
		if (!guide) {
			return { closed: false, note: 'No guided review or diff walk shows, so the view did not change.' };
		}
		const shown = guideType(guide);
		if (kind !== undefined && kind !== shown) {
			const name = (k: string) => (k === 'review' ? 'guided review' : 'diff walk');
			throw new Error(`The side view shows a ${name(shown)}, not a ${name(kind)}. The view did not change.`);
		}
		store.update({ guide: undefined });
		return { closed: true, kind: shown, title: guide.title, steps: guide.steps.length, progress: guideProgress(guide) };
	}

	//-------------------
	// Lenses

	// The logic of a function: its decisions, and one path through the function for the choices
	async logic(file: string | undefined, fn: FunctionArg, choices: unknown): Promise<Api.LogicFacts> {
		const { doc, model, controls } = await this.logicModel(file, fn);
		const chosen = checkChoices(controls, choices);
		return { file: doc.uri.fsPath, ...logicFacts(model, controls, chosen), ...parseNote(model) };
	}

	// Shows the path of Logic Map for the choices in the side view. The cursor goes to the function, so the other lenses
	// show the same function
	async showLogicPath(file: string | undefined, fn: FunctionArg, choices: unknown): Promise<Api.LogicFacts> {
		const { doc, at, model, controls } = await this.logicModel(file, fn);
		const chosen = checkChoices(controls, choices);
		this.deps.showLogicPath(doc, model, chosen, at.line);
		await this.deps.side.goTo(doc.uri.fsPath, at.line, toUtf16Column(doc.lineAt(at.line - 1).text, at.col));
		this.deps.side.showDetails('logic');
		return { file: doc.uri.fsPath, ...logicFacts(model, controls, chosen), shown: true, ...parseNote(model) };
	}

	// Turns a lens of the side view on or off. A lens that turns on opens the side view
	async setLens(lens: string, isOn: boolean): Promise<Api.SetLensResult> {
		if (!(LENSES as readonly string[]).includes(lens)) {
			throw new Error(`"lens" must be one of ${LENSES.join(', ')}.`);
		}
		const { store } = this.deps;
		const wasOn = store.state.lenses[lens as Lens];
		this.deps.setLens(lens as Lens, isOn);
		return {
			lens, on: isOn, changed: wasOn !== isOn,
			lenses: Object.entries(store.state.lenses).filter(([, on]) => on).map(([l]) => l),
		};
	}

	// Moves the cursor to a line, and shows it in the side view. The lenses follow the cursor
	async showLine(file: string | undefined, line: number): Promise<Api.ShowLineResult> {
		const doc = await this.document(file);
		if (!isCpp(doc) && !INCLUDE_FILE.test(doc.uri.fsPath)) {
			throw new Error(`${doc.uri.fsPath} is not a C or C++ file. The side view shows only C and C++ files.`);
		}
		if (line > doc.lineCount) {
			throw new Error(`${path.basename(doc.uri.fsPath)} has ${doc.lineCount} lines.`);
		}
		const text = doc.lineAt(line - 1).text;
		await this.deps.side.goTo(doc.uri.fsPath, line, Math.max(0, text.search(/\S/)));
		return { file: doc.uri.fsPath, line, text: text.trim().slice(0, 300), shown: true };
	}

	// Removes the trace of Flow Lens. Flow Lens traces again at the next move of the cursor
	async clearFlow(): Promise<Api.ClearedResult> {
		return { cleared: this.deps.clearFlow() };
	}

	// The last review of Change Ripple: the changed functions, the statements that each change reaches, and the callers
	// that get a changed return value
	async ripple(): Promise<Api.RippleFacts> {
		const { state, model, root } = this.deps.ripple();
		if (state?.isRunning) {
			return { state: 'running', note: 'The review of Change Ripple runs. Call get_ripple again later.' };
		}
		if (!model || !state) {
			return state?.message
				? { state: 'failed', message: state.message }
				: { state: 'none', note: 'No review of Change Ripple shows. Call start_ripple, or ask the user to run "DataFlow: Review Changes".' };
		}
		const rel = (f: string) => (root && isInside(f, root) ? path.relative(root, f).replace(/\\/g, '/') : f);
		return { state: 'ready', ...rippleFacts(model, state, rel), ...(state.message ? { message: state.message } : {}) };
	}

	// Runs a review of Change Ripple against the target branch, and gives its facts
	async startRipple(): Promise<Api.RippleFacts> {
		this.ready();
		await this.deps.startRipple();
		return this.ripple();
	}

	// Closes Change Ripple
	async clearRipple(): Promise<Api.ClearedResult> {
		return { cleared: this.deps.clearRipple() };
	}

	// Starts the scan of the call graph of the project for the heat. The scan does not block
	async scanCallGraph(): Promise<Api.CallGraphFacts> {
		this.ready();
		this.deps.scanCallGraph();
		return callGraphFacts(this.deps.store.state.callGraph);
	}

	// The state of the scan of the call graph. It does not start or stop a scan
	async callGraph(): Promise<Api.CallGraphFacts> {
		return callGraphFacts(this.deps.store.state.callGraph);
	}

	async stopCallGraph(): Promise<Api.StopCallGraphResult> {
		const isStopped = this.deps.stopCallGraph();
		return { stopped: isStopped, ...callGraphFacts(this.deps.store.state.callGraph) };
	}

	private async logicModel(file: string | undefined, fn: FunctionArg):
		Promise<{ doc: vscode.TextDocument; at: { line: number; col: number }; model: LogicModel & FileResult; controls: Control[] }> {
		const { client, doc, file: f } = await this.prepare(file);
		const at = await this.selector(client, doc, fn);
		const model = await client.logic(f, at, this.deps.logicOptions(doc));
		return { doc, at, model, controls: buildControls(model) };
	}

	// The full path of a file of a step: an absolute path, or a path relative to the root of the last get_review or to a
	// folder of the project
	private projectFile(name: string): string | undefined {
		if (path.isAbsolute(name)) {
			return existsSync(name) ? name : undefined;
		}
		const root = this.lastReview?.root;
		for (const folder of [...(root ? [root] : []), ...this.roots()]) {
			const full = path.join(folder, name);
			if (existsSync(full)) {
				return full;
			}
		}
		return undefined;
	}

	// Moves the lines of the blocks and the notes of the layers of all clients in a file with the changes of an edit.
	// Returns false if a layer went away, because a change replaced all its lines
	moveLayer(file: string, changes: readonly TextChange[]): boolean {
		const { store } = this.deps;
		const key = fileKey(file);
		let isAllKept = true;
		let isChanged = false;
		const layers = store.state.modelLayers.flatMap((l) => {
			if (fileKey(l.file) !== key) {
				return [l];
			}
			const moved = moveModelLayer(l, changes);
			isChanged = isChanged || moved !== l;
			isAllKept = isAllKept && !!moved;
			return moved ? [moved] : [];
		});
		if (isChanged) {
			store.update({ modelLayers: layers });
		}
		return isAllKept;
	}

	// Removes the layers of all clients in a file
	removeLayer(file: string): void {
		const { store } = this.deps;
		const rest = store.state.modelLayers.filter((l) => fileKey(l.file) !== fileKey(file));
		if (rest.length !== store.state.modelLayers.length) {
			store.update({ modelLayers: rest });
		}
	}

	//-------------------
	// Helpers

	// The folders of the project and of its compile databases
	private roots(): string[] {
		const folders = [...this.deps.roots(), ...this.deps.store.state.databases.map((d) => d.folder)];
		return [...new Map(folders.map((f) => [fileKey(f), f])).values()];
	}

	// The selection of the user in a document: in the C++ editor of the document, else in the side view with no text editor
	private selectionOf(doc: vscode.TextDocument): CodePlace | undefined {
		const editor = this.deps.currentEditor();
		const key = fileKey(doc.uri.fsPath);
		const range = editor && fileKey(editor.document.uri.fsPath) === key ? editor.selection
			: (this.deps.side.selectionPlace && fileKey(this.deps.side.selectionPlace.doc.uri.fsPath) === key ? this.deps.side.selectionPlace.range : undefined);
		if (!range || range.isEmpty) {
			return undefined;
		}
		return { line: range.start.line + 1, col: range.start.character, endLine: range.end.line + 1, endCol: range.end.character };
	}

	// The owner of the layers of the host: its client, else the model
	private owner(): string {
		return ownerOf({ client: this.deps.client() });
	}

	// The layer of the client of the host in a file
	private layerOf(file: string): SideModel | undefined {
		const owner = this.owner();
		return this.deps.store.state.modelLayers.find((l) => fileKey(l.file) === fileKey(file) && ownerOf(l) === owner);
	}

	// The layers of the other clients in a file
	private otherLayers(file: string): SideModel[] {
		const owner = this.owner();
		return this.deps.store.state.modelLayers.filter((l) => fileKey(l.file) === fileKey(file) && ownerOf(l) !== owner);
	}

	// Buttons need the API for extensions: an MCP client gets no event for a click
	private checkActions(hasActions: boolean): void {
		if (hasActions && !this.deps.isExtension) {
			throw new Error('"actions" need the API for extensions. An MCP client gets no event for a click. The view did not change.');
		}
	}

	// A view tool shows the layers of the model again, if the user hid them with the switch Model, because the user asked
	// the model for them
	private showLayers(): void {
		if (!this.deps.store.state.isModelShown) {
			this.deps.store.update({ isModelShown: true });
		}
	}

	// Replaces the layer of the client of the host in the file of the layer. An empty layer goes away. The layers of the
	// other clients stay
	private setLayer(layer: SideModel): void {
		const { store } = this.deps;
		const owner = this.owner();
		const layers = store.state.modelLayers;
		const at = layers.findIndex((l) => fileKey(l.file) === fileKey(layer.file) && ownerOf(l) === owner);
		const isEmpty = layer.blocks.length === 0 && layer.notes.length === 0 && layer.comments.length === 0 && layer.details.length === 0;
		const next = { ...layer, client: this.deps.client() };
		// the layer keeps its place, so the clients of a file keep their sequence in the side view
		const out = isEmpty ? layers.filter((_, i) => i !== at) : at < 0 ? [...layers, next] : layers.map((l, i) => (i === at ? next : l));
		if (out.length !== layers.length || !isEmpty) {
			store.update({ modelLayers: out });
		}
	}

	private ready(): EngineClient {
		const client = this.deps.engine();
		if (!client || client.currentState !== 'ready') {
			throw new Error('The DataFlow engine is not ready. Open a C++ file of the project in VS Code and wait until the side view shows its code. '
				+ 'If DataFlow found no compile database, the user must run "DataFlow: Select Compile Database".');
		}
		return client;
	}

	// The document of a file, of the active C++ editor, or of the file of the side view. The file must be in the project.
	private async document(file?: string): Promise<vscode.TextDocument> {
		if (!file) {
			const editor = this.deps.currentEditor();
			if (editor && isCpp(editor.document)) {
				return editor.document;
			}
			const shown = this.deps.side.file;
			if (!shown) {
				throw new Error('No C++ file is active in VS Code, and the side view shows no file. Give "file".');
			}
			const open = vscode.workspace.textDocuments.find((d) => fileKey(d.uri.fsPath) === fileKey(shown));
			return open ?? vscode.workspace.openTextDocument(vscode.Uri.file(shown));
		}
		const roots = this.roots();
		const candidates = path.isAbsolute(file) ? [file] : roots.map((r) => path.join(r, file));
		const found = candidates.find((c) => existsSync(c));
		if (!found) {
			throw new Error(`DataFlow found no file ${file}${roots.length > 0 ? ` in ${roots.join(', ')}` : ''}.`);
		}
		if (!roots.some((r) => isInside(found, r))) {
			throw new Error(`${found} is not in the project. DataFlow analyzes only the files of the project that is open in VS Code.`);
		}
		const open = vscode.workspace.textDocuments.find((d) => fileKey(d.uri.fsPath) === fileKey(found));
		return open ?? vscode.workspace.openTextDocument(vscode.Uri.file(found));
	}

	private async prepare(file?: string): Promise<{ client: EngineClient; doc: vscode.TextDocument; file: string }> {
		const client = this.ready();
		const doc = await this.document(file);
		// VS Code opens an .inc file as plain text. DataFlow sets its language to C++ only after it opens
		if (!isCpp(doc) && !INCLUDE_FILE.test(doc.uri.fsPath)) {
			throw new Error(`${doc.uri.fsPath} is not a C or C++ file.`);
		}
		this.deps.flushChange(doc);
		return { client, doc, file: doc.uri.fsPath };
	}

	// A position in the function for the engine
	private async selector(client: EngineClient, doc: vscode.TextDocument, fn: FunctionArg): Promise<{ line: number; col: number }> {
		const file = doc.uri.fsPath;
		if (fn.function) {
			const name = fn.function;
			const { functions } = await client.functions(file);
			let matches = functions.filter((f) => f.qualifiedName === name);
			if (matches.length === 0) {
				matches = functions.filter((f) => f.name === name || f.macroCall === name || f.qualifiedName.endsWith(`::${name}`));
			}
			if (fn.line !== undefined && matches.length > 1) {
				const atLine = matches.filter((f) => f.range.begin.line <= fn.line! && fn.line! <= f.range.end.line);
				matches = atLine.length > 0 ? atLine : matches;
			}
			if (matches.length === 0) {
				throw new Error(`No function ${name} in ${path.basename(file)}. Call list_functions.`);
			}
			if (matches.length > 1) {
				throw new Error(`${matches.length} functions match ${name}: ${matches.map((m) => `${m.qualifiedName} on line ${m.range.begin.line}`).join(', ')}. Give "line" too.`);
			}
			return positionOf(matches[0]);
		}
		if (fn.line !== undefined) {
			if (fn.line > doc.lineCount) {
				throw new Error(`${path.basename(file)} has ${doc.lineCount} lines.`);
			}
			const text = doc.lineAt(fn.line - 1).text;
			return { line: fn.line, col: toUtf8Column(text, Math.max(0, text.search(/\S/))) };
		}
		const place = this.deps.currentPlace();
		if (place && fileKey(place.doc.uri.fsPath) === fileKey(file)) {
			const pos = doc.validatePosition(place.pos);
			return { line: pos.line + 1, col: toUtf8Column(doc.lineAt(pos.line).text, pos.character) };
		}
		throw new Error('Give "function" or "line".');
	}

	private async structureModel(file: string | undefined, fn: FunctionArg): Promise<{ doc: vscode.TextDocument; model: StructureModel & FileResult }> {
		const { client, doc, file: f } = await this.prepare(file);
		const at = await this.selector(client, doc, fn);
		const model = await client.structure(f, at, { eventFunctions: this.deps.eventFunctions(doc.uri), asyncFunctions: this.deps.asyncFunctions(doc.uri) });
		return { doc, model };
	}

	// Shows a place for the user, and opens the side view. The focus stays, for example in the terminal of the MCP client.
	// With a C++ text editor on the screen, the text editor beside the side view shows the place. With no C++ text editor,
	// for example with Claude Code in the other editor group, only the side view shows the place, and its cursor goes to
	// the place.
	private async reveal(doc: vscode.TextDocument, pos: vscode.Position, type = vscode.TextEditorRevealType.AtTop): Promise<void> {
		const { side } = this.deps;
		if (!side.hasCodeEditor) {
			side.showPlace(doc, pos);
			return;
		}
		const editor = await vscode.window.showTextDocument(doc, { viewColumn: side.editorColumn(), preserveFocus: true, preview: false });
		editor.revealRange(new vscode.Range(pos, pos), type);
		side.open();
	}
}
