# Use the MCP tools

DataFlow has an MCP server (Model Context Protocol). A language model in an MCP client can read the analysis of the engine and change the side view. Claude Code and the agent mode of VS Code are examples of MCP clients.

The model can show the logical blocks of a function with names and summaries, and start Flow Lens on a variable. It can also color lines with notes, add comments to single lines, and add details to code. The engine gives the facts, and the model adds the words.

- [Connect Claude Code](#connect-claude-code)
- [Connect a different client](#connect-a-different-client)
- [Ask the model](#ask-the-model)
- [What the side view shows](#what-the-side-view-shows)
- [The tools](#the-tools)
- [Security and privacy](#security-and-privacy)
- [Settings](#settings)

## Connect Claude Code

This method needs no MCP setup.

1. Run **DataFlow: Connect to Claude Code**. If the Claude Code extension is installed, DataFlow also asks you one time when it starts. Then click **Connect**.
   - **Not now** asks you again after 7 days.
   - **Do not ask again** stops the question.
2. Start a new Claude Code session: in the panel of the Claude Code extension, in a terminal, or in the desktop app. Claude Code gets the tools of DataFlow in all projects and windows.
3. Ask Claude Code about the code. [Ask the model](#ask-the-model) gives examples.

Claude Code has no interface for other extensions. Thus DataFlow uses two documented settings of Claude Code in `~/.claude/settings.json`:

- `extraKnownMarketplaces` gets the marketplace `dataflow-vscode`. This marketplace is a local folder that DataFlow writes: `.dataflow/mcp/claude` in your home folder.
- `enabledPlugins` turns on its plugin `dataflow@dataflow-vscode`.

The other keys of the file stay as they are. If `CLAUDE_CONFIG_DIR` moves the settings of Claude Code, DataFlow uses the same folder.

The plugin has one MCP server, `plugin:dataflow:dataflow`, so the tools have names such as `mcp__plugin_dataflow_dataflow__get_view`. The server is the bridge of DataFlow. VS Code itself runs the bridge as Node.js, so you need no Node.js. The bridge reads the token from a file in `.dataflow/mcp` that only you can read.

After a reload of the VS Code window, for example with a new version of DataFlow, the bridge tells Claude Code that the tools changed. Then Claude Code gets the new tools. A bridge of an older version of DataFlow does not do this, so start a new Claude Code session one time.

While the connection is on, the MCP server of each window starts with DataFlow. If you turn off the plugin in Claude Code, DataFlow does not turn it on again.

To remove the connection, run **DataFlow: Disconnect from Claude Code**. The command removes the two keys, the plugin folder and the token file. DataFlow then does not ask you again.

## Connect a different client

1. Start the server. Use one of these methods:
   - Run **DataFlow: Start MCP Server**. The server runs until the window closes.
   - Set `dataflow.mcp.enabled` to `true`. The server starts each time that DataFlow starts.
   - The agent mode of VS Code starts the server when it needs it. VS Code shows DataFlow in its list of MCP servers, and you agree to the start there.
2. Run **DataFlow: Copy MCP Setup**, and select a setup. The command puts the setup on the clipboard.
   - **Claude Code: connect with no setup** does the same as **DataFlow: Connect to Claude Code**.
   - **Claude Code: all projects and windows** gives a command for a terminal. Paste it and push Enter. Claude Code then starts the bridge of DataFlow, a small Node.js program. The bridge sends the messages to the VS Code window that has the folder of Claude Code. Thus one setup works for all projects and all windows. The command has this form:

     ```bash
     claude mcp add --transport stdio --scope user --env DATAFLOW_TOKEN=<token> dataflow -- node "C:\Users\<user>\.dataflow\mcp\bridge.js"
     ```

   - **Claude Code: this window only** gives a command with the address of the server of this window:

     ```bash
     claude mcp add --transport http dataflow http://127.0.0.1:47321/mcp --header "Authorization: Bearer <token>"
     ```

   - **JSON for a client that starts programs** gives the server for the configuration file of a client, for example `claude_desktop_config.json` of Claude Desktop. If no window has the folder of the client, the bridge uses the window that had the focus last.
3. For a different client with HTTP, give it the address and the header of the setup **Claude Code: this window only**. The agent mode of VS Code needs no setup.

The bridge of these setups needs Node.js on the `PATH`. DataFlow copies the bridge into the folder `.dataflow/mcp` of your home folder, so an update of DataFlow does not change the setup. While the server of a window runs, the window keeps a file there with its address and its folders. The file has no token.

Each VS Code window has its own server. If the port is in use, for example by a different window, the server takes a free port. The bridge finds the server of each window. A setup with an address goes only to the window of that address. The status line of the side view shows **MCP** and the name of the client that connected last.

## Ask the model

Ask the model about the code in words. The model selects the tools. These are examples:

- "Explain process() in logical blocks, and show me what happens to charge.is_dirty."
- "Mark the lines of process() that can fail, and tell me why."
- "Add a short comment to each line of process() that is hard to read."
- "Give examples for the selected expression." First, select the expression in the side view or in the editor.
- "Can two threads use the same data in this file at the same time?"
- "Remove your notes from the side view."

The server also has the prompt **explain-function**. It tells the model the steps to explain a function in logical blocks. Its argument `function` is optional. The default is the function at the cursor. The prompt tells the model to do these steps:

1. Call `get_structure` for the function. With no function, call `get_view` first to find the file and the function.
2. Put the statements into 3 to 8 logical blocks. An if chain on a state can get one child block for each branch, and a long branch can also get child blocks.
3. Call `show_blocks`.
4. Explain the function in some short paragraphs, with the ids of the blocks.
5. Add comments to lines that are hard to read, and details to expressions that need a longer explanation.

## What the side view shows

The layers of the model show in the side view:

- **Blocks**: each block has a bar next to the line numbers. A child block, for example a branch of an if chain, has a second bar, and each level after it has one more bar. The blocks have a maximum of five levels. The title of a block shows after the code of its first line.
- **Notes**: a note of the model colors its lines: red for a problem, orange for a warning, and pink for information. The note shows after the code of the first line.
- **Comments**: a comment of the model shows after the code of its line, with a star. It does not color the line. A comment has the color `dataflow.modelComment`, or a color that the model selects: blue, green, purple, yellow, orange, red or gray. These colors are the chart colors of your color theme.
- **Details**: a detail of the model is a longer explanation or examples for a part of the code. The first line of the code gets a symbol **i** at its end. On a long line, the symbol stays at the right edge of the side view. To see the detail in a card, move the mouse on the symbol. Thus the detail takes no space in the view. While the card shows, the code of the detail gets a background. To see the card at the cursor, push Ctrl+Alt+K. The text can have lists, code and bold text.

To get a detail, select code in the side view or in the editor. Then ask the model, for example "give examples for the selected expression".

The bar **MODEL** under the toolbar shows the blocks, the note and the comment at the cursor. On a long line, the titles, the notes and the comments can be out of the visible part of the side view. This bar always shows them. Out of a block, the bar shows the number of blocks of the function at the cursor, or the number of functions with blocks.

The tab **Model** of the details column uses the cursor:

- It lists the blocks of the function at the cursor with their summaries. Each block shows the data that goes in and comes out, and the exits, thread starts, events and calls.
- It also lists the notes, the comments and the details of that function.
- If more than one function has blocks, the tab shows a link for each of these functions. To go to the first block of a function, click its link.
- To go to the line of a block, a note, a comment or a detail, click it. A detail also opens its text.
- With the cursor out of a function, the tab lists the notes, the comments and the details of the file.

A badge **MODEL** marks each title, summary, note and detail of the model, and a star marks each comment. The lines and the data come from the engine.

To hide the layers of the model in the code, click **Model** in the toolbar of the side view. To show them again, click it again. The command **DataFlow: Show or Hide Model Layers** does the same. The layers stay, and the tab Model still lists them. A new call of a view tool shows the layers again.

To remove the blocks, the notes, the comments and the details, click **Remove model layers** in the tab Model, or run **DataFlow: Remove Model Layers**.

During an edit, the layers move with their code:

- A block, a note, a comment or a detail whose lines you delete goes away.
- A detail finds its code again after an edit in its line.
- A change that replaces the text from its start to the last line of the layer removes all layers.
- After a reload of the window, the layers come back. Each layer goes to the nearest place where its first and its last line have the same text as before. A block whose lines changed goes away with its child blocks.

The model can show blocks for each function of a file at the same time. A call of `show_blocks` replaces only the blocks of its function, and each function has its own block ids. If two functions have a block with the same id, a note on that block also gives the function. Two overloads of a function have the same name, so for a block of an overload, a note gives the lines of the block.

The model gives each block as a range of lines. DataFlow moves each range to whole statements. A block of the function covers the statements of the body that its lines touch. A child block covers the branches or the statements in its parent. If the parent is one if statement with no else, the child blocks cover the statements of that if. If blocks overlap after the move, the view does not change, and the model gets the reason.

DataFlow calculates the data that goes into each block and comes out of it:

- "In" is a name that the block reads and does not set before the read.
- "Out" is a name that the block writes and that a read outside of the block can get through the control flow. The read can be after the block, or in the next turn of a loop. A write that each path writes again before the read is not "out".
- A member, a global and a field of a parameter are always "out".
- For a write through an element of a container, "out" uses the reads of the container. Thus it can contain a write that each path writes again.
- For a write of a captured variable in a lambda, a later line that reads the name counts. The reason is that the reads are in the function that contains the lambda.

## The tools

The read tools give the facts of the engine and do not change the view. The view tools change the side view.

| Tool | Kind | Function |
| --- | --- | --- |
| [`get_view`](#get_view) | read | The active file, the function and the line at the cursor, and the selection. Also the state of the side view, with the blocks of each function. With no C++ editor, the file, the cursor and the selection of the side view |
| [`list_functions`](#list_functions) | read | The functions of a file with their lines |
| [`get_structure`](#get_structure) | read | The statements of a function with their lines, the branches, the data in and out, and the exits, thread starts, events and calls |
| [`get_flow`](#get_flow) | read | The trace of a variable or a data member, without a change of the view. For a member also the threads, the locks and a verdict about races |
| [`get_calls`](#get_calls) | read | The data of Call Hierarchy |
| [`get_threads`](#get_threads) | read | The data of Threads and races |
| [`get_hidden`](#get_hidden) | read | The data of Hidden C++ |
| [`get_includes`](#get_includes) | read | The data of Include Hierarchy, with the translation units of the compile database that include the file |
| [`show_blocks`](#show_blocks) | view | Shows the logical blocks of a function, with a maximum of five levels. A new call replaces the blocks of its function. The blocks of the other functions of the file stay. |
| [`show_flow`](#show_flow) | view | Starts Flow Lens on a variable or a data member, as a click does |
| [`highlight`](#highlight) | view | Colors ranges of lines or blocks, with a note for each range |
| [`comment_lines`](#comment_lines) | view | Adds a short comment to single lines, in the color of the comments or in a color of the model |
| [`add_detail`](#add_detail) | view | Adds a detail to an expression, a line or the selection of the user: an explanation or examples in a card on the code |
| [`clear`](#clear) | view | Removes the blocks, the notes, the comments and the details |

Lines start at 1. Many tools use these parameters:

| Parameter | Type | Function |
| --- | --- | --- |
| `file` | text | The C++ file: an absolute path, or a path relative to the workspace folder. The default is the file of the active editor, or else the file of the side view. |
| `function` | text | The function: its qualified name, for example `electricity::power_ctrl::process`, its name, or the text of its macro call. The default is the function at the cursor. |
| `line` | integer | A line in the function. Use it for an overloaded name, or in place of `function`. |

### get_view

Gives what the user looks at in VS Code: the active C++ file, the function and the line at the cursor, and the selection. The selection can also be a selection in the side view. The result also gives the lenses of the side view and the layers of the model. The model calls this tool first when you write "this function", "here" or "the selection".

Parameters: none.

Example request: "What does the function at my cursor do?"

### list_functions

Gives the function definitions of a C++ file with their lines. A function that a macro makes, for example a test case of Catch2, also has the text of the macro call (`macroCall`).

Parameters: `file`.

Example request: "Which functions are in battery.cpp?"

### get_structure

Gives the statements of a function, as the engine finds them:

- the lines and the kind of each statement
- the branches of if chains and switches
- the data that goes in (read, and set before) and comes out (written, and used after or visible to the caller)
- the exits, the thread starts, the events and the calls

The model uses this tool to put the statements into logical blocks for `show_blocks`.

Parameters: `file`, `function`, `line`.

Example request: "Which statements of process() change the state?"

### get_flow

Traces a variable or a data member, as Flow Lens does, but does not change the view. The result gives each definition, read, write and check with its line. For a data member, it also gives the function, the thread and the locks of each access, and a verdict about data races.

| Parameter | Type | Function |
| --- | --- | --- |
| `file` | text | See the common parameters. |
| `line` | integer | Necessary. A line with a reference of the name. |
| `name` | text | Necessary. The name of the variable or the member, for example `charge.is_dirty` or `is_dirty`. |

Example request: "Where does charge.is_dirty get its value? Do not change the view."

### get_calls

Gives the callers and the called functions of a function. For each call, it gives what goes in and comes out: the written arguments, the checked or unchecked results, the async calls and the events.

- The callers in other files come from the call hierarchy of the C/C++ extension, with only the lines of their calls.
- A virtual call also gives each override of the project, with `virtualOf`: the function that the call names.

Parameters: `file`, `function`, `line`.

Example request: "Which functions call solve_power_plan(), and do they check its result?"

### get_threads

Gives the thread starts of a file, the data that two threads share, and the protection of each access: a lock, an order or a check. Each item has a verdict: race, check or safe.

Parameters: `file`.

Example request: "Can two threads use the same data in this file at the same time?"

### get_hidden

Gives the hidden operations of a function with their lines: copies, moves, conversions, temporaries, destructors, allocations, map lookups and hidden state.

Parameters: `file`, `function`, `line`.

Example request: "Which copies and allocations does process() make that I cannot see in the code?"

### get_includes

Gives the include hierarchy of a file:

- the lines that each include adds after the preprocessor
- the headers that come in two times
- the includes that the file possibly does not use
- the translation units of the compile database that include the file (`includedBy`). A change of the header compiles these translation units again.

Parameters: `file`.

Example request: "Which includes of this file add the most lines, and which includes can I remove?"

### show_blocks

Shows the logical blocks of one function in the side view. Each block gets a bar beside its lines, and its title at the end of its first line. The tab Model lists the summaries and the data of the blocks.

| Parameter | Type | Function |
| --- | --- | --- |
| `file`, `function`, `line` | | See the common parameters. |
| `blocks` | list | Necessary. The blocks of the function, with a minimum of one block. |

Each block has these fields:

| Field | Type | Function |
| --- | --- | --- |
| `lines` | two integers | Necessary. The first and the last line of the block. |
| `title` | text | Necessary. A short name of the block, for example "Start the solver". DataFlow cuts a title after 80 characters. |
| `summary` | text | One or two sentences: what the block does and why. DataFlow cuts a summary after 400 characters. |
| `children` | list | The blocks in this block, for example one block for each branch of an if chain. A child can have children too, to a maximum of five levels. |

Give the blocks in the sequence of the lines, with no overlap. DataFlow moves each range to whole statements, and it calculates the data that goes in and comes out. The result gives the id, the lines and the data of each block. A new call replaces the blocks of its function. The blocks of the other functions of the file stay, so the model can show blocks for each function of a file.

Example request: "Explain process() in logical blocks."

### show_flow

Starts Flow Lens on a variable or a data member, as a click on it does, and gives the trace. The side view colors each reference and connects the definitions to the uses.

| Parameter | Type | Function |
| --- | --- | --- |
| `file` | text | See the common parameters. |
| `line` | integer | Necessary. A line with a reference of the name. |
| `name` | text | Necessary. The name of the variable or the member. |

Example request: "Show me what happens to charge.is_dirty."

### highlight

Colors lines or blocks in the side view, and shows a note at the first line of each range.

| Parameter | Type | Function |
| --- | --- | --- |
| `file` | text | See the common parameters. |
| `ranges` | list | Necessary. The ranges with their notes, with a minimum of one range. |
| `append` | true or false | `true` keeps the old notes of the file. The default is `false`: a new call replaces the notes of the file. |

Each range has these fields:

| Field | Type | Function |
| --- | --- | --- |
| `lines` | two integers | The first and the last line. Give `lines` or `block`. |
| `block` | text | The id of a block from `show_blocks`, for example `5b`, in place of `lines`. |
| `function` | text | The function of the block, if more functions have a block with the id. Overloads have the same name, so for an overload give `lines`. |
| `kind` | text | Necessary. The color: `problem` (red), `warning` (orange) or `info` (pink). |
| `note` | text | Necessary. A short note. DataFlow cuts a note after 300 characters. |

Example request: "Mark the lines of process() that can fail, and tell me why."

### comment_lines

Shows a short comment after the code of single lines, for example to explain a line that is hard to read. A comment does not color its line.

| Parameter | Type | Function |
| --- | --- | --- |
| `file` | text | See the common parameters. |
| `comments` | list | Necessary. One comment for each line, from 1 to 2000 comments. |
| `append` | true or false | `true` keeps the old comments of the file. A new comment on a line then replaces the old comment of that line. The default is `false`: a new call replaces the comments of the file. |

Each comment has these fields:

| Field | Type | Function |
| --- | --- | --- |
| `line` | integer | Necessary. The line. |
| `text` | text | Necessary. A short comment in one line of text. DataFlow cuts a comment after 200 characters. |
| `color` | text | `blue`, `green`, `purple`, `yellow`, `orange`, `red` or `gray`, for example one color for each topic. The default is the color `dataflow.modelComment`. |

Example request: "Add a short comment to each line of process() that is hard to read. Use one color for each topic."

### add_detail

Adds a detail to code in the side view: a longer explanation or examples, for example the values that go in and the result. The line of the code gets a small symbol at its end. The text shows in a card when the user moves the mouse on the symbol.

| Parameter | Type | Function |
| --- | --- | --- |
| `file` | text | See the common parameters. |
| `line` | integer | The first line of the code. The default is the code that the user selected. |
| `expression` | text | The code as in the file, for example `a + b * c`. It can have more than one line. The default is the line. |
| `title` | text | A short title, for example "Examples of the scale". DataFlow cuts a title after 80 characters. The default is the code. |
| `text` | text | Necessary. The explanation or the examples, with a maximum of 4000 characters. |

The text can use a small part of Markdown: paragraphs, lists, `code`, code blocks, **bold** and *italic*. The code of a detail can have a maximum of 40 lines. A file can have a maximum of 300 details. A detail on the same code replaces the old detail. The details of a file stay until `clear`.

Example request: select an expression, then ask "Give examples for the selected expression."

### clear

Removes the blocks, the notes, the comments and the details of the model from the side view.

| Parameter | Type | Function |
| --- | --- | --- |
| `file` | text | The file. The default is all files. |

Example request: "Remove your blocks and notes from the side view."

## Security and privacy

- The server listens only on 127.0.0.1.
- The server accepts a request only with the token in the header `Authorization`. It refuses requests from web pages and requests to other host names.
- The token stays the same after a restart. VS Code keeps it in its secret storage.
- The tools read only the files of the project that is open in VS Code.
- A tool with no file uses the file of the active C++ editor. If no C++ editor shows, the tool uses the file of the side view. An example is when the focus is in the terminal of the client.
- With no C++ text editor on the screen, the view tools move only the side view, and the text editor does not open.

DataFlow sends code and analysis data only to the client that you connect, but that client can send them to its model provider. The model can be wrong: compare its words with the code.

## Settings

| Setting | Default | Function |
| --- | --- | --- |
| `dataflow.mcp.enabled` | `false` | Start the MCP server when DataFlow starts. |
| `dataflow.mcp.port` | `47321` | The port on 127.0.0.1. If a different program uses the port, the server takes a free port. `0` always takes a free port. |

[Use DataFlow](usage.md#all-settings) lists all settings of DataFlow.
