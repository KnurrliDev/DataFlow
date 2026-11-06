// The messages between the extension and the side view. The webview script imports only these types.
// docs/side-view-strategy.md describes the side view.

// A line of the file: the text, and the token spans as groups of 3 numbers. The numbers are the start and the end
// in UTF-16 code units from 0, and the style index. Lines start at 1.
export interface SideRow {
	line: number;
	text: string;
	spans: number[];
}

// The style of a style index. Without a color, the span has the color of the editor text.
export interface SideStyle {
	color?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
}

// The settings of the text editor that the code view copies. The webview gets the font family, the size and the
// weight from the CSS variables of VS Code.
export interface SideSettings {
	rowHeight: number; // in px
	tabSize: number;
	indentSize: number;
	ligatures: string; // the value of font-feature-settings
	letterSpacing: number; // in px
	guides: boolean; // the indent guides
	activeGuide: boolean; // a highlight on the indent guide of the block of the cursor
	bracketColors: boolean; // the colors of the bracket pairs
	// the key for "go to definition" with the mouse, as in the text editor: Ctrl (Cmd on macOS), or Alt if
	// editor.multiCursorModifier is ctrlCmd
	gotoKey: 'ctrl' | 'meta' | 'alt';
}

// The style indices of the brackets: first + level for the levels of nesting from 0 to levels - 1, and first + levels
// for a closing bracket without an opening bracket. Without bracket colors, a bracket has the punctuation style.
export interface SideBrackets {
	first: number;
	levels: number;
	punctuation: number;
}

export type SideEngineState = 'stopped' | 'starting' | 'ready' | 'failed';

export type SideLens = 'flow' | 'logic' | 'cost' | 'review' | 'includes' | 'calls' | 'threads';

// The toolbar and the status line
export interface SideFrame {
	file?: string;
	fn?: string; // the function at the cursor
	engine: SideEngineState;
	parsing: boolean;
	parseMs?: number;
	errorCount?: number;
	errors?: string[];
	databases: string[];
	project?: string; // the name of a project that is not open in VS Code
	message?: string;
	lenses: Record<SideLens, boolean>;
	lastLens?: SideLens; // the lens that turned on last, for example the lens that opened the side view
	fnRange?: [number, number]; // the lines of the function at the cursor, fn
	isModelShown: boolean; // the layers of a model show in the code view
	animate: boolean; // the setting dataflow.animations and workbench.reduceMotion
	mode: 'file' | 'story'; // the side view shows the file, or the story of the review
	mcp: SideMcp;
}

export type SideFlowRole = 'def' | 'write' | 'mayWrite' | 'check' | 'read';
export type SideFlowColor = 'definition' | 'read' | 'write' | 'check' | 'problem';

// A reference of the traced variable. Lines start at 1. Columns are UTF-16 code units from 0.
export interface SideFlowMark {
	line: number;
	start: number;
	end: number;
	role: SideFlowRole;
	finding?: string; // the text of the finding
	from: number[]; // the marks of the definitions and writes whose value gets to this reference
	to: number[]; // the marks of the uses that this definition or write gets to
}

// A rail: a definition or a write, and the uses that it gets to. Slot 0 is the column next to the code.
export interface SideFlowLane {
	slot: number;
	from: number;
	to: number;
	color: SideFlowColor;
	segments: { from: number; to: number; isProblem: boolean }[];
	nodes: { line: number; color: SideFlowColor; isDef: boolean; isHollow: boolean }[];
}

// Flow Lens for one variable
export interface SideFlow {
	file: string;
	fn: string; // the qualified name of the function
	name: string;
	type: string;
	storage: string;
	declLine: number;
	marks: SideFlowMark[];
	lanes: SideFlowLane[];
	slots: number; // the number of rail columns
	findings: { line: number; text: string }[];
	counts: Record<SideFlowRole, number>;
	variables: { index: number; name: string; type: string; declLine: number; isCurrent: boolean }[];
	pulse: number; // a new value makes the rails pulse. 0 means no pulse
	isSelected: boolean; // the cursor or a click selected the variable. Only then the lines with no reference are dimmed
	hasCfg: boolean; // false if the engine has no control flow graph for the function. Then there are no rails
	tags?: SideFlowTag[]; // the tags at the end of the lines. A click opens a different place
	member?: SideMember; // the trace of a data member of a class. Then the variables are the data members of the class
}

// A tag at the end of a line, for example the class, the file and the line of the declaration of a member. A click opens
// the file at the target line. Lines start at 1.
export interface SideFlowTag {
	line: number;
	text: string;
	title: string;
	file: string;
	target: number;
	col: number; // the column in the target line, from 0. The engine counts UTF-8 bytes, so a line with other characters before it gets a column near it
	kind: 'decl' | 'file';
}

// A data member of a class: its class, its declaration, its accesses in the files of the trace, and the race check.
// Lines start at 1.
export interface SideMember {
	className: string; // empty for a global variable
	qualifiedClass: string; // the class, or the namespace of a global variable
	label: string; // for example WorkerPool::jobs_
	storage: string; // for example "private member of WorkerPool" or "global variable in demo"
	access: string;
	isAtomic: boolean;
	init?: string;
	decl: { file: string; name: string; line: number }; // name: the name of the file
	files: SideMemberFile[]; // the files of the trace, then the other source files of the class
	search: 'searching' | 'done'; // the search for the other source files of the class
	groups: SideMemberGroup[]; // the accesses in each file. The file of the declaration comes first
	summary: { files: number; functions: number; threads: string; locks: string };
	verdict?: { kind: 'race' | 'safe'; text: string; places: { file: string; name: string; line: number }[] };
}

// A file of the trace of a member, or a different source file of the class. trace: the trace has accesses in the file.
// found: a source file with "Class::" that the user can parse. empty: the parse found no access
export interface SideMemberFile {
	file: string;
	name: string;
	state: 'trace' | 'found' | 'parsing' | 'empty' | 'failed';
	count: number; // the accesses in the trace, or the mentions of the member in a found file
	isShown: boolean; // the side view shows this file
	first?: { line: number; col: number }; // the first access in the file. col is from 0
	error?: string;
}

export interface SideMemberGroup {
	file: string;
	name: string;
	isShown: boolean; // the side view shows this file
	refs: SideMemberRef[];
}

export interface SideMemberRef {
	line: number;
	col: number; // from 0, as the column of a tag
	role: SideFlowRole;
	fn: string; // for example "destroy()" or "WorkerPool(), lambda"
	isDecl: boolean;
	thread?: string; // the start of the thread, for example std::thread
	threadTitle?: string;
	locks: string[];
	object?: string; // the object if it is not this
	isWhole?: boolean; // a change of the whole object, for example an assignment of the object. It can change the member
}

// A step of the path of Logic Map: a decision with its option, an event, a pointer that can be null, a return, or the
// end of the function. Lines start at 1.
export interface SideStep {
	kind: 'decision' | 'event' | 'warning' | 'effect' | 'return' | 'end';
	line: number;
	text: string; // the condition, the label of an event, the text of a warning, the changed data, or the returned value
	key?: string; // a decision: the key of its control
	value?: string; // a decision: the option of the path
	options?: string[]; // a decision: the options of its control
	isSet?: boolean; // a decision: the user selected the option. Else the option is the default
	problem?: string; // an event: the text of the warning for a second event on the path
	// an effect: the changes with no other step between them. action is "=", "+=", "++", or the name of the called member
	// function. kind is the kind of the changed data
	changes?: { line: number; target: string; action: string; kind: 'member' | 'global' | 'parameter' | 'capture' }[];
}

// A mark of Logic Map on an expression. Lines start at 1. Columns are UTF-16 code units from 0.
export interface SideLogicMark {
	line: number;
	start: number;
	end: number;
}

// Why a line runs: the choices that the line needs. No items if no block of the function contains the line.
export interface SideWhy {
	line: number;
	items?: { key: string; text: string; option: string; options?: string[] }[]; // options: a switch with fallthrough, one of them
}

// Logic Map for one function: one path through the function. Each decision has an option: the choice of the user, or
// the default option, which runs the most lines. Lines start at 1.
export interface SideLogic {
	file: string;
	fn: string; // the qualified name of the function
	first: number; // the first line and the last line of the function
	last: number;
	steps: SideStep[]; // the steps of the path, in the sequence of the source
	dead: number[]; // the lines that the path cannot reach
	events: (SideLogicMark & { label: string })[]; // the events on the path
	problems: SideLogicMark[]; // the dereferences that can get a null pointer
	hints: { line: number; text: string }[]; // the texts of the warnings for the ends of the lines
	warnings: { line: number; text: string; short: string }[];
	why?: SideWhy; // why the line of the cursor runs
	hasChoices: boolean; // the user selected an option. Reset removes the choices of the user
	hasCfg: boolean; // false if the engine has no control flow graph for the function. Then there is no path
}

// A range on one line. Lines start at 1. Columns are UTF-16 code units from 0.
export interface SideRange {
	line: number;
	start: number;
	end: number;
}

// An item of Hidden C++: an operation that the compiler adds, with the range of its code
export interface SideCostMark extends SideRange {
	category: string; // copy, move, conversion, lifetime, destructor, allocation, lookup or state
	text: string; // the short text
	detail: string; // the long text
	pattern: string; // the key of "Not useful"
	heuristic: boolean;
	related: SideRange[]; // the other lookups of a group
}

// Hidden C++ for the file
export interface SideCost {
	file: string;
	marks: SideCostMark[]; // the items of the file that show, in the sequence of the source
	categories: { id: string; label: string; count: number; enabled: boolean; heuristic: boolean }[]; // the counts of the file
	fn?: string; // the function at the cursor
	items: { line: number; category: string; text: string; detail: string; pattern: string; heuristic: boolean }[]; // its items
	hidden: number; // the patterns that the user marked as not useful
}

// The call graph of the file of the side view: the functions, the links between them with the data of the calls, the
// function at the cursor, and the hints on its calls. Lines start at 1. Columns are UTF-16 code units from 0.
export interface SideCalls {
	file: string;
	functions: SideCallFunction[];
	edges: SideCallEdge[];
	focus: number; // the function at the cursor, or -1
	hints: { line: number; text: string; kind: SideCallKind; title: string; to: number }[]; // the calls of the function at the cursor
	notice?: string; // for example: the call hierarchy of VS Code failed, so the callers in other files do not show
}

// async: a call on a different thread. event: a call of an event function. warn: a std::optional result with no check.
// check: a checked std::optional result. write: the call writes an argument. data: the caller uses the result. call: all
// other calls. other: a caller in a different file, from the call hierarchy of VS Code
export type SideCallKind = 'async' | 'event' | 'warn' | 'check' | 'write' | 'data' | 'call' | 'other';

export interface SideCallFunction {
	id: number;
	label: string; // for example process(), WorkerPool::post() or lambda (line 12)
	qualifiedName: string;
	where: 'main' | 'project' | 'library' | 'other';
	file: string;
	line: number;
	col: number;
	isDefined: boolean;
}

export interface SideCallEdge {
	from: number;
	to: number;
	kind: SideCallKind;
	short: string; // for example "writes charge ×2"
	long: string;
	file: string; // the file of the calls: the file of the caller
	sites: { line: number; col: number }[];
	isVirtual?: boolean; // each call is a virtual call that can run this override
}

// The calls of a function, for the list of "Show Calls": the calls in the file of the side view from the call graph of
// the engine, then the calls in other files from the call hierarchy of VS Code. Lines from 1, UTF-16 columns from 0
export interface SideCallList {
	seq: number; // each command makes a new list
	// definitions: the list of the definitions of a name after Ctrl+click, if there is more than one. A click on one moves
	// only the side view. Else the list of "Show Calls"
	kind?: 'definitions';
	fn: string; // the function, for example fire_transition(), or the name of the definitions
	sites: SideCallListSite[];
	isSearching: boolean; // the calls in other files did not come yet
	note?: string; // for example why the list has only the calls in this file
	isFromMenu: boolean; // the menu of the side view opened the list, so the list shows near the place of the click
}

// The outline of a class, a struct, a union or an enum, from the request dataflow/outline of the engine. Lines and
// columns start at 1. Columns are UTF-8 bytes, as the engine gives them
export interface SideOutlinePlace {
	file: string;
	line: number;
	col: number;
}

export interface SideOutlineMember extends SideOutlinePlace {
	kind: 'field' | 'method' | 'constructor' | 'destructor' | 'operator' | 'conversion' | 'type' | 'enumerator' | 'friend' | 'using' | 'property';
	name: string;
	text: string; // the type of a data member, the signature of a function, the value of an enumerator
	access: string; // public, protected or private. Empty for an enumerator
	marks?: string[]; // for example static, virtual, override, pure, const, noexcept or = delete
	section?: string; // signals or slots of Qt
	annotation?: string; // for example UPROPERTY(EditAnywhere) of Unreal Engine
	macro?: string; // the macro that makes the member, for example GENERATED_BODY
	definition?: SideOutlinePlace; // a function with its definition in a different place of the translation unit
	offset?: number; // a data member of a type with a layout, in bytes
	size?: number;
}

export interface SideOutlineData extends SideOutlinePlace {
	name: string;
	qualifiedName: string;
	kind: string; // class, struct, union, enum or enum class
	template: string; // for example template <class T>
	underlying: string; // the underlying type of an enum with a fixed type
	isFinal: boolean;
	isAbstract: boolean;
	isLibrary: boolean; // the type is in a system header
	isTruncated: boolean; // the bases have more members than the outline shows
	bases: { name: string; access: string; isVirtual: boolean; place?: SideOutlinePlace; offset?: number; size?: number }[];
	members: SideOutlineMember[];
	inherited: { base: string; members: SideOutlineMember[] }[];
	layout: { size: number; align: number; padding: number; hasVPtr: boolean; holes: { offset: number; size: number }[] } | null;
}

// The panel of the menu "Outline"
export interface SideOutline extends SideOutlineData {
	seq: number; // each command makes a new panel
	isFromMenu: boolean; // the menu of the side view opened the panel, so the panel shows near the place of the click
}

export interface SideCallListSite {
	file: string;
	line: number;
	col: number;
	caller: string; // for example process()
	kind: SideCallKind;
	text: string; // the code of the line, with no white space at its ends
}

// The include hierarchy of the file of the side view: the tree of the includes, the lines that each include adds,
// the groups of the lines, and the hints on the include lines of the file. Lines start at 1.
export interface SideIncludes {
	file: string;
	name: string; // the name of the file
	// forward: the includes that forward declarations can replace
	stats: { lines: number; total: number; includes: number; skipped: number; unused: number; missing: number; forward: number };
	groups: { name: string; lines: number; color: SideIncludeColor }[]; // the most lines first
	nodes: SideIncludeNode[]; // nodes[0] is the file. A parent comes before its children
	hints: { line: number; text: string; kind: 'cost' | 'large' | 'skipped' | 'unused' | 'missing' | 'forward'; node: number }[];
}

// The forward declaration check of an include of the file: forward declarations can replace it, or the first use that
// needs it. text has one line for each namespace. lines: the lines of the file that use the type
export type SideIncludeForward =
	| { state: 'possible'; text: string; types: { name: string; lines: number[] }[] }
	| { state: 'needed'; blocker: { name: string; kind: string; line: number } };

export type SideIncludeColor = 'path' | 'read' | 'muted' | 'check' | 'definition' | 'write' | 'ripple' | 'problem';

// Included by in the compile databases: the source files that include a file. The first request scans all source files
export interface SideIncluders {
	file: string; // the header
	state: 'scanning' | 'ready' | 'failed';
	units: { file: string; name: string }[]; // name: the path in the project folder, sorted
	unitCount: number; // all source files of the compile databases
	failed: number; // the source files that the scan could not read
	isUnit: boolean; // the file is a source file of a compile database
	error?: string;
}

export interface SideIncludeNode {
	id: number;
	parent: number; // -1 for the file
	depth: number;
	children: number[];
	name: string; // as the directive writes it, for example <vector> or battery/types.hpp
	path: string; // the file, or '' if the preprocessor did not find it
	line: number; // the line of the directive in the file of the parent. 0 for the file and a forced include
	parentPath: string; // the file of the directive
	group: string;
	color: SideIncludeColor;
	state: 'main' | 'entered' | 'skipped' | 'missing';
	own: number; // the lines of the file, 0 if the node did not enter it
	total: number; // the lines of the file and of the includes under it, each file one time
	isForced: boolean; // an include of the command line, for example -include
	isOwn: boolean; // the header of the file, for example a.h for a.cpp
	isUsed?: boolean; // an include of the file: the file uses a name of the header. Undefined if the check does not apply
	use?: { name: string; line: number; node?: number }; // node: the node of the file of the name
	first?: number; // a skipped node: the node that entered the file before
	forward?: SideIncludeForward; // a used include of the file. Undefined if the check does not apply
}

// Threads and races in the side view: the threads of the file, the shared data with a verdict for each item, the code
// that runs on a worker thread, and the tags on the starts and the joins. Lines start at 1. Columns are UTF-16 code units
// from 0.
export interface SideThreads {
	file: string;
	threads: SideThread[];
	items: SideThreadItem[]; // the races first, then the items to check, then the safe items
	lanes: { first: number; last: number; threads: number[]; isCaller: boolean }[]; // the code of the file on a worker thread
	tags: { line: number; text: string; title: string; kind: 'start' | 'join'; thread: number }[];
	counts: Record<SideThreadVerdict, number>;
	isTruncated: boolean; // the analysis stopped at a limit
}

export interface SideThread {
	index: number;
	label: string; // for example "lambda on line 95" or "Worker::run()"
	via: string; // for example std::thread or tf::Executor::async
	file: string;
	line: number;
	fn: string; // the function with the start
	handle: string; // the variable or the member that keeps the thread or its future
	isRepeated: boolean; // more than one thread of the start can run at the same time
	joins: { kind: string; file: string; line: number; fn: string }[];
}

export type SideThreadVerdict = 'race' | 'check' | 'safe';

export interface SideThreadItem {
	key: string;
	label: string;
	kind: 'member' | 'static' | 'global' | 'local' | 'capture';
	type: string;
	verdict: SideThreadVerdict;
	pill: string; // Race, Check, Safe, Safe now or Dangling
	caller: string; // the accesses of the caller thread, for example "reads 94 · writes 116, 129"
	worker: string; // the accesses of the worker threads
	protection: string;
	summary: string;
	thread: number; // the worker thread of the lanes, or -1
	fix?: { line: number; text: string; before: string; after: string };
	decl?: { file: string; line: number };
	marks: SideThreadMark[]; // the accesses in the file of the side view
	steps: SideThreadStep[]; // the lanes of the caller thread and of the worker thread, in sequence
}

export interface SideThreadMark {
	line: number;
	start: number;
	end: number;
	role: SideFlowRole;
	lane: 'caller' | 'worker';
	pair?: 'race' | 'check'; // the access can run at the same time as an access of a different thread
	hint?: string; // the text after the code of an access of a pair
}

export interface SideThreadAccess {
	lane: 'caller' | 'worker';
	file: string;
	line: number;
	col: number;
	fn: string; // for example solve_power_plan()
	role: SideFlowRole;
	note: string;
	isOrdered?: boolean; // in sequence with the worker thread
}

export type SideThreadStep =
	| ({ kind: 'access' } & SideThreadAccess)
	| { kind: 'sync'; dir: 'start' | 'join'; text: string; file: string; line: number }
	| { kind: 'pair'; verdict: 'race' | 'check'; text: string; caller: SideThreadAccess; worker: SideThreadAccess };

// Change Ripple in the file view: the changed lines, the lines that the changes reach, and the hints. Lines start at 1.
export interface SideRipple {
	file: string;
	lines: { line: number; isChange: boolean; isEstimated: boolean }[];
	hints: { line: number; text: string }[];
}

// A row of the diff of a change. A removed row is a line of the base. A fold hides the lines between two hunks, or the
// rows after the maximum number of rows.
export interface SideDiffRow {
	kind: 'context' | 'removed' | 'added' | 'fold';
	line: number; // the line in the working tree, or in the base for a removed row
	at: number; // the line in the working tree at the position of the row
	text: string;
	spans: number[];
	changed?: [number, number]; // a removed row or an added row of a pair: the UTF-16 columns of the changed characters
	count?: number; // a fold: the number of lines
}

// A row of a card of the story: a line that the ripple reaches, a line of context, or a fold for a gap
export interface SideCardRow {
	line: number;
	text: string;
	spans: number[];
	fold?: number; // the number of lines of the gap. A fold has no text
	wave: number; // the step of the wave that gets to the line. -1 for a line of context or a fold
	kind?: string; // the kind of the step: seed, data, control, member, async or lambda
	isEstimated?: boolean;
	isChange?: boolean;
	changed?: [number, number]; // the UTF-16 columns of the changed characters of a changed line
	note?: string; // the text at the end of the row. A row with the same note as the row before it has no note
	why?: string; // the full note, for the title of the row
}

// A card of the story: one function or one lambda of the ripple. The link is the arrow from the card before.
export interface SideCard {
	file: string;
	name: string; // the name of the file
	label: string; // for example "solve_power_plan()" or "lambda in process()"
	line: number; // the first line of the function or of the lambda
	depth: number; // 0 for the changed function, 1 for a caller, 2 for a caller of a caller
	rows: SideCardRow[];
	exits: { line: number; kind: string; text: string }[]; // the points where the ripple leaves the card
	link?: { kind: 'return' | 'async' | 'lambda' | 'next'; text: string };
	isChange: boolean; // the card contains changed lines
	isEstimated: boolean; // all steps of the card are estimated
	wave: number; // the first step of the wave in the card
}

// The story of one changed function: the diff, the facts and the chain of cards
export interface SideStoryChange {
	file: string;
	name: string;
	label: string;
	line: number;
	diff: SideDiffRow[];
	stats: string[];
	cards: SideCard[];
	waves: number; // the number of steps of the wave
}

// The story of a review of Change Ripple
export interface SideStory {
	base?: string; // for example "main (merge base 1a2b3c4)"
	target?: string; // the target branch, for example origin/dev
	isRunning: boolean;
	message?: string; // an error, or a review with no changes
	notice?: string; // for example: no call hierarchy provider
	changes: SideStoryChange[];
	other: { file: string; name: string; text: string }[]; // changed lines with no statement
	seq: number; // the number of the review. A new review plays the wave again
}

// The layers of a language model in a file: the logical blocks of a function and the notes on lines. The model sends them
// through the MCP server of DataFlow. The titles, the summaries and the notes come from the model. The lines and the data
// of each block come from the engine. Lines start at 1.
export interface SideModel {
	file: string;
	fn?: string; // the function of the last call of show_blocks. In a layer of an older version, the function of all blocks
	client?: string; // the name of the MCP client, for example claude-code
	blocks: SideModelBlock[]; // in the sequence of the lines, each block before its children
	notes: SideModelNote[];
	comments: SideModelComment[]; // in the sequence of the lines, one comment on a line at most
	details: SideModelDetail[]; // in the sequence of the code
}

export interface SideModelBlock {
	id: string; // 1, 2, ... for the blocks of the function, 5a, 5b, ... for the children of block 5, then 5a1, 5a1a, ...
	fn: string; // the function of the block, for example electricity::power_ctrl::process. Each function has its own ids
	level: number; // 0 for a block of the function, 1 for a child, 2 for a child of a child, and so on
	parent?: string;
	first: number;
	last: number;
	title: string;
	summary: string;
	ins: string[]; // read in the block and set before it
	outs: string[]; // written in the block and used after it, or visible to the caller
	extra: SideModelExtra[];
	from?: [number, number]; // the lines of the model, if DataFlow moved them to whole statements
}

export interface SideModelExtra {
	kind: 'exit' | 'thread' | 'event' | 'call';
	line: number;
	text: string; // for example return, tf::Executor::async runs solve_power_plan, _planned, compute_and_store_schedule
}

export type SideNoteKind = 'problem' | 'warning' | 'info';

export interface SideModelNote {
	first: number;
	last: number;
	kind: SideNoteKind;
	text: string;
	block?: string; // the id of the block of the note
	blockFn?: string; // the function of that block
}

// The colors that a model can select for a comment. They are the chart colors of the theme. With no color, a comment
// has the color dataflow.modelComment
export type SideCommentColor = 'blue' | 'green' | 'purple' | 'yellow' | 'orange' | 'red' | 'gray';

// A comment of a model on one line. It shows after the code, and it does not color the line
export interface SideModelComment {
	line: number;
	text: string;
	color?: SideCommentColor;
}

// A detail of a model on a part of the code: a longer explanation or examples. The first line of the code gets a symbol
// at its end, and the text shows in a card when the mouse is on the symbol. Lines from 1, UTF-16 columns from 0. endCol
// is after the last character
export interface SideModelDetail {
	id: string; // d1, d2, ...
	line: number;
	col: number;
	endLine: number;
	endCol: number;
	code: string; // the code, so the side view finds it again after an edit of its line
	title: string;
	text: string; // a small part of Markdown, see side/details.ts
}

// The MCP server of DataFlow in the status line and in the details column
export interface SideMcp {
	state: 'off' | 'on' | 'failed';
	url?: string;
	client?: string; // the client that connected last
	error?: string;
}

// A guided review: the plan of a language model to review the changes of a branch, one step after the other. The model
// sends the plan through the MCP server. The user goes from step to step in the side view, or asks the model. Lines
// start at 1.
export interface SideGuide {
	title: string;
	summary?: string; // what the changes do, in the words of the model
	client?: string; // the name of the MCP client, for example claude-code
	target?: string; // the target branch of the review, for example main
	steps: SideGuideStep[];
	current: number; // the index of the step that the side view shows
	seq: number; // a new plan gets a new number
}

// The mark of the user, or of the model, on a step
export type SideGuideStatus = 'todo' | 'ok' | 'issue' | 'question';

// The kind of a step, for its chip: a changed line, code that a change reaches, code around it, a risk, or a test
export type SideGuideKind = 'change' | 'ripple' | 'context' | 'risk' | 'test';

export interface SideGuideStep {
	title: string;
	file: string;
	name: string; // the name of the file
	first: number;
	last: number;
	text: string; // what to look at and why: a small part of Markdown, see side/details.ts
	checks: string[]; // the questions that the reviewer answers in this step
	kind?: SideGuideKind;
	status: SideGuideStatus;
	note?: string; // a note of the model on the step, for example the answer to a question of the user
}

// A tab of the details column: the tab of a lens, the tab of the layers of a model, or the tab of a guided review
export type SideDetailsTab = SideLens | 'model' | 'guide';

// The card of the command "Show Card at Cursor": a reference of Flow Lens, an item of Hidden C++, or the hints at the
// end of a long line
export type SideCardKind = 'flow' | 'cost' | 'detail' | 'ends';

export type SideCommand = 'dataflow.selectCompileCommands' | 'dataflow.showLog' | 'dataflow.restartEngine' | 'dataflow.openProject'
	| 'dataflow.openProjectFile' | 'dataflow.ripple.selectTarget' | 'dataflow.mcp.start' | 'dataflow.mcp.copySetup' | 'dataflow.toggleModelLayers';

export type ToSide =
	// A new file. The rows have the text of the editor and no spans, until the tokens of the engine come.
	| { type: 'file'; file: string; lineCount: number; rows: SideRow[] }
	// Rows with tokens from the engine. The text of these rows is the text that the engine parsed.
	| { type: 'rows'; lineCount: number; version: number; rows: SideRow[] }
	// The ranges of lines that a condition of the preprocessor skips, for example in #if 0. Each range is [first, last]
	| { type: 'inactive'; file: string; ranges: [number, number][] }
	// traceable: the style indices of variables and parameters. A click on them traces the variable. callable: the style
	// indices of functions and methods. Their menu has "Show Calls". typeNames: the style indices of classes, enums and
	// type aliases. Their menu has "Outline". navigable: the style indices of all names. Ctrl+click on them goes to the
	// definition. includeFile: the style index of a string, for the file of an #include
	| {
		type: 'styles'; styles: SideStyle[]; brackets: SideBrackets; traceable: number[]; callable: number[]; typeNames: number[]; navigable: number[];
		includeFile: number;
	}
	| { type: 'callList'; list: SideCallList | null }
	| { type: 'outline'; outline: SideOutline | null }
	| { type: 'settings'; settings: SideSettings }
	| { type: 'scrollTo'; line: number } // the first visible line
	| { type: 'cursor'; line: number }
	| { type: 'center'; line: number } // shows the line in the middle part of the view, if it is not there
	// the command "Show Card at Cursor": the card of the item at the cursor of the editor. col is a UTF-16 column from 0
	| { type: 'showCard'; line: number; col: number }
	| { type: 'hideCard' }
	| { type: 'frame'; frame: SideFrame }
	| { type: 'flow'; flow: SideFlow | null }
	| { type: 'logic'; logic: SideLogic | null }
	| { type: 'cost'; cost: SideCost | null }
	| { type: 'includes'; includes: SideIncludes | null }
	| { type: 'includers'; includers: SideIncluders | null }
	| { type: 'calls'; calls: SideCalls | null }
	| { type: 'threads'; threads: SideThreads | null }
	| { type: 'ripple'; ripple: SideRipple | null }
	| { type: 'story'; story: SideStory | null }
	| { type: 'why'; why: SideWhy } // the answer to the action 'why'
	| { type: 'model'; model: SideModel | null }
	| { type: 'guide'; guide: SideGuide | null }
	| { type: 'details'; lens: SideDetailsTab }; // opens the details column at the tab

// The actions of the lenses. The extension does them, as for the commands of the lenses.
export type SideAction =
	| { type: 'trace'; line: number; col: number } // traces the variable at the position. col is a UTF-16 column from 0
	| { type: 'traceVariable'; index: number } // traces a variable of the function of the trace
	| { type: 'clearTrace' }
	| { type: 'toggleLens'; lens: SideLens }
	| { type: 'setChoice'; key: string; value: string } // 'any' removes the choice, so the control gets its default option
	| { type: 'resetChoices' }
	| { type: 'why'; line: number } // asks why the line runs. The answer is the message 'why'
	| { type: 'applyWhy'; line: number } // sets the choices that make the line run
	| { type: 'setCostCategory'; id: string; enabled: boolean } // shows or hides a category of Hidden C++
	| { type: 'notUseful'; pattern: string } // hides all items with this pattern in the workspace
	| { type: 'showHidden' } // shows the hidden patterns again
	| { type: 'reviewChanges' }
	| { type: 'clearReview' }
	| { type: 'openDiff'; file: string } // opens the diff editor of a file of the review
	| { type: 'showStory' }
	| { type: 'showFileView' }
	| { type: 'openPlace'; file: string; line: number; col?: number } // shows the line in the file view and in the text editor. col is a UTF-16 column from 0
	| { type: 'openDefinition'; file: string; line: number; col: number } // finds the definition of the function that the place declares, and shows it
	| { type: 'openEditor' } // opens the file of the side view in the text editor, at the cursor of the side view
	| { type: 'callFocus'; fn: number }
	| { type: 'callsShown'; isShown: boolean } // the tab Calls or the graph shows. Only then the extension asks VS Code for the callers in other files
	| { type: 'includersShown'; file: string } // the tab Included by shows a file. The extension asks the engine for the source files that include it
	| { type: 'parseMemberFile'; file: string } // adds the accesses of a different source file of the class to the member trace
	| { type: 'parseMemberFiles' } // the user put a function in the center of Call Hierarchy. The extension asks VS Code for its callers in other files
	| { type: 'clearModel' } // removes the blocks and the notes of the model in the file of the side view
	| { type: 'guideGo'; index: number } // shows a step of the guided review
	| { type: 'guideStatus'; index: number; status: SideGuideStatus } // the mark of the user on a step
	| { type: 'guideCopy' } // puts the summary of the guided review on the clipboard
	| { type: 'guideClose' }; // removes the guided review

export type FromSide =
	| { type: 'ready' }
	| { type: 'scroll'; line: number } // the user scrolled the side view. line is the first visible line
	| { type: 'select'; line: number; col?: number } // the user clicked a position. col is a UTF-16 column from 0
	| { type: 'selectRange'; line: number; col: number; endLine: number; endCol: number } // the user selected code, with UTF-16 columns from 0
	| { type: 'revealLine'; line: number } // the user clicked a line in a list, for example a finding
	| { type: 'command'; command: SideCommand }
	| { type: 'rendered'; ms: number; rows: number; inactiveRows: number } // the time of the last render of the code view
	| { type: 'shortEnds'; lines: number[]; width: number } // the visible lines with a dot for the hints at the end of the row, and the width of the code view in px
	| { type: 'card'; kind: SideCardKind | null; line: number } // the answer to showCard. null: the line has no card at the column
	// Ctrl+click on a name: the side view goes to its definition. col is a UTF-16 column from 0. isCallable: the name is a
	// function or a method, so a click on its own definition shows "Show Calls"
	| { type: 'goToDefinition'; line: number; col: number; isCallable?: boolean }
	| { type: 'goToPlace'; file: string; line: number; col: number } // a click in the list of definitions. col is a UTF-16 column from 0
	| { type: 'goBack' } // the mouse button Back: the place before the last jump of the side view
	| { type: 'goForward' }
	// a click on a member in the panel of "Outline", with a UTF-8 column from 1 as the engine gives it. toDefinition: Ctrl+click
	// on a function with no known definition, so the extension asks the definition providers
	| { type: 'outlineGo'; file: string; line: number; col: number; toDefinition?: boolean }
	| { type: 'copyForward'; text: string } // the button Copy of the forward declarations of an include
	| SideAction;

// The state that the webview keeps for the restore after a reload of the window
export interface SideViewState {
	file?: string;
	line?: number;
	isDetailsOpen?: boolean;
	detailsLens?: SideDetailsTab; // the tab of the details column
}
