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
	// The tools of DataFlow in the MCP server with their JSON schemas. callTool runs a tool by its name
	readonly tools: readonly DataFlowTool[];

	// The engine starts, is ready, stops or fails, or the compile databases change
	readonly onDidChangeEngineState: vscode.Event<EngineStateEvent>;
	// The file, the function or the line at the cursor changes. The cursor is the cursor of the active C++ editor, or
	// of the side view if no C++ editor shows. The event comes after the engine found the function at the cursor
	readonly onDidChangeView: vscode.Event<ViewEvent>;
	// The guide that shows changes: the top guide of the stack. It starts, goes to a step, gets a mark or a note, or
	// closes. change and by give the cause. null: no guide shows
	readonly onDidChangeGuide: vscode.Event<GuideEvent | null>;
	// The scan of the call graph starts, makes progress, stops or ends. At its end, the heat of the functions can change
	readonly onDidChangeCallGraph: vscode.Event<CallGraphFacts>;
	// The user clicked a button of your extension on a note, a detail or a step of a guide
	readonly onDidInvokeAction: vscode.Event<ActionEvent>;
	// The engine parsed a file again, for example the active file 250 ms after the last key. Ask for new facts of the file
	// after this event
	readonly onDidParse: vscode.Event<ParseEvent>;

	// Runs a tool of DataFlow, and gives its result. The typed methods below run the same tools
	callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;

	// Adds tools of your extension to the MCP server of DataFlow, so a client of the server, for example Claude Code,
	// can call them. The MCP name of a tool is the name of your client in lowercase, then _, then the name of the tool.
	// All tools must be correct, or no tool goes in, and the method throws an error. The result removes the tools: add it
	// to the subscriptions of your extension
	registerTools(tools: ExtensionTool[]): vscode.Disposable;

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
	getCallers(args?: CallersArgs): Promise<CallersFacts>; // get_callers
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
	remove(args: RemoveArgs): Promise<RemoveResult>; // remove
	setLens(args: SetLensArgs): Promise<SetLensResult>; // set_lens
	clearFlow(): Promise<ClearedResult>; // clear_flow
	startRipple(args?: RippleArgs): Promise<RippleFacts>; // start_ripple
	clearRipple(): Promise<ClearedResult>; // clear_ripple
	markBase(args: MarkArgs): Promise<MarkResult>; // mark_base
	deleteMark(args: DeleteMarkArgs): Promise<DeleteMarkResult>; // delete_mark
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

// A tool of your extension for the MCP server. name: letters, digits and _. The MCP name, with the name of your client
// before it, has a maximum of 64 characters. description: the server puts the name of your client before it.
// inputSchema: a JSON Schema with "type": "object". call: gets the arguments of the client, and gives a text, or a value
// that DataFlow gives as JSON. An error of call goes to the client as the result of the tool
export interface ExtensionTool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	isReadOnly?: boolean; // the tool changes nothing. Default: false
	isDestructive?: boolean; // the tool removes data of the user. Default: false
	call(args: Record<string, unknown>): unknown;
}

//-------------------
// Events

export interface EngineStateEvent {
	state: EngineState;
	compileDatabases: string[];
	error?: string; // the reason of the state failed, or of the state stopped with no compile database
}

// A click on a button of your extension. action: the id of the button. item: the id of the note or the detail. step: the
// number of the step, from 1. file and line: the place of the note, of the detail or of the step
export interface ActionEvent {
	kind: 'note' | 'detail' | 'step';
	action: string;
	item?: string;
	file?: string;
	line?: number;
	step?: number;
}

// The end of a parse of a file. errorCount: the number of the errors. errors: the first errors, a maximum of 5.
// isFailed: the engine could not parse the file
export interface ParseEvent {
	file: string;
	parseMs?: number;
	errorCount: number;
	errors: string[];
	isFailed?: boolean;
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

// The callers up to depth calls from the function: 1 to 6, default 3
export interface CallersArgs extends FunctionArgs {
	depth?: number;
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

// base: "uncommitted" (default), "target", or a commit, a tag or a branch. paths: only the changes under these paths.
// allFiles: also the changed text files that are not C or C++ files, for example CMakeLists.txt. Default: false
export interface DiffArgs {
	base?: string;
	paths?: string[];
	allFiles?: boolean;
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

// A button on a note, a detail or a step. A click sends onDidInvokeAction with the id. An item has a maximum of 3 buttons.
// The id has a maximum of 64 characters, and the title 40. Only an extension can give buttons
export interface ItemAction {
	id: string;
	title: string;
}

export interface NoteInput {
	lines?: [number, number];
	block?: string; // the id of a block, instead of lines
	function?: string; // the function of the block, if more functions have a block with the id
	kind: NoteKind;
	note: string; // maximum 300 characters
	actions?: ItemAction[];
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
	actions?: ItemAction[];
}

// The ids of notes, comments and details of your extension in a file
export interface RemoveArgs extends FileArgs {
	ids: string[];
}

// base: "target" (default), "uncommitted", a commit, a tag or a branch, or "mark:<name>", as for getDiff. paths: only
// the changes under these paths
export interface RippleArgs {
	base?: string;
	paths?: string[];
}

// name: 1 to 64 letters, digits, "_", "-" or ".". paths: files and folders of the project, relative to the repository or
// absolute. The mark keeps the text of each text file under the paths, a maximum of 500 files and 20 MB
export interface MarkArgs {
	name: string;
	paths: string[];
}

export interface DeleteMarkArgs {
	name: string;
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

// The data of your client on a step: label, a short text that the tab Guide shows next to the title, maximum 40
// characters. data: a JSON object that DataFlow keeps and gives again in GuideFacts, maximum 4096 characters as JSON
export interface StepClientData {
	label?: string;
	data?: Record<string, unknown>;
}

// id: the id of a guide of your client. The new plan replaces that guide at its place in the stack. With no id, the
// new guide goes on the top of the stack. The stack has a maximum of 5 guides
export interface ReviewPlanArgs {
	id?: string;
	title?: string;
	summary?: string;
	// file: a text file of the project. newFile: a file that is not there yet, in the place of file. lines: necessary
	// with file, optional with newFile
	steps: ({ title: string; file?: string; newFile?: string; lines?: [number, number]; text: string; checks?: string[]; kind?: GuideKind; actions?: ItemAction[] } & StepClientData)[];
}

export interface DiffWalkArgs {
	id?: string; // as in ReviewPlanArgs
	title?: string;
	summary?: string;
	steps: ({ title: string; hunks: string[]; text: string; checks?: string[]; kind?: GuideKind; actions?: ItemAction[] } & StepClientData)[]; // hunks: the ids of getDiff
	// true (default): a step at the end for each hunk that no step names. false: only the hunks of the steps
	allHunks?: boolean;
}

// id: the guide. Default: the top guide. A guide under the top guide changes in place, and the view stays. force: true
// changes a guide of a different owner. Use it only when the user asks for it
export interface ReviewStepArgs {
	id?: string;
	step: number;
	note?: string; // an empty text removes the note
	status?: GuideStatus;
	label?: string; // an empty text removes the label
	data?: Record<string, unknown> | null; // null removes the data
	force?: boolean;
}

// id: the guide. Default: the top guide. force: as in ReviewStepArgs
export interface CloseGuideArgs {
	id?: string;
	kind?: 'review' | 'diff walk';
	force?: boolean;
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
	model: { functions: { function: string; blocks: string[] }[]; notes: number; comments: number; details: string[] } | null; // your layer
	otherClients?: { client: string; blocks: number; notes: number; comments: number; details: number }[]; // the layers of the other clients
	review: GuideFacts | null; // the guide that shows: the top guide of the stack
	guides?: GuideRef[]; // the guides of the stack, the top guide first
	marks?: MarkFacts[]; // the marks of your client, the newest first
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

// address: the code uses the address of the function, so a pointer or a std::function can call it. libraryOverride: the
// function overrides a virtual function of a library, and the library can call it. slot: qt can call the slot, for
// example through a signal of a library
export type UnknownCallersCause = 'address' | 'libraryOverride' | 'slot';

// A signal of the heat: one reason of the score, with its kind (id) and its measure (value)
export type HeatSignal = { group: 'reach' | 'risk' | 'history'; points: number; text: string } & (
	// the function runs in each frame: the frame function, the functions from it to the caller before this function,
	// and the number of calls from the frame function. isPastLimit: more than 8 calls, so the path gives no points
	| { id: 'framePath'; value: { reason: string; path: string[]; calls: number; isInLoop: boolean; isPastLimit?: boolean } }
	// callers that the call graph cannot see: a use of the address, a library that calls an override, or qt that calls a
	// slot. 0 points, and the function is never siloed
	| { id: 'reachUnknown'; value: { cause: UnknownCallersCause; via: string; file: string; line: number } }
	// the test functions that reach the function, and their first 5 files. 0 points
	| { id: 'tests'; value: { functions: number; files: string[]; isCapped: boolean } }
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
		// callers that the call graph cannot see. The reach can be larger than the score tells
		reachUnknown?: { cause: UnknownCallersCause; text: string };
		tests?: { functions: number; files: string[]; isCapped?: boolean }; // the test functions that reach the function
		reasons: string[];
		signals: HeatSignal[];
	}[];
	more?: number;
	note?: string; // for example: no function has a line in the lines
	callGraph?: string; // the state of the scan of the call graph
	notices: string[];
}

export interface CallersFacts extends ParseNote {
	file: string;
	function: string;
	isReachComplete: boolean; // false until the scan of the call graph is complete. Then callers is empty
	callers: {
		function: string;
		file: string;
		lines: [number, number]; // the lines of the caller
		depth: number; // 1: a direct caller, 2: a caller of a caller
		calls: string; // the function that the caller calls on the way
		callLines: number[]; // the lines of these calls, or of the call of connect for a connection of qt
		signal?: boolean; // a signal of qt of the project, with no body
		connection?: boolean; // the signal calls the slot through a connection of qt
	}[];
	more?: boolean; // the result stops after 200 callers
	framePaths: { reason: string; calls: number; path: string[] }[]; // from the frame function to the function
	reachUnknown?: { cause: UnknownCallersCause; text: string };
	callGraph?: string; // the state of the scan of the call graph
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
	// isCpp false: a text file that is not a C or C++ file (allFiles). It has no functions and no heat
	files: { file: string; lines: number; isNew?: boolean; isCpp?: false; hunks: DiffHunkFacts[] }[];
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
	id: string; // g1, g2 and so on
	owner: string; // user for a command of DataFlow, else the name of the client that made the guide
	kind?: 'diff walk'; // no kind: a guided review
	base?: string;
	title: string;
	currentStep: number;
	progress: string;
	steps: GuideStepFacts[];
}

// file: the name of the file. fileKind text: a text file that is not a C or C++ file, which opens in the text editor.
// fileKind new: a file that is not there yet. note: the note of the client. userNote: the note of the user
export interface GuideStepFacts extends StepClientData {
	step: number;
	title: string;
	file: string;
	lines: [number, number];
	status: GuideStatus;
	fileKind?: 'text' | 'new';
	hasNote?: boolean;
	note?: string;
	userNote?: string;
	added?: number;
	removed?: number;
}

// A guide of the stack
export interface GuideRef {
	id: string;
	owner: string;
	title: string;
	kind: 'review' | 'diff walk';
}

// The cause of a change of the guide that shows. start: a new guide on the top. replace: a plan replaced the top guide.
// step: a different step shows. mark, note, userNote: the mark, the note of the client or the note of the user of a
// step changed. label: the label or the data of a step changed. move: an edit moved the lines of steps. close: the top
// guide closed, and the guide under it shows. show: the user brought a guide of the stack to the top
export type GuideChange = 'start' | 'replace' | 'step' | 'mark' | 'note' | 'userNote' | 'label' | 'move' | 'close' | 'show';

export interface GuideEvent extends GuideFacts {
	change: GuideChange;
	by: string; // user, or the name of the client
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
	notes: { id: string; lines: [number, number]; kind: NoteKind; block?: string; function?: string }[];
}

export interface CommentLinesResult {
	file: string;
	shown: number;
	commentsInFile: number;
	lines: number[];
	ids: string[]; // the ids of the new comments, in the sequence of their lines
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
	removed: number; // the layers of your client that went away
}

export interface RemoveResult {
	file: string;
	removed: string[];
	unknown: string[]; // the ids that the layer of your client does not have
	notesInFile: number;
	commentsInFile: number;
	detailsInFile: number;
}

export interface ClearedResult {
	cleared: boolean;
}

// A mark of your client. files: the number of the text files in the mark. time: the time of the mark (ISO 8601)
export interface MarkFacts {
	name: string;
	files: number;
	paths: string[];
	time: string;
}

export interface MarkResult extends MarkFacts {
	bytes: number; // the size of the texts in the mark
	note: string;
}

// deleted: false if your client has no mark with the name. marks: the names of the marks that stay
export interface DeleteMarkResult {
	deleted: boolean;
	marks: string[];
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

// id: the id of the guide, for review_step, close_guide and a new plan that replaces it. shown: 1 if the guide shows,
// 0 if it is under the top guide
export interface ReviewPlanResult {
	id: string;
	title: string;
	steps: { step: number; title: string; file: string; lines: [number, number]; fileKind?: 'text' | 'new' }[];
	shown: number;
	note: string;
}

export interface DiffWalkResult {
	id: string;
	title: string;
	steps: { step: number; title: string; file: string; lines: [number, number]; fileKind?: 'text'; addedByDataFlow?: boolean }[];
	addedSteps?: { title: string; hunks: string[] }[];
	addedNote?: string;
	notShown?: string[]; // with allHunks false: the hunks that no step names
	shown: number;
	note: string;
}

// isShown: false if the guide is under the top guide. Then the view did not go to the step
export interface ReviewStepResult {
	id: string;
	isShown: boolean;
	step: number;
	title: string;
	file: string;
	lines: [number, number];
	status: GuideStatus;
	progress: string;
}

// shows: the guide that shows after the close, or null
export type CloseGuideResult =
	| { closed: false; note: string }
	| { closed: true; id: string; kind: 'review' | 'diff walk'; title: string; steps: number; progress: string; shows: GuideRef | null };
