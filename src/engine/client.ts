import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { RpcConnection } from './rpc';

// The types of the engine protocol. Lines and columns start at 1.

export interface EnginePosition {
	line: number;
	col: number;
}

export interface EngineRange {
	begin: EnginePosition;
	end: EnginePosition;
}

export interface EngineFunction {
	name: string;
	qualifiedName: string;
	kind: 'function' | 'method' | 'constructor' | 'destructor';
	range: EngineRange;
	body?: EngineRange;
	nameAt?: EnginePosition; // the position of the name
	macroCall?: string; // the text of the macro call, if ## in the macro makes the name, for example TEST_CASE("split")
}

// The roles of a reference in dataflow/flow. engine/README.md describes them.
export type FlowRole = 'def' | 'write' | 'mayWrite' | 'check' | 'read';

export interface FlowVariable {
	name: string;
	type: string;
	storage: string;
	declRef: number; // the index of the declaration in refs
}

// A reference. col and len count UTF-8 bytes. lenses/flow.ts converts them to the columns of VS Code.
export interface FlowReference {
	var: number;
	role: FlowRole;
	line: number;
	col: number;
	len: number;
	alsoRead?: boolean;
	finding?: string;
}

export interface FlowModel {
	function: EngineFunction;
	variables: FlowVariable[];
	refs: FlowReference[];
	edges: [number, number][]; // from a definition to a use, as indexes in refs
	hasCfg?: boolean; // false if Clang made no CFG for the function. Then the model has no edges
}

// The data of dataflow/member: a data member of a class, and its accesses in the translation unit. Lines and columns
// start at 1. Columns count UTF-8 bytes. Files are absolute paths. engine/README.md describes the fields.
export interface MemberPlace {
	file: string;
	line: number;
	col: number;
	len: number;
}

export interface MemberInfo {
	name: string;
	type: string;
	kind?: 'field' | 'static' | 'global'; // a data member, a static data member or a global variable
	className: string; // empty for a global variable
	qualifiedClass: string; // the class, or the namespace of a global variable
	access: 'private' | 'protected' | 'public';
	isAtomic: boolean; // a std::atomic or a Qt atomic type
	isSync: boolean; // a mutex, a condition variable or a different object that threads use to synchronize
	init?: string; // the default member initializer
	decl: MemberPlace;
}

// A function or a lambda with an access, or the function around such a lambda
export interface MemberBody {
	name: string;
	qualifiedName: string; // empty for a lambda
	kind: 'function' | 'method' | 'constructor' | 'destructor' | 'lambda';
	file: string;
	line: number;
	outer: number; // the body around a lambda, or -1
	thread: number; // the thread that runs the body, or -1
	threadCall?: { file: string; line: number }; // the call in a body on the thread that runs this function on it
}

// A statement that starts a thread, for example std::thread, the run function of a QThread, the post function of a job
// queue, or a thread of a different source file that calls into this one
export interface MemberThread {
	via: string;
	file: string;
	line: number;
	isRepeated: boolean; // a loop starts it, so more than one thread can run the body at the same time
	calls?: string[]; // the functions of other source files that the thread calls
}

// A thread context of an access from the threads analysis of the translation unit
export interface MemberRun {
	thread: number; // the index in threads, or -1 for the caller thread
	locks?: string[]; // the mutexes on the way to the access
	ordered?: number[]; // the threads that the access is in sequence with: a join, a start or a check of a handle
}

export interface MemberReference extends MemberPlace {
	fn: number; // the body, or -1 for the declaration
	role: FlowRole;
	alsoRead?: boolean;
	whole?: boolean; // a change of the whole object, for example an assignment or a call that gets it by reference
	object?: string; // the object if it is not this, for example _o
	locks?: string[]; // the mutexes that lock guards and lock() calls hold at the access
	runs?: MemberRun[]; // the threads that run the access. Missing if the threads analysis has no data for it
}

// A thread of a different source file that calls a function of the translation unit of a member request
export interface MemberEntry {
	function: string; // the qualified name of the function
	via: string;
	file: string;
	line: number;
	isRepeated: boolean;
}

// The options of dataflow/member
export interface MemberOptions {
	asyncFunctions: string[];
	readFunctions?: string[];
	roots?: string[]; // the folders of the project, for the threads analysis
	entries?: MemberEntry[];
}

export interface MemberModel {
	member: MemberInfo;
	fields: { name: string; type: string; line: number }[]; // the data members and the static data members of the class
	functions: MemberBody[];
	threads: MemberThread[];
	refs: MemberReference[];
	edges: [number, number][]; // from a definition to a use in the same body, as indexes in refs
	function: EngineFunction | null; // the function at the position of the request
}

// The member at a position, or a member by the qualified name of its scope and its name. The scope is a class, or the
// namespace of a global variable
export type MemberSelector = { line: number; col: number } | { className: string; member: string };

// The data of dataflow/calls: the call graph of the functions of a file. Lines start at 1. Columns count UTF-8 bytes.
// engine/README.md describes the fields.
export interface CallFunctionInfo {
	name: string;
	qualifiedName: string; // empty for a lambda
	kind: 'function' | 'method' | 'constructor' | 'destructor' | 'lambda';
	file: string;
	line: number; // the name of the definition, else of the declaration
	col: number;
	len: number;
	where: 'main' | 'project' | 'library'; // the file of the definition: the main file, a different file of the project, or a library
	isDefined: boolean; // the translation unit has the body
	macroCall?: string; // the text of the macro call, if ## in the macro makes the name, for example TEST_CASE("split")
	range?: { begin: number; end: number }; // a function of the main file: its lines
}

export interface CallSiteInfo {
	from: number; // the index of the caller in functions
	to: number;
	line: number;
	col: number;
	result: 'none' | 'discarded' | 'returned' | 'stored' | 'checked' | 'used';
	inLambda?: boolean;
	async?: string; // the thread start that runs the call, for example std::thread
	event?: boolean;
	writes?: string[]; // the arguments that the call can write
	into?: string; // the variable that stores the result
	optional?: 'checked' | 'unchecked'; // a std::optional result
	uncheckedLine?: number; // the first access with no check
	virtualOf?: number; // an override that a virtual call can run: the index of the function that the call names
}

export interface CallGraphModel {
	functions: CallFunctionInfo[];
	calls: CallSiteInfo[];
	cached: boolean;
}

export interface CallOptions {
	eventFunctions: string[];
	asyncFunctions: string[];
	roots: string[]; // the folders of the project. A function outside of them is a library function
}

// The data of dataflow/threads: the threads of a file, the data that they share, and the protection of each access.
// Lines start at 1. Columns count UTF-8 bytes. Function and thread numbers are indexes. -1 is the caller thread.
// engine/README.md describes the fields.
export interface ThreadsPlace {
	file: string;
	line: number;
	col: number;
}

export interface ThreadsStartInfo {
	via: string; // for example std::thread or tf::Executor::async
	name: string; // the function that the thread runs, or lambda
	handle: string; // the variable or the member that keeps the thread or its future. Empty if there is none
	isRepeated: boolean; // more than one thread of the start can run at the same time
	isJoined: boolean; // a join comes after the start in the same function
	fn: number; // the function with the start, or -1
	runs: number; // the function or the lambda that the thread runs, or -1
	at?: ThreadsPlace;
	joins: (ThreadsPlace & { kind: string; fn: number })[];
}

export interface ThreadsBodyInfo {
	name: string;
	qualifiedName: string; // empty for a lambda
	kind: 'function' | 'method' | 'constructor' | 'destructor' | 'lambda';
	file: string;
	line: number;
	first: number; // the first line and the last line of the body
	last: number;
	threads: number[]; // the threads that run the body
}

// The threads that an access is in sequence with: after a join, before the start, where the handle is empty, or where
// the future is ready
export interface ThreadsOrderInfo {
	after?: number[];
	before?: number[];
	empty?: number[];
	ready?: number[];
}

export interface ThreadsAccessInfo extends ThreadsPlace {
	len: number;
	role: 'def' | 'write' | 'mayWrite' | 'check' | 'read';
	alsoRead?: boolean;
	whole?: boolean; // an access of the whole object, for example a call that gets it by reference
	atomic?: boolean;
	thread: number;
	fn: number;
	path: string; // the object, for example charge.optimizers[].schedule.kw
	sub: string[]; // the steps after the item. "[]" is an element
	locks: string[]; // the mutexes that lock guards hold
	order: ThreadsOrderInfo;
	guards: { text: string; isNegated: boolean }[]; // the conditions around an access of the caller thread, the innermost first
	via: (ThreadsPlace & { fn: number })[]; // the calls and the thread start on the way to the access
	swap?: { thread: number; from: string; to: string }; // a condition that reads the item before it checks the handle
}

export interface ThreadsItemInfo {
	key: string;
	label: string; // for example charge.is_dirty, jobs_ or TimeSummary::parent
	kind: 'member' | 'static' | 'global' | 'local';
	type: string;
	isAtomic: boolean;
	decl?: ThreadsPlace & { len: number };
	refs: ThreadsAccessInfo[];
}

// The local variables that a thread lambda captures by reference, if the thread can run after its function returns
export interface ThreadsCaptureInfo {
	thread: number;
	fn: number;
	vars: (ThreadsPlace & { name: string; kind: 'reference' | 'object' })[];
}

export interface ThreadsModel {
	threads: ThreadsStartInfo[];
	items: ThreadsItemInfo[];
	captures: ThreadsCaptureInfo[];
	functions: ThreadsBodyInfo[];
	isTruncated: boolean; // the analysis stopped at a limit
	analysisMs: number;
	cached: boolean;
}

export interface ThreadsOptions {
	asyncFunctions: string[];
	roots: string[]; // the folders of the project. The analysis follows the calls into their headers
}

// The data of dataflow/includes: the include hierarchy of a translation unit. Lines start at 1. engine/README.md
// describes the fields.
export interface IncludeFile {
	path: string;
	lines: number;
	group: string; // for example "project headers", "C++ standard library" or "Qt"
	isSystem: boolean;
}

export type IncludeState = 'main' | 'entered' | 'skipped' | 'missing';

export interface IncludeNode {
	file: number; // the index in files, or -1 for a file that the preprocessor did not find
	parent: number; // -1 for the main file
	line: number; // the line of the directive in the file of the parent. 0 for the main file and a forced include
	spelled: string; // for example <vector> or "types.hpp"
	state: IncludeState;
	first?: number; // a skipped node: the node that entered the file first
	isOwn?: boolean; // the header of the main file, for example a.h for a.cpp
	isUsed?: boolean; // an entered header that the main file includes: the main file uses a name of it
	use?: { name: string; line: number; node?: number }; // the first use. node: the node of the file of the name
}

export interface IncludeModel {
	files: IncludeFile[];
	nodes: IncludeNode[]; // the main file first, then the directives in the sequence of the preprocessor
	preprocessMs: number;
	cached: boolean;
}

// The data of dataflow/includers: the source files of the compile databases that include a file
export interface IncludersResult {
	file: string;
	units: string[]; // sorted. A source file does not include itself
	unitCount: number; // all source files of the compile databases
	failed: string[]; // the source files that the scanner could not scan
	isUnit: boolean; // the file is a source file of a compile database
	scanned: boolean; // the request scanned all source files
	scanMs: number; // the time of the last scan
	ms: number;
}

// The data of dataflow/logic. Block ids are indexes in blocks. engine/README.md describes the fields.
export type DecisionKind = 'if' | 'loop' | 'do' | 'switch' | 'ternary';

export interface LogicBranch {
	label: string;
	succ: number; // the index in the successors of the decision block
	first?: number; // the lines of the branch statement
	last?: number;
}

export interface LogicDecision {
	kind: DecisionKind;
	block: number;
	condBlocks: number[]; // the blocks of && and || in the condition
	text: string;
	line: number;
	col: number;
	branches: LogicBranch[];
	parent: number; // -1 for a decision at the top level
	parentBranch?: string;
}

export interface LogicMark {
	block: number;
	line: number;
	col: number;
	len: number;
}

export interface LogicModel {
	function: EngineFunction;
	entry: number;
	exit: number;
	blocks: { succs: number[]; lines: [number, number][] }[]; // -1 for an edge that the CFG marks as unreachable
	decisions: LogicDecision[];
	chains: { subject: string; items: { decision: number; value: string }[]; hasElse: boolean }[];
	events: (LogicMark & { function: string; label: string })[];
	nullable: { var: string; source: string; at: LogicMark; derefs: LogicMark[]; checks: { block: number; succ: number }[] }[];
	returns?: (LogicMark & { value: string })[]; // the mark is the keyword. An engine before phase S3 sends no returns
	// the changes of data that lives after the call: data members, globals, the objects of reference and pointer
	// parameters, and the variables that a lambda captures by reference. The mark is the changed expression
	effects?: (LogicMark & { target: string; action: string; kind: 'member' | 'global' | 'parameter' | 'capture' })[];
	lambda?: number; // a lambda in a function: its index in the function, from 0. Then enclosing is the function
	enclosing?: EngineFunction;
}

export interface LogicOptions {
	eventFunctions: string[];
	nullableFunctions: string[];
	checkFunctions?: string[]; // a call with a nullable variable is a null check, for example is_valid(p)
}

// The innermost lambda at a position, in the function at the position
export interface LambdaAt {
	index: number; // from 0, in the sequence of the source
	range: { begin: { line: number; col: number }; end: { line: number; col: number } };
}

// The data of dataflow/structure: the statements of a function and the accesses in its body. The logical blocks of a
// model use them. engine/README.md describes the fields. Lines start at 1.
export type StructureKind = 'decl' | 'expr' | 'if' | 'for' | 'while' | 'do' | 'switch' | 'block' | 'return' | 'break' | 'continue'
	| 'throw' | 'try' | 'other';

export interface StructureStatement {
	first: number;
	last: number;
	kind: StructureKind;
	text: string; // the condition of an if, a loop or a switch, else the first line of the statement
	branches?: StructureBranch[]; // the branches of an if chain, of a switch, or of a try and its handlers
	body?: StructureStatement[]; // the statements of a block, a loop or a try
	// the items of the statement, also the items of the statements in it
	exits: { line: number; kind: 'return' | 'break' | 'continue' | 'throw' | 'goto' }[];
	events: { line: number; name: string }[];
	threads: { line: number; via: string; runs: string }[];
	calls: { line: number; name: string }[];
}

export interface StructureBranch {
	first: number;
	last: number;
	label: string; // the condition, "else", or the case label
	statements: StructureStatement[];
}

export type StructureRole = 'read' | 'write' | 'readwrite' | 'decl';

export interface StructureAccess {
	line: number;
	col: number; // UTF-8 bytes
	path: string; // for example charge.is_dirty. A member of this has no "this.". An element in the middle is [], as in optimizers[].kw
	role: StructureRole;
	scope: 'local' | 'param' | 'member' | 'global'; // the scope of the object, also through a local reference
	object?: string; // the path through the local references, if it is not path
	inLambda?: boolean;
	// a write: the lines of the reads that it reaches over the control flow. A write of a captured variable in a lambda
	// has no lines. A path through an element gets the lines of its container
	reaches?: number[];
}

export interface StructureModel {
	function: EngineFunction;
	statements: StructureStatement[];
	accesses: StructureAccess[];
}

export interface StructureOptions {
	eventFunctions: string[];
	asyncFunctions: string[];
}

// The data of dataflow/cost: the hidden C++ of all functions of a file. engine/README.md describes the kinds.
export type CostKind = 'copy' | 'move' | 'conversion' | 'temporary' | 'shadow' | 'destructor' | 'allocation' | 'lookup' | 'state';

export interface CostItem {
	kind: CostKind;
	fn: number; // an index in functions
	line: number;
	col: number;
	len: number;
	text: string; // the short text of the chip
	detail: string; // the long text of the hover card and of the details column
	pattern: string; // the key of "Not useful": the kind and the type
	heuristic?: boolean;
	related?: { line: number; col: number; len: number }[]; // the other lookups of a group
}

export interface CostModel {
	items: CostItem[];
	functions: EngineFunction[];
}

// The data of dataflow/slice: the forward slice of a change or of a call. engine/README.md describes the fields.
export type SliceStepKind = 'seed' | 'data' | 'control' | 'member' | 'async' | 'lambda';
export type SliceConfidence = 'exact' | 'call' | 'estimated';
export type SliceExitKind = 'return' | 'member' | 'global' | 'reference' | 'argument' | 'capture' | 'async' | 'call';

export interface SliceStep {
	line: number;
	col: number;
	len: number;
	lines: number[]; // the lines of the statement, without the lines in the bodies of its lambdas
	kind: SliceStepKind;
	confidence: SliceConfidence;
	distance: number; // the number of dependences from the seed
	from: number; // the step of the same body that this step depends on, or -1
	via: string;
	text: string;
}

export interface SliceExit {
	kind: SliceExitKind;
	line: number;
	col: number;
	len: number;
	text: string;
	step: number;
	followed: boolean;
}

export interface SliceBody {
	function: EngineFunction; // for a lambda, the function around it
	lambda?: EnginePosition;
	seedLines: number[];
	steps: SliceStep[];
	exits: SliceExit[];
	callers?: { line: number; col: number; function: string }[]; // the callers in the same file
}

export interface SliceModel {
	bodies: SliceBody[];
	outside: number[]; // changed lines outside of all functions
	quiet: number[]; // changed lines with no statement, for example a comment
	callFound: boolean;
}

// The changed lines of a file and its deleted blocks, or a call whose value changes
export type SliceSeed = { lines: number[]; deleted: { line: number; text: string }[] } | { call: EnginePosition };

// A function by its qualified name, or by a position in it. With a name, a line selects the overload that contains the
// line or that starts nearest to it
// A function by its name, with a line for an overload and the index of a lambda in it, or by a position. A position in a
// lambda selects the lambda for Logic Map
export type FunctionSelector = { function: string; line?: number; lambda?: number } | { line: number; col: number };

// The options of dataflow/flow
export interface FlowOptions {
	readFunctions?: string[]; // functions that only read their arguments and their object
}

export interface FileResult {
	file: string;
	parsed: boolean;
	parseMs: number;
	parseCount: number;
	errorCount: number;
	errors: string[];
	analysisMs: number;
}

// The data of dataflow/tokens. Each token is 4 numbers: the column and the length in UTF-8 bytes, the kind and the
// modifier bits. The legend gives the names of the kinds and of the bits. side/model.ts converts the tokens.
export interface TokenLegend {
	kinds: string[];
	modifiers: string[];
}

export interface TokenLine {
	line: number;
	text: string;
	tokens: number[];
}

export interface TokensResult {
	lineCount: number;
	version: number; // the version of the text that the engine parsed. -1 is the file on disk
	cached: boolean;
	legend: TokenLegend;
	lines: TokenLine[];
}

export interface InitializeResult {
	name: string;
	version: string;
	clang: string;
	databases: { path: string; files?: number; error?: string }[];
	threads: number;
	cacheSize: number;
}

export interface EngineStatus {
	file: string;
	state: 'parsing' | 'ready' | 'failed';
	parseMs?: number;
}

export type EngineState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface EngineOptions {
	enginePath: string;
	compileCommands: string[];
	maxThreads?: number;
	cacheSize?: number;
	log: vscode.LogOutputChannel;
}

const MAX_RESTARTS = 3;

export class EngineClient implements vscode.Disposable {
	private rpc?: RpcConnection;
	private state: EngineState = 'stopped';
	private restarts = 0;
	private isStopping = false;
	private initializeResult?: InitializeResult;
	// The text of the open files. After a restart, the client sends them again.
	private readonly openFiles = new Map<string, { text: string; version: number }>();

	private readonly stateEmitter = new vscode.EventEmitter<EngineState>();
	readonly onDidChangeState = this.stateEmitter.event;
	private readonly statusEmitter = new vscode.EventEmitter<EngineStatus>();
	readonly onStatus = this.statusEmitter.event;

	constructor(private readonly options: EngineOptions) {}

	get currentState(): EngineState {
		return this.state;
	}

	get info(): InitializeResult | undefined {
		return this.initializeResult;
	}

	async start(): Promise<InitializeResult> {
		this.setState('starting');
		const { log } = this.options;
		const proc = spawn(this.options.enginePath, [], { stdio: 'pipe', windowsHide: true });
		proc.stderr.on('data', (data: Buffer) => log.warn(`engine: ${data.toString().trimEnd()}`));
		proc.on('error', (error) => log.error(`The engine did not start: ${error.message}`));
		proc.on('exit', (code) => this.onExit(code));

		this.rpc = new RpcConnection(proc);
		this.rpc.onNotification((n) => {
			if (n.method === 'dataflow/status') {
				this.statusEmitter.fire(n.params as EngineStatus);
			}
		});

		try {
			const result = await this.rpc.request<InitializeResult>('initialize', {
				compileCommands: this.options.compileCommands,
				maxThreads: this.options.maxThreads,
				cacheSize: this.options.cacheSize,
			});
			this.initializeResult = result;
			for (const db of result.databases) {
				if (db.error) {
					log.error(`Compile database ${db.path}: ${db.error}`);
				} else {
					log.info(`Compile database ${db.path}: ${db.files} files`);
				}
			}
			log.info(`${result.name} ${result.version}, ${result.clang}, ${result.threads} threads`);
			for (const [file, doc] of this.openFiles) {
				this.rpc.notify('textDocument/didOpen', { file, text: doc.text, version: doc.version });
			}
			this.setState('ready');
			return result;
		} catch (error) {
			this.setState('failed');
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.isStopping = true;
		const rpc = this.rpc;
		this.rpc = undefined;
		if (rpc && this.state === 'ready') {
			// Give the engine 2 s for a clean stop. The exit handler kills the process if necessary.
			await Promise.race([rpc.request('shutdown', null), new Promise((resolve) => setTimeout(resolve, 2000))]).catch(() => undefined);
			rpc.notify('exit', null);
		}
		rpc?.dispose();
		this.setState('stopped');
	}

	functions(file: string, token?: vscode.CancellationToken): Promise<FileResult & { functions: EngineFunction[] }> {
		return this.request('dataflow/functions', { file }, token);
	}

	functionAt(file: string, line: number, col: number, token?: vscode.CancellationToken): Promise<FileResult & { function: EngineFunction | null; lambda?: LambdaAt }> {
		return this.request('dataflow/functionAt', { file, line, col }, token);
	}

	flow(file: string, fn: FunctionSelector, options: FlowOptions, token?: vscode.CancellationToken): Promise<FileResult & FlowModel & { cached?: boolean }> {
		return this.request('dataflow/flow', { file, ...fn, ...options }, token);
	}

	// The trace of a data member, a static data member or a global variable. The result is undefined if no member is at
	// the position.
	async member(file: string, at: MemberSelector, options: MemberOptions, token?: vscode.CancellationToken): Promise<(FileResult & MemberModel) | undefined> {
		const result = await this.request<FileResult & { member: MemberInfo | null }>('dataflow/member', { file, ...at, ...options }, token);
		return result.member ? result as FileResult & MemberModel : undefined;
	}

	logic(file: string, fn: FunctionSelector, options: LogicOptions, token?: vscode.CancellationToken): Promise<FileResult & LogicModel> {
		return this.request('dataflow/logic', { file, ...fn, ...options }, token);
	}

	// The statements of the function and the accesses in its body, for the logical blocks of a model
	structure(file: string, fn: FunctionSelector, options: StructureOptions, token?: vscode.CancellationToken): Promise<FileResult & StructureModel> {
		return this.request('dataflow/structure', { file, ...fn, ...options }, token);
	}

	// The hidden C++ of the file. With a unit, the engine parses the unit, a source file that includes the header file.
	// Thus the templates of the header get the items of their instantiations in the unit
	cost(file: string, minCopyBytes: number, token?: vscode.CancellationToken, unit?: string): Promise<FileResult & CostModel> {
		return this.request('dataflow/cost', { file, minCopyBytes, ...(unit ? { unit } : {}) }, token);
	}

	// The call graph of the functions of the file
	calls(file: string, options: CallOptions, token?: vscode.CancellationToken): Promise<FileResult & CallGraphModel> {
		return this.request('dataflow/calls', { file, ...options }, token);
	}

	// The threads of the file, the data that they share, and the protection of each access
	threads(file: string, options: ThreadsOptions, token?: vscode.CancellationToken): Promise<FileResult & ThreadsModel> {
		return this.request('dataflow/threads', { file, ...options }, token);
	}

	// The include hierarchy of the translation unit of the file. A file in the roots is a project header.
	includes(file: string, roots: string[], token?: vscode.CancellationToken): Promise<FileResult & IncludeModel> {
		return this.request('dataflow/includes', { file, roots }, token);
	}

	// The first request scans all source files of the compile databases. roots: the project folders, for the check
	// of the files that changed on disk
	includers(file: string, roots: string[], token?: vscode.CancellationToken): Promise<IncludersResult> {
		return this.request('dataflow/includers', { file, roots }, token);
	}

	slice(file: string, seed: SliceSeed, asyncFunctions: string[], confidence: SliceConfidence,
		token?: vscode.CancellationToken): Promise<FileResult & SliceModel> {
		return this.request('dataflow/slice', { file, ...seed, asyncFunctions, confidence }, token);
	}

	// The lines first to last, with their text and their tokens. With isLevelPerType, the level of a bracket counts only
	// the brackets of its type
	tokens(file: string, first: number, last: number, isLevelPerType = false, token?: vscode.CancellationToken): Promise<FileResult & TokensResult> {
		return this.request('dataflow/tokens', { file, first, last, bracketLevelPerType: isLevelPerType }, token);
	}

	// The ranges of lines that a condition of the preprocessor skips, for example in #if 0. Each range is [first, last]
	inactive(file: string, token?: vscode.CancellationToken): Promise<FileResult & { ranges: [number, number][] }> {
		return this.request('dataflow/inactive', { file }, token);
	}

	didOpen(file: string, text: string, version: number): void {
		this.openFiles.set(file, { text, version });
		this.rpc?.notify('textDocument/didOpen', { file, text, version });
	}

	didChange(file: string, text: string, version: number): void {
		this.openFiles.set(file, { text, version });
		this.rpc?.notify('textDocument/didChange', { file, text, version });
	}

	didClose(file: string): void {
		this.openFiles.delete(file);
		this.rpc?.notify('textDocument/didClose', { file });
	}

	// The source file that includes a file, and the line of the #include. The engine then parses the file after the lines
	// of the source file before the #include. With no unit, the file has no context. Each change makes a new parse
	setContext(file: string, unit?: string, line?: number): void {
		this.rpc?.notify('dataflow/context', unit && line ? { file, unit, line } : { file });
	}

	dispose(): void {
		void this.stop();
		this.stateEmitter.dispose();
		this.statusEmitter.dispose();
	}

	private request<T>(method: string, params: unknown, token?: vscode.CancellationToken): Promise<T> {
		if (!this.rpc || this.state !== 'ready') {
			return Promise.reject(new Error('The engine is not ready.'));
		}
		return this.rpc.request<T>(method, params, token);
	}

	private onExit(code: number | null): void {
		const wasReady = this.state === 'ready';
		this.rpc?.dispose();
		this.rpc = undefined;
		if (this.isStopping) {
			return;
		}
		this.options.log.error(`The engine stopped with exit code ${code}.`);
		this.setState('failed');
		if (wasReady && this.restarts < MAX_RESTARTS) {
			this.restarts++;
			this.options.log.info(`Restart ${this.restarts} of ${MAX_RESTARTS}.`);
			this.start().catch((error) => this.options.log.error(`The restart failed: ${error}`));
		}
	}

	private setState(state: EngineState): void {
		this.state = state;
		this.stateEmitter.fire(state);
	}
}
