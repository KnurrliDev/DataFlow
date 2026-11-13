# Changelog

## Unreleased

- `get_heat` gives `signals`: each reason of a function with the id and the measure of its signal, for example the frame path as a list of functions. A client can use the signals with no need to read the texts.
- Each function of `get_heat` has `isReachComplete`: false until the call graph gives its reach. Then the score can be too low or too high. The changed functions of `get_review` and `get_diff` also give it.
- `get_heat` accepts `lines`: it then gives only the functions with a line in these lines, the hottest first.
- `show_diff_walk` accepts `allHunks`. With `false`, the walk shows only the hunks of the plan, and the result gives the other hunks in `notShown`.
- The new read tool `get_call_graph` gives the state of the scan of the call graph and the frame functions of the project. It does not start or stop a scan. The API gets `getCallGraph`.
- API: `engineError` and the field `error` of `onDidChangeEngineState` give the reason of a failed engine, or of a stopped engine with no compile database.
- Heat: the call graph finds the callers that it cannot see. A function whose address the code uses, an override of a virtual function of a library, and a slot that Qt can call get a reason with no points, and they are never siloed. Before, such a function could get half of its risk and history, and thus a band that was too cool. `get_heat` gives `reachUnknown` with the cause.
- Heat: a connection of a signal of Qt of the project to a slot is a call in the call graph. The functions that emit the signal are the callers of the slot.
- Heat: a frame path of more than 8 calls gives a reason with no points, and a notice tells it. Before, such a function had no frame path.
- Heat: the tab Heat and `get_heat` tell the test functions that reach a function. They give no points. The new setting `dataflow.heat.testFolders` gives the folders of the tests.
- The new read tool `get_callers` gives the callers of a function in all files of the project up to a depth, with the lines of their calls, and the frame paths of the function. The API gets `getCallers`, and the engine has the new request `dataflow/callers`.
- Each client has its own layers in each file. A client is an MCP client, or an extension with the API. The view tools of a client change only its layers, and `clear` removes only its layers. Before, a client replaced the notes and the comments of all clients in the file.
- The side view shows the layers of all clients. The bars of the blocks of each client stand side by side in the color of the client. The tab Model shows one group for each client, and the card of a detail names its client. `get_view` gives the items of the other clients in `otherClients`.
- Each note and each comment gets an id, as each detail has one: `n1`, `c1` and so on. `highlight`, `comment_lines` and `add_detail` give the ids. The new view tool `remove` removes notes, comments and details by their ids, and the API gets `remove`. The layers of 0.5.0 get their ids when they come back.
- API: an extension can put buttons on its notes, its details and the steps of its guides with `actions`. A click sends `onDidInvokeAction` only to that extension. The MCP server refuses `actions`, because an MCP client gets no event for a click.
- Guides: the side view keeps a stack of up to 5 guided reviews and diff walks. A new plan goes on the top, and the guide under it shows again when the top guide closes. Before, a new plan replaced the guide of the user or of a different client. The tab Guide names the guides under the top guide, and a click brings one to the top. With 5 guides, a new guide fails.
- Each guide has an id and an owner: the user for the command Walk Through the Changes, else its client. `show_review_plan` and `show_diff_walk` with the id of a guide of the client replace that guide at its place. `review_step` and `close_guide` get `id`, and they change or close a guide of a different owner only with `force`. `get_view` gives the stack in `guides`.
- A step of a guided review can be in each text file of the project, for example `CMakeLists.txt`, or in a new file with `newFile`. The text editor shows a step of a file that is not a C or C++ file, and the side view keeps its file. `get_diff` with `allFiles` also gives the changes of the other text files.
- A step can have a `label`, which the tab Guide shows next to the title, and `data` of the client. `review_step` changes them.
- The tab Guide has a field for the note of the user on the current step. `get_view` gives the note of the user and the text of the note of the model. The summary has the notes of the user.
- API: `onDidChangeGuide` gives `change` and `by`: the cause of the change, and the user or the client.
- A guided review has a maximum of 40 steps, as a diff walk. Before, the maximum was 20.
- The new view tools `mark_base` and `delete_mark`: a mark keeps the text files under paths, with a maximum of 500 files and 20 MB. `get_diff` and `start_ripple` with the base `mark:<name>` give the changes since the mark, also with no commit. Each client has its own marks, with a maximum of 20. The marks stay after a reload of the window, and `get_view` gives them. The API gets `markBase` and `deleteMark`.
- `start_ripple` gets `base` and `paths`, as `get_diff`. The tool never asks the user: with no target branch, the review fails, and the model gives a different base. An update after a save keeps the base and the paths.
- API: the event `onDidParse` tells the end of a parse of a file, with the number of the errors and the first 5 errors. The status `ready` of the notification `dataflow/status` of the engine now has `errorCount` and `errors`.
- API: `registerTools` adds tools of an extension to the MCP server. The MCP name of a tool starts with the name of the client, and its description too. The result removes the tools. After a change of the tools, the bridge tells its client that the list of the tools changed, and the agent mode of VS Code gets a new version of the server.

## 0.5.0

- Heat: the new lens shows how much a change of each function can break. Each function gets a score from 0 to 100, 1 to 5 flames before the line number of its name, and a strip in the color of its band.
- The score adds points of reach, risk and history. The reach comes from the frame path, the callers and their files, and the source files that include the declaration. The callers are all functions that reach the function through calls. The risk comes from the decisions, the nesting, the writes to shared state, the data that threads share, the costs in loops and the length. The history comes from the commits of git.
- A function on the frame path runs in each frame and is hot. A frame path starts at an override of a frame function of Unreal Engine or Qt, or at a function that a main loop calls. The new setting `dataflow.heat.frameFunctions` adds more frame functions.
- If the reach of a function is less than 10, its risk and its history count half. Thus a complex function that only a small part of the project uses stays cool.
- The callers come from a scan of the call graph of the project in the engine. The scan starts with Heat and does not block DataFlow. The tab Heat shows its progress with **Stop** and **Continue**. After a save, an update parses only the source files that include a changed file.
- The scan and the include reach skip the build folders in the project folders, for example the libraries that CMake fetches into `_deps`.
- The tab Heat shows each point of the function at the cursor with its reason, the functions of the file, the hottest first, and the frame functions of the project.
- In a guided review and in a diff walk, each step in the tab Guide shows the flames and the score of its hottest function while Heat is on. The walk of the command keeps the sequence of the files and the lines.
- `get_review` and `get_diff` give the heat of the changed functions, and `hottestChanges` lists them, the hottest first. The model starts its plan with the hottest changes.
- The command **DataFlow: Toggle Heat**, and the theme colors `dataflow.heatCool`, `dataflow.heatWarm`, `dataflow.heatHot` and `dataflow.heatVeryHot`.
- The engine has the new requests `dataflow/metrics` and `dataflow/callGraph`, and the MCP server has the new tool `get_heat`.
- API for extensions: other VS Code extensions get an API from the exports of DataFlow with `getApi(1, { client })`. Its methods run the tools of the MCP server and give their data as objects, with the types of `api/dataflow-api.d.ts`. The events tell the changes of the engine, of the file, the function and the line at the cursor, of the guide, and of the scan of the call graph. The side view shows the name of the extension on its blocks, notes, comments, details and guides.
- The MCP server has ten new tools. `get_logic` gives the decisions of a function and a path for the choices, and `show_logic_path` shows the path in Logic Map. `get_ripple` gives the code that each change reaches with Change Ripple, `start_ripple` runs a review, and `clear_ripple` closes it. `set_lens` turns a lens on or off, `show_line` moves the cursor to a line, and `clear_flow` removes the trace of Flow Lens. `scan_call_graph` and `stop_call_graph` start and stop the scan of the call graph.
- Fix: a compile database in a new build folder next to the project folder sometimes did not start the engine. A watcher of a folder out of the workspace starts some time after DataFlow makes it, and a build folder that came in this time gave no event. DataFlow now looks for the compile databases again 2 s and 6 s after it makes its watchers.

## 0.4.0

- Diff walk: the side view goes through the changes of a diff, one step after the other. The changes are the changes that are not committed, the changes against a branch, or the changes since a commit. The C and C++ files that git does not track yet are new files.
- The code view marks the added lines of the current step in green, with the changed characters. A red line marks the place of removed lines. A card shows the removed lines. The tab Guide shows the diff of each step, and **Diff editor** opens the diff editor of VS Code at the step.
- The command **DataFlow: Walk Through the Changes** makes one step for each changed function. For the changes against a different branch, it shows a list of the local and the remote branches.
- The MCP server has the new tools `get_diff` and `show_diff_walk`, and the prompt `diff-walk`. The model puts the changes in a sequence, and tells what changed and why. `review_step` also goes to a step of a diff walk. The new tool `close_guide` closes the diff walk or the guided review when you ask the model for it.
- The commands of the guide have new names: **DataFlow: Next Guide Step**, **DataFlow: Previous Guide Step**, **DataFlow: Copy Guide Summary** and **DataFlow: Close Guide**.
- `.inc` files: all parts of DataFlow parse an `.inc` file of a unity build after the lines of its C++ file before the `#include`. Before, DataFlow used this parse only after the cursor was in the `.inc` file. The MCP tools also accept an `.inc` file that no editor shows. After a restart of the engine, the `.inc` files keep this parse.

## 0.3.1

- Include Hierarchy: the details of an include that forward declarations can replace fit in the details column. In 0.3.0, the long lines of the declarations made the details wider than the column, and **Copy** and **Check** were outside of the view.

## 0.3.0

- Go to a definition in the side view: Ctrl+click on a name, or F12, goes to its definition. The side view moves, and the text editor stays at its place. Ctrl+click on the file of an `#include` shows the header.
- Back and Forward of the side view: Alt+Left and Alt+Right, or the mouse buttons, go through the jumps of the side view.
- The engine has the new request `dataflow/definition`. It finds the definition of a name, a macro or the file of an include, if the definition providers of VS Code find none.
- Outline of a type: right-click the name of a class, a struct, a union or an enum in the side view, and click **Outline**. A panel shows the members in the sequence of the source and the layout with the padding. It also shows the annotations of Unreal Engine and Qt, and the members of the bases.
- The engine has the new request `dataflow/outline`, and the MCP server has the new tool `get_outline`.
- Forward declarations in Include Hierarchy: an include that forward declarations can replace gets a hint and the badge **fwd**. The details show the declarations with **Copy**, and the lines that use each type. For the other used includes, the details show the first line that needs the header, and the reason. The engine request `dataflow/includes` and the MCP tool `get_includes` give the result in `forward`.
- **Check** of the forward declarations: the engine parses a copy of the file in memory with the declarations in the place of the include, and the details show the errors. The file does not change. The engine has the new request `dataflow/checkForward`.

## 0.2.0

- Guided review: name the files and the folders to review, and a language model makes a plan of steps. The side view shows one step after the other, with its lines, its text and its questions. Mark each step as OK, issue or question, and copy a summary of the review.
- The MCP server has the new tools `get_review`, `show_review_plan` and `review_step`, and the prompt `guided-review`.
- The commands **DataFlow: Next Review Step**, **DataFlow: Previous Review Step**, **DataFlow: Copy Review Summary** and **DataFlow: Close Guided Review**, and the theme color `dataflow.reviewGuide`.
- Unreal Engine 5 projects: the command **DataFlow: Make Unreal Compile Database** lets UnrealBuildTool make the compile database of the project in `Intermediate/DataFlow`. DataFlow asks if it can make the database when an Unreal project has none. The settings `dataflow.unreal.enginePath`, `dataflow.unreal.target`, `dataflow.unreal.configuration` and `dataflow.unreal.arguments` change the run of UnrealBuildTool.
- The default of `dataflow.ripple.asyncFunctions` has the async functions of Unreal: `Async`, `AsyncTask`, `AsyncThread`, `AsyncPool` and `UE::Tasks::Launch`. The default of `dataflow.project.skipFolders` has the folders `Binaries`, `DerivedDataCache`, `Intermediate` and `Saved`.
- The engine ignores the options of MSVC that clang-cl does not know, for example the options of UnrealBuildTool in its response files. In a command of MSVC, a `##` that gives no valid token is not an error, as in MSVC.

## 0.1.0

The first release of DataFlow. The VSIX package is for Windows x64, and it contains the engine.

- The side view shows the file of the active C++ editor beside the editor, with the colors of your color theme.
- The lenses: Flow Lens, Logic Map, Hidden C++, Include Hierarchy, Call Hierarchy, Threads and races, and Change Ripple.
- The MCP server gives the data of the engine to a language model. The view tools show the logical blocks, the notes, the comments and the details of the model in the side view.
- The command **DataFlow: Connect to Claude Code** connects Claude Code with no MCP setup.
- The engine on Clang 23 reads the compile databases of CMake, qmake and Qt Creator.
