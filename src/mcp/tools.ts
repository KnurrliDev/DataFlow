import {
	COMMENT_COLORS, MAX_BLOCK_LEVELS, MAX_COMMENTS, type ModelBlockInput, type ModelCommentInput, type ModelDetailInput, type ModelNoteInput,
} from '../lenses/blocks';
import { GUIDE_KINDS, GUIDE_STATUSES, GUIDE_TYPES, MAX_GUIDE_STEPS, MAX_STEP_CHECKS, type GuidePlanInput } from '../review/guide';
import { MAX_WALK_STEPS, type WalkPlanInput } from '../review/walk';
import type { McpPrompt, McpTool } from './server';

// The tools and the prompt of the MCP server of DataFlow. The read tools give the facts of the engine. The view tools
// change the side view that the user looks at. The host gives the data and changes the view, so this file only checks
// the arguments and writes the results as JSON.

// A function: its name, or a line in it. With neither, the function at the cursor
export interface FunctionArg {
	function?: string;
	line?: number;
}

export interface McpHost {
	view(): Promise<object>;
	functions(file?: string): Promise<object>;
	structure(file: string | undefined, fn: FunctionArg): Promise<object>;
	flow(file: string | undefined, line: number, name: string, show: boolean): Promise<object>;
	calls(file: string | undefined, fn: FunctionArg): Promise<object>;
	threads(file?: string): Promise<object>;
	hidden(file: string | undefined, fn: FunctionArg): Promise<object>;
	includes(file?: string): Promise<object>;
	outline(file: string | undefined, name: string | undefined, line: number | undefined): Promise<object>;
	heat(file: string | undefined, fn: string | undefined): Promise<object>;
	showBlocks(file: string | undefined, fn: FunctionArg, blocks: ModelBlockInput[]): Promise<object>;
	highlight(file: string | undefined, ranges: ModelNoteInput[], append: boolean): Promise<object>;
	comment(file: string | undefined, comments: ModelCommentInput[], append: boolean): Promise<object>;
	detail(file: string | undefined, detail: ModelDetailInput): Promise<object>;
	clear(file?: string): Promise<object>;
	review(paths: unknown): Promise<object>;
	showReviewPlan(plan: GuidePlanInput): Promise<object>;
	reviewStep(step: number, note: unknown, status: string | undefined): Promise<object>;
	diff(base: string | undefined, paths: unknown): Promise<object>;
	showDiffWalk(plan: WalkPlanInput): Promise<object>;
	closeGuide(kind: string | undefined): Promise<object>;
}

export const INSTRUCTIONS = [
	'DataFlow analyzes the C++ code that is open in VS Code with the Clang compiler, and it shows the results in its side view beside the editor.',
	'The read tools (get_*, list_functions) give facts of the engine: statements, data flow, calls, threads and races, hidden operations, includes, the outline of a type '
	+ 'and the heat of the functions: how much a change of each function can break.',
	'The view tools (show_blocks, show_flow, highlight, comment_lines, add_detail, clear) change the side view that the user looks at.',
	'Lines start at 1. If you omit "file", a tool uses the file of the active editor, or else the file of the side view. Call get_view first to see what the user looks at.',
	'If no C++ editor shows, the cursor of get_view is the cursor of the side view, where the user clicked, and the view tools move only the side view.',
	'If the user selected code and asks for details, an explanation or examples of it, call get_view for the selection, then add_detail with no line.',
	'The side view marks your titles, summaries, notes, comments and details as text of a model. The lines and the data of each block come from the engine, so use the data of the results in your answers.',
	'For a guided review of the files or the folders that the user names, call get_review with their paths, read the code with the other tools, '
	+ 'then call show_review_plan with a plan of steps, and walk the user through the plan with review_step. The prompt guided-review gives the steps.',
	'To walk the user through the changes of the working tree, of the branch or since a commit, for example the changes that you made, call get_diff, '
	+ 'read the changed code, then call show_diff_walk with steps of hunks, and go on with review_step. The prompt diff-walk gives the steps.',
	'When the user asks you to close or delete the guided review or the diff walk, call close_guide.',
].join(' ');

const FILE = { type: 'string', description: 'The C++ file: an absolute path, or a path relative to the workspace folder. Default: the file of the active editor, or else the file of the side view.' };
const FUNCTION = { type: 'string', description: 'The function: its qualified name, for example electricity::power_ctrl::process, its name, or the text of its macro call (macroCall). Default: the function at the cursor.' };
const LINE_IN_FUNCTION = { type: 'integer', minimum: 1, description: 'A line in the function. Use it for an overloaded name, or instead of "function".' };
const LINES = { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2, description: 'The first and the last line, from 1.' };

const BLOCK_PROPERTIES = {
	lines: LINES,
	title: { type: 'string', description: 'A short name of the block, for example "Start the solver". Maximum 80 characters.' },
	summary: { type: 'string', description: 'One or two sentences: what the block does and why.' },
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

// The schema of a block with its children, to the last level that the view shows. The schema has no references, because
// not all clients read them
function blockSchema(levels: number): object {
	const children = levels > 1
		? { children: { type: 'array', description: 'The blocks in this block, for example one block for each branch of an if chain.', items: blockSchema(levels - 1) } }
		: {};
	return object({ ...BLOCK_PROPERTIES, ...children }, ['lines', 'title']);
}

// The arguments of a tool, with a clear error for the model if a value has a wrong type
class Args {
	constructor(private readonly args: Record<string, unknown>) {}

	text(key: string): string | undefined {
		const v = this.args[key];
		if (v === undefined || v === null || v === '') {
			return undefined;
		}
		if (typeof v !== 'string') {
			throw new Error(`"${key}" must be a text.`);
		}
		return v;
	}

	requiredText(key: string): string {
		const v = this.text(key);
		if (v === undefined) {
			throw new Error(`Give "${key}".`);
		}
		return v;
	}

	line(key: string): number | undefined {
		const v = this.args[key];
		if (v === undefined || v === null) {
			return undefined;
		}
		const n = typeof v === 'string' ? Number(v) : v;
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
			throw new Error(`"${key}" must be a line number from 1.`);
		}
		return n;
	}

	requiredLine(key: string): number {
		const v = this.line(key);
		if (v === undefined) {
			throw new Error(`Give "${key}".`);
		}
		return v;
	}

	list<T>(key: string): T[] {
		const v = this.args[key];
		if (!Array.isArray(v)) {
			throw new Error(`"${key}" must be a list.`);
		}
		return v as T[];
	}

	fn(): FunctionArg {
		return { function: this.text('function'), line: this.line('line') };
	}

	// the value as the client gives it. The host checks it
	raw(key: string): unknown {
		return this.args[key];
	}

	flag(key: string): boolean {
		const v = this.args[key];
		if (v === undefined || v === null) {
			return false;
		}
		if (typeof v !== 'boolean') {
			throw new Error(`"${key}" must be true or false.`);
		}
		return v;
	}
}

const json = (value: object) => ({ text: JSON.stringify(value) });

export function createTools(host: McpHost): McpTool[] {
	const tool = (
		name: string, title: string, description: string, properties: Record<string, unknown>, required: string[], isReadOnly: boolean,
		run: (a: Args) => Promise<object>,
	): McpTool => ({
		name, title, description, inputSchema: object(properties, required), isReadOnly,
		call: async (args) => json(await run(new Args(args))),
	});

	return [
		tool('get_view', 'Get the view',
			'What the user looks at in VS Code: the active C++ file, the function and the line at the cursor, the selection (also a selection in the DataFlow side view), the lenses of the side view and the layers of the model. Call it first when the user writes "this function", "here" or "the selection".',
			{}, [], true, () => host.view()),
		tool('list_functions', 'List the functions',
			'The function definitions of a C++ file with their lines. A function that a macro makes, for example a test case of Catch2, '
			+ 'also has the text of the macro call (macroCall).',
			{ file: FILE }, [], true, (a) => host.functions(a.text('file'))),
		tool('get_structure', 'Get the statements of a function',
			'The statements of a function, as the Clang engine of DataFlow finds them: the lines and the kind of each statement, the branches of if chains and switches, '
			+ 'the data that goes in (read, and set before) and comes out (written, and used after or visible to the caller), and the exits, thread starts, events and calls. '
			+ 'Use it to group the statements into logical blocks for show_blocks.',
			{ file: FILE, function: FUNCTION, line: LINE_IN_FUNCTION }, [], true, (a) => host.structure(a.text('file'), a.fn())),
		tool('get_flow', 'Trace a variable',
			'Traces a variable or a data member, as Flow Lens of DataFlow does, but does not change the view: each definition, read, write and check with its line. '
			+ 'For a data member also the function, the thread and the locks of each access, and a verdict about data races. Give a line with a reference and the name, '
			+ 'for example "charge.is_dirty" or "is_dirty".',
			{ file: FILE, line: { type: 'integer', minimum: 1, description: 'A line with a reference of the name.' }, name: { type: 'string', description: 'The name of the variable or the member.' } },
			['line', 'name'], true, (a) => host.flow(a.text('file'), a.requiredLine('line'), a.requiredText('name'), false)),
		tool('get_calls', 'Get the calls of a function',
			'The callers and the called functions of a function, with what goes in and comes out of each call: written arguments, checked or unchecked results, async calls and events. The callers in other files come from the call hierarchy of the C++ extension, with only the lines of their calls. A virtual call also gives each override of the project, with virtualOf: the function that the call names.',
			{ file: FILE, function: FUNCTION, line: LINE_IN_FUNCTION }, [], true, (a) => host.calls(a.text('file'), a.fn())),
		tool('get_threads', 'Get the threads and races',
			'The thread starts of a file, the data that two threads share, the protection of each access (lock, order, check), and a verdict for each item: race, check or safe.',
			{ file: FILE }, [], true, (a) => host.threads(a.text('file'))),
		tool('get_hidden', 'Get the hidden C++',
			'The hidden operations of a function: copies, moves, conversions, temporaries, destructors, allocations, map lookups and hidden state, with their lines.',
			{ file: FILE, function: FUNCTION, line: LINE_IN_FUNCTION }, [], true, (a) => host.hidden(a.text('file'), a.fn())),
		tool('get_includes', 'Get the includes',
			'The include hierarchy of a file: the lines that each include adds after the preprocessor, the headers that come in two times, the includes that the file possibly does not use, '
			+ 'the includes that forward declarations can replace (forward: the declarations, or the first line that needs the include), '
			+ 'and the translation units of the compile database that include the file (includedBy). A change of a header compiles these translation units again.',
			{ file: FILE }, [], true, (a) => host.includes(a.text('file'))),
		tool('get_outline', 'Get the outline of a type',
			'The outline of a class, a struct, a union or an enum: the bases, the members in the sequence of the source with their access and marks, the annotations of Unreal Engine '
			+ '(UPROPERTY, UFUNCTION), the signals, slots and properties of Qt, the members that a macro makes, the memory layout with the offset and the size of each data member '
			+ 'and the holes of padding, and the names of the members of the bases. Give the name of the type, or a line with its name.',
			{
				file: FILE,
				name: { type: 'string', description: 'The name of the type, with or without its namespaces, for example electricity::power_ctrl::HomeBatteryCtrl or HomeBatteryCtrl.' },
				line: { type: 'integer', minimum: 1, description: 'A line with the name of the type, for example the line of its definition. Use it instead of "name".' },
			},
			[], true, (a) => host.outline(a.text('file'), a.text('name'), a.line('line'))),
		tool('get_heat', 'Get the heat of the functions',
			'The heat score of the functions of a C++ file: how much a change of a function can break, from 0 to 100, the hottest first. The score adds points of reach '
			+ '(the frame path: a function that runs in each frame, for example from a main loop or a tick or paint override, and the functions that it calls; '
			+ 'the functions that reach it through calls and their files; '
			+ 'the source files that include the header of the declaration; a virtual function), risk (decisions, nesting, writes to shared state, data that threads share, '
			+ 'allocations and copies in loops, a long body) and history (the commits, the fixes and the recent changes in git). Each point has a reason. '
			+ 'A siloed function (reach less than 10) gets half of its risk and history. The callers and the frame path come from a scan of the call graph of the project. '
			+ 'The first call starts the scan and does not wait: the result tells the progress, and a later call gets the callers. '
			+ 'For a review, start with the hottest changed functions.',
			{ file: FILE, function: { ...FUNCTION, description: 'One function: its qualified name or its name. Default: all functions of the file.' } },
			[], true, (a) => host.heat(a.text('file'), a.text('function'))),
		tool('show_blocks', 'Show logical blocks',
			'Shows logical blocks of one function in the DataFlow side view: a bar beside the lines of each block, its title at the end of its first line, and a list with the summaries and the data of the blocks. '
			+ `Give the blocks in the sequence of the lines, with no overlap. A block can have children, for example one child for each branch of an if chain, and a child can have children too: ${MAX_BLOCK_LEVELS} levels at most. `
			+ 'DataFlow moves each range to whole statements and calculates the data that goes in and comes out. The result gives the id, the lines and the data of each block. '
			+ 'A new call replaces the blocks of its function. The blocks of the other functions of the file stay, so you can show blocks for each function of a file, '
			+ 'also with calls at the same time. Each function has its own ids.',
			{
				file: FILE, function: FUNCTION, line: LINE_IN_FUNCTION,
				blocks: {
					type: 'array', minItems: 1, description: 'The blocks of the function.', items: blockSchema(MAX_BLOCK_LEVELS),
				},
			},
			['blocks'], false, (a) => host.showBlocks(a.text('file'), a.fn(), a.list<ModelBlockInput>('blocks'))),
		tool('show_flow', 'Show a flow',
			'Starts Flow Lens of DataFlow on a variable or a data member, as a click on it does, and returns the trace. The side view colors each reference and connects the definitions to the uses.',
			{ file: FILE, line: { type: 'integer', minimum: 1, description: 'A line with a reference of the name.' }, name: { type: 'string', description: 'The name of the variable or the member.' } },
			['line', 'name'], false, (a) => host.flow(a.text('file'), a.requiredLine('line'), a.requiredText('name'), true)),
		tool('highlight', 'Highlight code',
			'Colors lines or blocks in the DataFlow side view and shows a note at the first line of each range. Give "lines" or the id of a block from show_blocks. '
			+ 'If more functions have a block with the id, also give "function". A new call replaces the notes of the file, except with "append".',
			{
				file: FILE,
				ranges: {
					type: 'array', minItems: 1, description: 'The ranges with their notes.',
					items: object({
						lines: LINES,
						block: { type: 'string', description: 'The id of a block, for example 5b, instead of "lines".' },
						function: {
							type: 'string',
							description: 'The function of the block, for example process, if more functions have a block with the id. Overloads have the same name, so for them give "lines".',
						},
						kind: { type: 'string', enum: ['problem', 'warning', 'info'], description: 'The color.' },
						note: { type: 'string', description: 'A short note. Maximum 300 characters.' },
					}, ['kind', 'note']),
				},
				append: { type: 'boolean', description: 'true: keep the old notes of the file. Default: false.' },
			},
			['ranges'], false, (a) => host.highlight(a.text('file'), a.list<ModelNoteInput>('ranges'), a.flag('append'))),
		tool('comment_lines', 'Comment lines',
			'Shows a short comment after the code of single lines in the DataFlow side view, for example to explain a line that is hard to read. '
			+ 'A comment has the color of the comments of the model, or a color that you select, for example one color for each topic. A comment does not color its line. '
			+ 'A new call replaces the comments of the file. With "append", the old comments stay, and a new comment on a line replaces the old comment of that line.',
			{
				file: FILE,
				comments: {
					type: 'array', minItems: 1, maxItems: MAX_COMMENTS, description: 'One comment for each line.',
					items: object({
						line: { type: 'integer', minimum: 1, description: 'The line.' },
						text: { type: 'string', description: 'A short comment in one line of text. Maximum 200 characters.' },
						color: { type: 'string', enum: [...COMMENT_COLORS], description: 'The color. Default: the color of the comments of the model.' },
					}, ['line', 'text']),
				},
				append: { type: 'boolean', description: 'true: keep the old comments of the file. Default: false.' },
			},
			['comments'], false, (a) => host.comment(a.text('file'), a.list<ModelCommentInput>('comments'), a.flag('append'))),
		tool('add_detail', 'Add a detail',
			'Adds a detail to code in the DataFlow side view: a longer explanation or examples, for example values that go in and the result. The line of the code gets a '
			+ 'small symbol at its end, and the text shows in a card when the user moves the mouse on the symbol, so the detail takes no space in the view. '
			+ 'Give "line" and "expression" for the code, or no line for the code that the user selected (get_view gives the selection). '
			+ 'The text can use a small part of Markdown: paragraphs, lists, `code`, code blocks, **bold** and *italic*. '
			+ 'The details of a file stay until clear. A detail on the same code replaces the old detail.',
			{
				file: FILE,
				line: { type: 'integer', minimum: 1, description: 'The first line of the code. Default: the code that the user selected.' },
				expression: { type: 'string', description: 'The code as in the file, for example "a + b * c". It can have more than one line. Default: the line.' },
				title: { type: 'string', description: 'A short title, for example "Examples of the scale". Maximum 80 characters. Default: the code.' },
				text: { type: 'string', description: 'The explanation or the examples. Maximum 4000 characters.' },
			},
			['text'], false, (a) => host.detail(a.text('file'), { line: a.line('line'), expression: a.text('expression'), title: a.text('title'), text: a.requiredText('text') })),
		tool('clear', 'Remove the model layers',
			'Removes the blocks, the notes, the comments and the details of the model from the DataFlow side view. '
			+ 'The guided review and the diff walk stay: close_guide closes them.',
			{ file: { ...FILE, description: 'The file. Default: all files.' } }, [], false, (a) => host.clear(a.text('file'))),
		tool('get_review', 'Get the files to review',
			'The C and C++ files under the paths that the user wants to review, with their number of lines, the changed files first. If the git repository of the project has a target branch, '
			+ 'a changed file also has its diff against the merge base, with the line numbers of the working tree. The engine does not analyze the files for this tool: '
			+ 'read them with list_functions, get_structure, get_flow, get_calls and get_threads. Then make the plan of a guided review for show_review_plan.',
			{
				paths: {
					type: 'array', minItems: 1, items: { type: 'string' },
					description: 'The files and the folders that the user wants to review, as the user names them: paths relative to the folder of the project or of the repository, or absolute paths. '
						+ 'A folder gives its C and C++ files, also in its subfolders, except build folders.',
				},
			},
			['paths'], true, (a) => host.review(a.raw('paths'))),
		tool('show_review_plan', 'Show a review plan',
			'Shows a guided review in the DataFlow side view: a plan of steps that walks the user through the changes of the branch, in the order that a reviewer reads them. '
			+ 'The side view goes to the lines of step 1 and shows its text and its checks. The user goes to the next step with a button, or asks you. A new plan replaces the old plan. Call get_review first.',
			{
				title: { type: 'string', description: 'A short title of the review, for example "Review of the new limit". Maximum 80 characters.' },
				summary: { type: 'string', description: 'One to three sentences: what the changes do. Maximum 1000 characters.' },
				steps: {
					type: 'array', minItems: 1, maxItems: MAX_GUIDE_STEPS, description: 'The steps, in the order of the review.',
					items: object({
						title: { type: 'string', description: 'A short title in the imperative, for example "Check the new limit". Maximum 80 characters.' },
						file: { type: 'string', description: 'The file of the step: a path relative to the repository, as get_review gives it, or an absolute path. Default: the file of the step before.' },
						lines: LINES,
						text: {
							type: 'string',
							description: 'What the reviewer looks at in this step and why, in 2 to 5 sentences. A small part of Markdown: paragraphs, lists, `code` and **bold**. Maximum 2000 characters.',
						},
						checks: {
							type: 'array', maxItems: MAX_STEP_CHECKS, items: { type: 'string' },
							description: 'The questions that the reviewer answers in this step, for example "Can cost be negative here?".',
						},
						kind: {
							type: 'string', enum: [...GUIDE_KINDS],
							description: 'change: changed lines. ripple: code that a change reaches. context: code that explains a change. risk: a possible problem. test: the tests of the change.',
						},
					}, ['title', 'lines', 'text']),
				},
			},
			['steps'], false, (a) => host.showReviewPlan({ title: a.raw('title'), summary: a.raw('summary'), steps: a.raw('steps') })),
		tool('get_diff', 'Get the changes for a diff walk',
			'The hunks of the changed C and C++ files against a base, for a diff walk. Each hunk has an id, its first and last changed line in the working tree, the functions that it changes, '
			+ 'and its diff with the line numbers of the working tree. suggestedSteps puts the hunks of one function in one step. The engine finds the functions, so a large diff can take some seconds. '
			+ 'Read the changed code with get_structure, get_flow and get_calls. Then make the plan of a diff walk for show_diff_walk.',
			{
				base: {
					type: 'string',
					description: '"uncommitted" (default): the changes against HEAD. "target": the changes of the branch against its target branch, as Change Ripple. '
						+ 'Else a commit, a tag or a branch, for example HEAD~1: the changes since its merge base with HEAD. '
						+ 'Each diff goes to the working tree, with the changes that are not saved and the C and C++ files that git does not track yet.',
				},
				paths: {
					type: 'array', minItems: 1, items: { type: 'string' },
					description: 'Only the changes of the files under these files and folders: paths relative to the repository, or absolute paths. Default: all changed files.',
				},
			},
			[], true, (a) => host.diff(a.text('base'), a.raw('paths'))),
		tool('show_diff_walk', 'Show a diff walk',
			'Shows a diff walk in the DataFlow side view: a plan of steps that walks the user through the changes of get_diff, in the order that explains them best. Each step names its hunks. '
			+ 'The side view goes to the lines of step 1, marks the added and the removed lines, and shows the diff and the text of the step. DataFlow adds a step at the end for each hunk that no step names. '
			+ 'A new plan replaces the old plan or the guided review. Call get_diff first.',
			{
				title: { type: 'string', description: 'A short title of the walk, for example "The new charge limit". Maximum 80 characters.' },
				summary: { type: 'string', description: 'One to three sentences: what the changes do. Maximum 1000 characters.' },
				steps: {
					type: 'array', minItems: 1, maxItems: MAX_WALK_STEPS, description: 'The steps, in the order of the walk.',
					items: object({
						title: { type: 'string', description: 'A short title, for example "Add the limit to the settings". Maximum 80 characters.' },
						hunks: {
							type: 'array', minItems: 1, items: { type: 'string' },
							description: 'The ids of the hunks of the step from get_diff, for example ["h2", "h3"]. All hunks of a step must be in one file.',
						},
						text: {
							type: 'string',
							description: 'What changed in this step and why, in 2 to 5 sentences. A small part of Markdown: paragraphs, lists, `code` and **bold**. Maximum 2000 characters.',
						},
						checks: {
							type: 'array', maxItems: MAX_STEP_CHECKS, items: { type: 'string' },
							description: 'Questions that the user can answer in this step, for example "Can the limit be 0?".',
						},
						kind: {
							type: 'string', enum: [...GUIDE_KINDS],
							description: 'change: the main change. ripple: code that a change reaches. context: code that explains a change. risk: a possible problem. test: the tests of the change.',
						},
					}, ['title', 'hunks', 'text']),
				},
			},
			['steps'], false, (a) => host.showDiffWalk({ title: a.raw('title'), summary: a.raw('summary'), steps: a.raw('steps') })),
		tool('review_step', 'Go to a step',
			'Shows a step of the guided review or of the diff walk in the DataFlow side view, as the buttons of the user do. Give "note" to add your explanation, an answer or a finding to the step: '
			+ 'the side view shows it under the text of the step. Give "status" to mark the step. get_view gives the step that the user looks at and the marks of the user.',
			{
				step: { type: 'integer', minimum: 1, description: 'The number of the step, from 1.' },
				note: { type: 'string', description: 'Your note for the step: a small part of Markdown. An empty text removes the note. Maximum 2000 characters.' },
				status: { type: 'string', enum: [...GUIDE_STATUSES], description: 'The mark of the step.' },
			},
			['step'], false, (a) => host.reviewStep(a.requiredLine('step'), a.raw('note'), a.text('status'))),
		{
			...tool('close_guide', 'Close the review or the walk',
				'Closes the guided review or the diff walk in the DataFlow side view, as the button Close review or Close walk of the user does. '
				+ 'The marks and the notes of the steps go away, and the guide does not come back in the next session of VS Code. '
				+ 'Call it only when the user asks you to close or delete the review or the walk. get_view gives the guide that shows.',
				{
					kind: {
						type: 'string', enum: [...GUIDE_TYPES],
						description: 'Close the guide only if it has this kind: "review" for a guided review, "diff walk" for a diff walk. Default: the guide that shows.',
					},
				},
				[], false, (a) => host.closeGuide(a.text('kind'))),
			isDestructive: true,
		},
	];
}

export function createPrompts(): McpPrompt[] {
	return [{
		name: 'explain-function',
		title: 'Explain a function in logical blocks',
		description: 'Explains a C++ function in logical blocks, and shows the blocks in the DataFlow side view.',
		arguments: [{ name: 'function', description: 'The function. Default: the function at the cursor.', required: false }],
		text: (args) => [
			`Explain the C++ function ${args.function ? `"${args.function}"` : 'at the cursor in VS Code'} in logical blocks. Use the DataFlow tools:`,
			args.function ? '1. Call get_structure with this function.' : '1. Call get_view to find the file and the function, then get_structure.',
			'2. Group the statements into 3 to 8 logical blocks. An if chain on a state can get one child block for each branch, and a long branch can get child blocks too.',
			'   Give each block a short title in the imperative, for example "Start the solver", and a summary of one sentence.',
			'3. Call show_blocks.',
			'4. Explain the function in a few short paragraphs, with the block ids in parentheses.',
			'5. If a line is hard to read, call comment_lines with a short comment for it. For a longer explanation of an expression, call add_detail.',
			'Use the facts of the tool results for the data, the threads and the exits. If a statement is not clear, say so.',
		].join('\n'),
	}, {
		name: 'guided-review',
		title: 'Review files step by step',
		description: 'Makes a plan to review the files and the folders that you name, shows it in the DataFlow side view, and walks you through it.',
		arguments: [
			{ name: 'paths', description: 'The files and the folders to review, for example "src/power include/power/plan.hpp".', required: true },
			{ name: 'focus', description: 'What the review looks at first, for example threads or error handling. Default: all.', required: false },
		],
		text: (args) => [
			`Review ${args.paths ? `these files and folders: ${args.paths}.` : 'the files and the folders that I name.'} Go through the review with me, one step after the other. Use the DataFlow tools:`,
			'1. Call get_review with the paths. It gives the C and C++ files, and the diff of each changed file against the target branch of the repository.',
			'2. Read the code: call list_functions for the files, and get_structure for the functions with changes, or for the main functions of a file with no changes. '
			+ 'Where the data, the callers or the threads matter, call get_flow, get_calls or get_threads.',
			'3. Make a plan of 3 to 10 steps, in the order that a reviewer reads the code: first the changed lines or the entry points, then the code that they use or that uses them, '
			+ 'then the risks, for example threads, error paths and missing checks, then the tests.',
			...(args.focus ? [`   Look first at: ${args.focus}.`] : []),
			'   Give each step a short title in the imperative, the file and the lines, a text with what to look at and why, and one to three questions in "checks".',
			'4. Call show_review_plan. The side view shows step 1.',
			'5. Explain step 1 in a few sentences. Then stop, and wait for me.',
			'6. When I ask for the next step, call get_view: it gives the step that I look at and my marks. Explain that step, or call review_step to go to the next step. '
			+ 'If you find a problem, add it with review_step as a note with the status issue.',
			'Use the facts of the tool results. If you are not sure of a fact, say so.',
		].join('\n'),
	}, {
		name: 'diff-walk',
		title: 'Walk through the changes step by step',
		description: 'Explains the changes of the working tree, of the branch or since a commit one step after the other, with the diff of each step in the DataFlow side view.',
		arguments: [
			{ name: 'base', description: 'The changes: uncommitted (default), target for the changes of the branch, or a commit, for example HEAD~1.', required: false },
			{ name: 'focus', description: 'What the walk explains first, for example the new settings or the tests. Default: the main change.', required: false },
		],
		text: (args) => [
			`Walk me through the changes${args.base ? ` against ${args.base}` : ' that are not committed'}, one step after the other. Use the DataFlow tools:`,
			`1. Call get_diff${args.base ? ` with the base "${args.base}"` : ''}. It gives the hunks of the changed C and C++ files with their ids, and suggested steps.`,
			'2. Read the changed code: call get_structure for the changed functions. Where the data or the callers matter, call get_flow or get_calls.',
			'3. Make a plan of 2 to 12 steps, in the order that explains the change best: first the main change, for example a new type or the new logic, '
			+ 'then the code that uses it, then the tests. Put each hunk in a step. All hunks of a step must be in one file. The suggested steps are a good start.',
			...(args.focus ? [`   Explain first: ${args.focus}.`] : []),
			'   Give each step a short title, its hunks, and a text that says what changed and why, in 2 to 5 sentences.',
			'4. Call show_diff_walk. The side view shows step 1 with its diff.',
			'5. Explain step 1 in a few sentences. Then stop, and wait for me.',
			'6. When I ask for the next step, call get_view: it gives the step that I look at. Explain that step, or call review_step to go to the next step. '
			+ 'If you find a problem, add it with review_step as a note with the status issue.',
			'Use the facts of the tool results. If you are not sure why a line changed, say so.',
		].join('\n'),
	}];
}
