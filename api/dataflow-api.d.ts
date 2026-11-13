// The API of the DataFlow extension for other VS Code extensions. Copy this file into your extension. Then get the API
// from the exports of DataFlow:
//
//   const dataflow = vscode.extensions.getExtension<DataFlowExports>('KnurrliDev.dataflow');
//   const api = (await dataflow?.activate())?.getApi(1, { client: 'my-extension' });
//   const view = await api?.getView();
//
// The methods are the tools of the MCP server of DataFlow, with the same arguments and the same results. docs/tools.md
// describes each tool. Lines start at 1. A method that fails rejects its promise with an Error, for example if the
// engine is not ready or if a file is not in the project.

import type * as vscode from 'vscode';

export interface DataFlowExports {
	// The API of a version. DataFlow has version 1. A different version throws an Error
	getApi(version: 1, options?: DataFlowApiOptions): DataFlowApi;
}

export interface DataFlowApiOptions {
	// The name of your extension. The side view shows it on the blocks, the notes, the comments, the details and the
	// guides of your extension. Default: "extension"
	client?: string;
}

export type EngineState = 'stopped' | 'starting' | 'ready' | 'failed';

// The lenses of the side view: flow (Flow Lens), logic (Logic Map), cost (Hidden C++), includes (Include Hierarchy),
// calls (Call Hierarchy), threads (Threads and races), heat (Heat) and review (Change Ripple)
export type LensName = 'flow' | 'logic' | 'cost' | 'review' | 'includes' | 'calls' | 'threads' | 'heat';

export interface DataFlowApi {
	readonly version: 1;
	// The read methods need the state ready
	readonly engineState: EngineState;
	// The reason of the state failed, or of the state stopped with no compile database. Else undefined
	readonly engineError: string | undefined;
	// The compile databases of the engine: the files, or the qmake project of a database that DataFlow makes
	readonly compileDatabases: readonly string[];
	// The tools of the MCP server with their JSON schemas. callTool runs a tool by its name
	readonly tools: readonly DataFlowTool[];

	// The engine starts, is ready, stops or fails, or the compile databases change
	readonly onDidChangeEngineState: vscode.Event<EngineStateEvent>;
	// The file, the function or the line at the cursor changes. The cursor is the cursor of the active C++ editor, or
	// of the side view if no C++ editor shows. The event comes after the engine found the function at the cursor
	readonly onDidChangeView: vscode.Event<ViewEvent>;
	// A guided review or a diff walk starts, goes to a step, gets a mark or a note, or closes (null)
	readonly onDidChangeGuide: vscode.Event<GuideFacts | null>;
	// The scan of the call graph starts, makes progress, stops or ends. At its end, the heat of the functions can change
	readonly onDidChangeCallGraph: vscode.Event<CallGraphFacts>;

	// Runs a tool of the MCP server, and gives its result. The typed methods below run the same tools
	callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;

	// Read tools. They do not change the view
	getView(): Promise<ViewFacts>; // get_view
	listFunctions(args?: FileArgs): Promise<FunctionListFacts>; // list_functions
	getStructure(args?: FunctionArgs): Promise<StructureFacts>; // get_structure
	getFlow(args: FlowArgs): Promise<FlowFacts>; // get_flow
	getCalls(args?: FunctionArgs): Promise<CallFacts>; // get_calls
	getThreads(args?: FileArgs): Promise<ThreadFacts>; // get_threads
	getHidden(args?: FunctionArgs): Promise<HiddenFacts>; // get_hidden
	getIncludes(args?: FileArgs): Promise<IncludeFacts>; // get_includes
	getOutline(args: OutlineArgs): Promise<OutlineFacts>; // get_outline
	getHeat(args?: HeatArgs): Promise<HeatFacts>; // get_heat
	getCallGraph(): Promise<CallGraphFacts>; // get_call_graph
	getLogic(args?: LogicArgs): Promise<LogicFacts>; // get_logic
	getRipple(): Promise<RippleFacts>; // get_ripple
	getReview(args: ReviewArgs): Promise<ReviewFacts>; // get_review
	getDiff(args?: DiffArgs): Promise<DiffFacts>; // get_diff

	// View tools. They change the side view
	showBlocks(args: ShowBlocksArgs): Promise<ShowBlocksResult>; // show_blocks
	showFlow(args: FlowArgs): Promise<FlowFacts>; // show_flow
	showLogicPath(args?: LogicArgs): Promise<LogicFacts>; // show_logic_path
	showLine(args: ShowLineArgs): Promise<ShowLineResult>; // show_line
	highlight(args: HighlightArgs): Promise<HighlightResult>; // highlight
	commentLines(args: CommentLinesArgs): Promise<CommentLinesResult>; // comment_lines
	addDetail(args: AddDetailArgs): Promise<AddDetailResult>; // add_detail
	clear(args?: FileArgs): Promise<ClearResult>; // clear
	setLens(args: SetLensArgs): Promise<SetLensResult>; // set_lens
	clearFlow(): Promise<ClearedResult>; // clear_flow
	startRipple(): Promise<RippleFacts>; // start_ripple
	clearRipple(): Promise<ClearedResult>; // clear_ripple
	scanCallGraph(): Promise<CallGraphFacts>; // scan_call_graph
	stopCallGraph(): Promise<StopCallGraphResult>; // stop_call_graph
	showReviewPlan(args: ReviewPlanArgs): Promise<ReviewPlanResult>; // show_review_plan
	showDiffWalk(args: DiffWalkArgs): Promise<DiffWalkResult>; // show_diff_walk
	reviewStep(args: ReviewStepArgs): Promise<ReviewStepResult>; // review_step
	closeGuide(args?: CloseGuideArgs): Promise<CloseGuideResult>; // close_guide
}

export interface DataFlowTool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>; // the JSON schema of the arguments
	isReadOnly: boolean; // the tool does not change the view
	isDestructive: boolean; // the tool removes data of the user, for example the marks of the steps of a guide
}

//-------------------
// Events

export interface EngineStateEvent {
	state: EngineState;
	compileDatabases: string[];
	error?: string; // the reason of the state failed, or of the state stopped with no compile database
}

export interface ViewEvent {
	file: string | null;
	function: { name: string; lines: [number, number] } | null;
	line: number | null; // the line of the cursor
}

//-------------------
// Arguments

// A file: an absolute path, or a path relative to a folder of the project. Default: the file of the active C++ editor,
// else the file of the side view
export interface FileArgs {
	file?: string;
}

// A function: its qualified name, its name or the text of its macro call, or a line in it. Default: the function at
// the cursor. Give the line too for an overloaded name
export interface FunctionArgs extends FileArgs {
	function?: string;
	line?: number;
}

// A variable or a data member: a line with a reference, and its name, for example "charge.is_dirty" or "is_dirty"
export interface FlowArgs extends FileArgs {
	line: number;
	name: string;
}

// A type: its name with or without its namespaces, or a line with its name
export interface OutlineArgs extends FileArgs {
	name?: string;
	line?: number;
}

// One function by its qualified name or its name, and the functions with a line in lines. Default: all functions of
// the file
export interface HeatArgs extends FileArgs {
	function?: string;
	lines?: [number, number];
}

// The choices of the path: the key of a decision from getLogic, and one of its options, for example
// { 'if:count > 0#0': 'no' }. "any" removes a choice. A decision with no choice takes the option that runs the most lines
export interface LogicArgs extends FunctionArgs {
	choices?: Record<string, string>;
}

// The files and the folders to review, relative to the project or to the repository, or absolute
export interface ReviewArgs {
	paths: string[];
}

// base: "uncommitted" (default), "target", or a commit, a tag or a branch. paths: only the changes under these paths
export interface DiffArgs {
	base?: string;
	paths?: string[];
}

export interface BlockInput {
	lines: [number, number];
	title: string; // maximum 80 characters
	summary?: string;
	children?: BlockInput[]; // 5 levels at most
}

export interface ShowBlocksArgs extends FunctionArgs {
	blocks: BlockInput[]; // in the sequence of the lines, with no overlap
}

export type NoteKind = 'problem' | 'warning' | 'info';

export interface NoteInput {
	lines?: [number, number];
	block?: string; // the id of a block, instead of lines
	function?: string; // the function of the block, if more functions have a block with the id
	kind: NoteKind;
	note: string; // maximum 300 characters
}

export interface HighlightArgs extends FileArgs {
	ranges: NoteInput[];
	append?: boolean; // keep the old notes of the file
}

export type CommentColor = 'blue' | 'green' | 'purple' | 'yellow' | 'orange' | 'red' | 'gray';

export interface CommentLinesArgs extends FileArgs {
	comments: { line: number; text: string; color?: CommentColor }[]; // text: maximum 200 characters
	append?: boolean; // keep the old comments of the file
}

// The code: line and expression, or no line for the selection of the user
export interface AddDetailArgs extends FileArgs {
	line?: number;
	expression?: string;
	title?: string; // maximum 80 characters
	text: string; // a small part of Markdown. Maximum 4000 characters
}

export interface SetLensArgs {
	lens: LensName;
	on: boolean;
}

export interface ShowLineArgs extends FileArgs {
	line: number;
}

export type GuideKind = 'change' | 'ripple' | 'context' | 'risk' | 'test';
export type GuideStatus = 'todo' | 'ok' | 'issue' | 'question';

export interface ReviewPlanArgs {
	title?: string;
	summary?: string;
	steps: { title: string; file?: string; lines: [number, number]; text: string; checks?: string[]; kind?: GuideKind }[];
}

export interface DiffWalkArgs {
	title?: string;
	summary?: string;
	steps: { title: string; hunks: string[]; text: string; checks?: string[]; kind?: GuideKind }[]; // hunks: the ids of getDiff
	// true (default): a step at the end for each hunk that no step names. false: only the hunks of the steps
	allHunks?: boolean;
}

export interface ReviewStepArgs {
	step: number;
	note?: string; // an empty text removes the note
	status?: GuideStatus;
}

export interface CloseGuideArgs {
	kind?: 'review' | 'diff walk';
}

//-------------------
// Results of the read tools

export interface ParseNote {
	parseErrors?: string[]; // the first errors of the parse. The facts can be incomplete
}

export interface ViewFacts {
	file: string | null;
	lineCount?: number;
	cursor: { line: number; col: number } | null;
	selection: { lines: [number, number]; start: { line: number; col: number }; end: { line: number; col: number }; text: string } | null;
	function: { name: string; macroCall?: string; lines: [number, number] } | null;
	otherFiles: string[]; // the other C++ files on the screen
	sideView: { isOpen: boolean; file: string | null; lenses: string[]; modelLayersShown: boolean };
	model: { functions: { function: string; blocks: string[] }[]; notes: number; comments: number; details: string[] } | null;
	review: GuideFacts | null; // the guided review or the diff walk
	engine: EngineState;
	project: { folders: string[]; compileDatabases: string[] };
}

export interface FunctionListFacts extends ParseNote {
	file: string;
	functions: { name: string; macroCall?: string; kind: 'function' | 'method' | 'constructor' | 'destructor'; lines: [number, number] }[];
}

export type StatementKind = 'decl' | 'expr' | 'if' | 'for' | 'while' | 'do' | 'switch' | 'block' | 'return' | 'break' | 'continue' | 'throw' | 'try' | 'other';

// A statement with the data that goes in and comes out, and its exits, thread starts, events and calls. Below the third
// level, statements and body give only the number of the statements
export interface StatementFacts {
	lines: [number, number];
	kind: StatementKind;
	text: string;
	in?: string[];
	out?: string[];
	exits?: string[];
	threads?: string[];
	events?: string[];
	calls?: string[];
	branches?: { lines: [number, number]; label: string; in?: string[]; out?: string[]; statements: StatementFacts[] | string }[];
	body?: StatementFacts[] | string;
}

export interface StructureFacts extends ParseNote {
	file: string;
	function: string;
	lines: [number, number];
	statements: StatementFacts[];
}

export type FlowRole = 'def' | 'write' | 'mayWrite' | 'check' | 'read';

export interface VariableFlowFacts {
	kind: 'variable';
	name: string;
	type: string;
	storage: string;
	function: string;
	refs: { line: number; role: FlowRole; finding?: string }[];
	shown?: boolean;
}

export interface MemberFlowFacts {
	kind: 'member' | 'static member' | 'global';
	name: string;
	type: string;
	access: 'private' | 'protected' | 'public';
	atomic?: boolean;
	refs: { file?: string; line: number; role: FlowRole; function: string; thread: string; locks?: string[]; threads?: string[] }[];
	threads: string; // for example "the caller and 1 thread start"
	locks: string; // for example "all under mutex_"
	verdict?: { kind: 'race' | 'safe'; text: string };
	shown?: boolean;
}

export type FlowFacts = VariableFlowFacts | MemberFlowFacts;

export interface CallSiteFacts {
	line: number;
	result: 'none' | 'discarded' | 'returned' | 'stored' | 'checked' | 'used';
	async?: string; // the thread start that runs the call
	event?: boolean;
	writes?: string[]; // the arguments that the call can write
	into?: string; // the variable that stores the result
	optional?: 'checked' | 'unchecked'; // a std::optional result
	uncheckedLine?: number;
	virtualOf?: string; // an override that a virtual call can run: the function that the call names
}

export interface CallFacts extends ParseNote {
	file: string;
	function: string;
	callers: (CallSiteFacts & { caller: string })[];
	calls: (CallSiteFacts & { callee: string; where: 'main' | 'project' | 'library' })[];
	callersInOtherFiles: { caller: string; file: string; line: number; callLines: number[] }[];
	note: string;
}

export interface ThreadFacts extends ParseNote {
	file: string;
	threads: { label: string; via: string; line: number; function: string; handle: string; repeated?: boolean; joins: string[] }[];
	items: {
		item: string;
		kind: 'member' | 'static' | 'global' | 'local' | 'capture';
		type: string;
		verdict: string; // Race, Check, Safe, Safe now or Dangling
		caller: string;
		worker: string;
		protection: string;
		summary: string;
		fix?: { line: number; text: string; before: string; after: string };
	}[];
	counts: { race: number; check: number; safe: number };
	truncated?: boolean;
}

export type HiddenKind = 'copy' | 'move' | 'conversion' | 'temporary' | 'shadow' | 'destructor' | 'allocation' | 'lookup' | 'state';

export interface HiddenFacts extends ParseNote {
	file: string;
	function: string;
	items: { line: number; kind: HiddenKind; text: string; detail: string; estimated?: boolean }[];
	more?: number;
}

// Forward declarations can replace the include, or the first use that needs it
export type IncludeForward =
	| { state: 'possible'; text: string; types: { name: string; lines: number[] }[] }
	| { state: 'needed'; blocker: { name: string; kind: string; line: number } };

export interface IncludeFacts extends ParseNote {
	file: string;
	stats: { lines: number; total: number; includes: number; skipped: number; unused: number; missing: number; forward: number };
	groups: { group: string; lines: number }[];
	includes: {
		line: number;
		include: string;
		lines: number;
		state: 'main' | 'entered' | 'skipped' | 'missing';
		possiblyUnused?: boolean;
		forward?: IncludeForward;
		includedBefore?: string;
	}[];
	largestHeaders: { file: string; lines: number }[];
	includedBy?: { translationUnits: string[]; count: number; ofAll: number; more?: number };
}

export interface OutlineMemberFacts {
	line: number;
	kind: 'field' | 'method' | 'constructor' | 'destructor' | 'operator' | 'conversion' | 'type' | 'enumerator' | 'friend' | 'using' | 'property';
	name: string;
	text?: string;
	access?: string;
	marks?: string[];
	section?: string;
	annotation?: string;
	macro?: string;
	offset?: number;
	size?: number;
	file?: string; // a member in a different file
	definition?: { file: string; line: number };
}

export interface OutlineFacts extends ParseNote {
	file: string;
	line: number;
	type: string;
	kind: string; // class, struct, union, enum or enum class
	template?: string;
	underlying?: string;
	final?: boolean;
	abstract?: boolean;
	library?: boolean;
	bases: { name: string; access: string; virtual?: boolean; offset?: number; size?: number }[];
	layout?: { size: number; align: number; padding: number; vptr?: boolean; holes: { offset: number; size: number }[] };
	members: OutlineMemberFacts[];
	more?: number;
	inherited: { base: string; count: number; names: string[] }[];
	truncated?: boolean;
}

export type HeatBand = 'cool' | 'warm' | 'hot' | 'very hot';

// A signal of the heat: one reason of the score, with its kind (id) and its measure (value)
export type HeatSignal = { group: 'reach' | 'risk' | 'history'; points: number; text: string } & (
	// the function runs in each frame: the frame function, the functions from it to the caller before this function,
	// and the number of calls from the frame function
	| { id: 'framePath'; value: { reason: string; path: string[]; calls: number; isInLoop: boolean } }
	| { id: 'frameLoop'; value: true } // a caller on the frame path calls the function in a loop
	| { id: 'callers'; value: { direct: number; transitive: number; isCapped: boolean } }
	| { id: 'callerFiles'; value: number }
	| { id: 'includeReach'; value: { file: string; units: number; total: number } } // the source files with the declaration
	| { id: 'virtual'; value: 'override' | 'virtual' }
	| { id: 'decisions' | 'depth' | 'length' | 'commits'; value: number } // length: the lines of the body
	| { id: 'writes' | 'sharedUnprotected' | 'sharedLocked'; value: string[] } // the names of the data
	| { id: 'loopCosts'; value: { allocations: number; copies: number } }
	| { id: 'fixes'; value: string[] } // the summaries of the commits that fix bugs
	| { id: 'recent'; value: 'uncommitted' | 'recent' }
);

export interface HeatFacts {
	file: string;
	isReachComplete: boolean; // false: the reach of one or more functions has no callers and no frame path yet
	functions: {
		name: string;
		lines: [number, number];
		score: number; // 0 to 100
		band: HeatBand;
		flames: number; // 1 to 5
		reach: number;
		risk: number;
		history: number;
		siloed?: boolean;
		// false until the scan of the call graph is complete: the reach has no callers and no frame path. The score can
		// then be too low, or too high, because the half points of a siloed function also do not apply
		isReachComplete: boolean;
		reasons: string[];
		signals: HeatSignal[];
	}[];
	more?: number;
	note?: string; // for example: no function has a line in the lines
	callGraph?: string; // the state of the scan of the call graph
	notices: string[];
}

export interface LogicDecision {
	key: string; // the key for the choices
	kind: 'if' | 'loop' | 'do' | 'switch' | 'ternary' | 'chain';
	line: number;
	text: string;
	options: string[];
	path: string; // the option of the path
	isChosen?: boolean; // the option comes from the choices
	inside?: { key: string; option: string }; // the decision and the option that contain this decision
}

export interface LogicPathStep {
	kind: 'decision' | 'event' | 'warning' | 'effect' | 'return' | 'end';
	line: number;
	text: string;
	key?: string; // a decision: its key
	option?: string; // a decision: the option of the path
	problem?: string; // an event: the warning for a second event
	changes?: { line: number; target: string; action: string; kind: 'member' | 'global' | 'parameter' | 'capture' }[];
}

export interface LogicFacts extends ParseNote {
	file: string;
	function: { name: string; lines: [number, number] };
	lambda?: { index: number; in: string };
	decisions: LogicDecision[];
	path: LogicPathStep[];
	warnings: { line: number; text: string }[];
	deadLines: number[]; // the lines that the path does not run
	note?: string;
	shown?: boolean;
}

export interface RippleBodyFacts {
	file: string;
	function: string;
	lambdaLine?: number;
	depth: number; // 0: the changed function, 1: a caller that gets its return value, 2: a caller of a caller
	call?: { file: string; line: number }; // the call in the caller
	lines: number[];
	steps: {
		line: number;
		kind: 'seed' | 'data' | 'control' | 'member' | 'async' | 'lambda';
		confidence: 'exact' | 'call' | 'estimated';
		distance: number;
		text: string;
		via?: string;
	}[];
	moreSteps?: number;
	exits: { kind: 'return' | 'member' | 'global' | 'reference' | 'argument' | 'capture' | 'async' | 'call'; line: number; text: string; followed?: boolean }[];
}

export interface RippleFacts {
	state: 'ready' | 'running' | 'failed' | 'none';
	note?: string;
	message?: string; // the error of a failed review, or a review with no changes
	base?: string;
	target?: string;
	counts?: { changes: number; bodies: number; reachedLines: number };
	changes?: { file: string; function: string; lines: number[]; bodies: RippleBodyFacts[] }[];
	moreChanges?: number;
	otherLines?: { file: string; text: string }[];
	notice?: string;
	errors?: string[];
}

export interface HotChange {
	function: string;
	lines: [number, number];
	score: number;
	band: HeatBand;
	isReachComplete: boolean;
	reasons: string[];
	file: string;
}

export interface ReviewFacts {
	root: string;
	target?: string;
	base?: string;
	hottestChanges?: HotChange[];
	files: {
		file: string;
		lines: number;
		isChanged: boolean;
		changedLines?: number[];
		changedFunctions?: { function: string; lines: [number, number]; score: number; band: HeatBand; isReachComplete: boolean }[];
		diff?: string;
		isDiffTruncated?: boolean;
	}[];
	moreFiles?: number;
	notFound?: string[];
	notCpp?: string[];
	notice?: string;
	callGraph?: string;
	noHeat?: string;
}

export interface DiffHunkFacts {
	id: string;
	lines: [number, number];
	added: number;
	removed: number;
	functions?: string[];
	newFunctions?: string[];
	heat?: { function: string; score: number; band: HeatBand; isReachComplete: boolean }[];
	diff?: string;
	isDiffTruncated?: boolean;
}

export interface DiffFacts {
	root: string;
	base: string;
	hottestChanges?: (HotChange & { hunks: string[] })[];
	files: { file: string; lines: number; isNew?: boolean; hunks: DiffHunkFacts[] }[];
	suggestedSteps: { title: string; hunks: string[]; heat?: number }[];
	notInSuggestedSteps?: string[];
	deletedFiles?: string[];
	otherChangedFiles?: string[];
	notice?: string;
	note?: string;
	callGraph?: string;
	noHeat?: string;
}

export interface GuideFacts {
	kind?: 'diff walk'; // no kind: a guided review
	base?: string;
	title: string;
	currentStep: number;
	progress: string;
	steps: { step: number; title: string; file: string; lines: [number, number]; status: GuideStatus; hasNote?: boolean; added?: number; removed?: number }[];
}

export interface CallGraphFacts {
	state: 'none' | 'scanning' | 'stopped' | 'ready' | 'failed';
	done?: number; // the progress of the scan: source files
	total?: number;
	error?: string;
	lastScan?: {
		functions: number;
		calls: number;
		sourceFiles: number;
		isComplete: boolean;
		frames: { function: string; file: string; line: number; reason: string }[];
		failed?: string[];
	};
	note?: string;
}

//-------------------
// Results of the view tools

export interface ShowBlocksResult extends ParseNote {
	file: string;
	function: string;
	shown: number;
	functionsWithBlocks: number;
	blocks: { id: string; parent?: string; lines: [number, number]; title: string; movedFrom?: [number, number]; in?: string[]; out?: string[]; items?: string[] }[];
}

export interface ShowLineResult {
	file: string;
	line: number;
	text: string;
	shown: boolean;
}

export interface HighlightResult {
	file: string;
	shown: number;
	notesInFile: number;
	notes: { lines: [number, number]; kind: NoteKind; block?: string; function?: string }[];
}

export interface CommentLinesResult {
	file: string;
	shown: number;
	commentsInFile: number;
	lines: number[];
}

export interface AddDetailResult {
	file: string;
	id: string;
	lines: [number, number];
	code: string;
	title: string;
	detailsInFile: number;
	note: string;
}

export interface ClearResult {
	removed: number;
}

export interface ClearedResult {
	cleared: boolean;
}

export interface SetLensResult {
	lens: string;
	on: boolean;
	changed: boolean;
	lenses: string[]; // the lenses that are on
}

export interface StopCallGraphResult extends CallGraphFacts {
	stopped: boolean;
}

export interface ReviewPlanResult {
	title: string;
	steps: { step: number; title: string; file: string; lines: [number, number] }[];
	shown: number;
	note: string;
}

export interface DiffWalkResult {
	title: string;
	steps: { step: number; title: string; file: string; lines: [number, number]; addedByDataFlow?: boolean }[];
	addedSteps?: { title: string; hunks: string[] }[];
	addedNote?: string;
	notShown?: string[]; // with allHunks false: the hunks that no step names
	shown: number;
	note: string;
}

export interface ReviewStepResult {
	step: number;
	title: string;
	file: string;
	lines: [number, number];
	status: GuideStatus;
	progress: string;
}

export type CloseGuideResult =
	| { closed: false; note: string }
	| { closed: true; kind: 'review' | 'diff walk'; title: string; steps: number; progress: string };
