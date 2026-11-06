# DataFlow

DataFlow is an extension for Visual Studio Code. It shows the data flow and the logic of C++ code in a side view beside the text editor. A Clang engine analyzes the code with the compile commands of your project. A language model, for example Claude, can use the same data to explain the code in the side view.

![The text editor at the left and the side view of DataFlow at the right. The side view shows the blocks, the notes and the comments of a language model, a path of Logic Map and a trace of Flow Lens.](docs/images/overview.png)

## Overview

The side view shows the file of the active C++ editor with the colors of your theme. Each lens adds its data to the code:

| Lens | What the lens shows |
| --- | --- |
| Flow Lens | Where the value of a variable or a data member comes from, and where it goes |
| Logic Map | One path through a function, with its events, returns, changes and warnings |
| Hidden C++ | The operations that the compiler adds, for example copies, conversions and destructors |
| Include Hierarchy | The lines that each include adds, the includes that the file possibly does not use, and the includes that forward declarations can replace |
| Call Hierarchy | The callers and the called functions, with the data of each call |
| Threads and races | The code that runs on a different thread, the shared data, and the protection of each access |
| Change Ripple | The code that the changes of your branch affect, as a story for a review |

DataFlow also has an MCP server. A language model reads the facts of the engine through the tools of the server. Then the model shows logical blocks, notes, comments and details in the side view. The engine gives the lines and the data, and the model adds the words. In a guided review, the model goes through the files that you name with you, one step after the other.

DataFlow works on Windows 64-bit with VS Code 1.120 or later. Your project needs a compile database, for example the `compile_commands.json` file of CMake or a qmake build folder. For an Unreal Engine 5 project, DataFlow makes the compile database with UnrealBuildTool.

## Quickstart with Claude Code

1. Download the VSIX file of the [latest release](https://github.com/KnurrliDev/DataFlow/releases/latest). In VS Code, install it with **Extensions: Install from VSIX…**. [Install DataFlow](docs/install.md) also tells how to build DataFlow from the source code.
2. Install the Claude Code extension in VS Code.
3. Open the folder of a C++ project with a compile database.
4. Open a C++ file. DataFlow starts and asks if it can connect to Claude Code. Click **Connect**.
   If DataFlow does not ask, run **DataFlow: Connect to Claude Code**.
5. Click **DataFlow: Open Side View** in the title bar of the editor.
6. Start a new session in the panel of Claude Code.
7. Ask Claude about a function, for example: "Explain process() in logical blocks, and show me what happens to charge.is_dirty."

Claude reads the analysis of the engine. Then it shows its blocks, notes and comments in the side view next to the code. [Use the MCP tools](docs/tools.md) tells more about the connection and the tools.

## Showcase

The screenshots show the test project of DataFlow: the controller of a home battery.

### Flow Lens

Flow Lens traces a variable. The rails connect each definition to the uses that it reaches. A red dashed box shows a problem, here an optional that the code reads with no check. [Use Flow Lens](docs/usage.md#flow-lens)

![Flow Lens traces bestFit. A card shows that line 46 reads the optional with no check.](docs/images/flow-lens.png)

Flow Lens also traces a data member of a class. The details column shows the threads and the locks of each access, and a possible race.

![Flow Lens traces the data member is_dirty. The details column shows a possible race between two threads.](docs/images/flow-lens-member.png)

### Logic Map

Logic Map shows one path through a function. Select an option for each decision in the trail. The path shows its events, returns and changes, and a warning for a pointer that can be null. [Use Logic Map](docs/usage.md#logic-map)

![Logic Map shows the path through the planning state, with the trail of the decisions in the details column.](docs/images/logic-map.png)

### Hidden C++

Hidden C++ shows the operations that the compiler adds: copies, conversions, temporaries, destructors, allocations, repeated lookups and hidden state. Curves connect the lookups of the same key. [Use Hidden C++](docs/usage.md#hidden-c)

![Hidden C++ shows chips after the code, and a card with five lookups of the same key.](docs/images/hidden-cpp.png)

### Include Hierarchy

Include Hierarchy shows the lines that each include adds after the preprocessor. The tree shows the includes and the path that brings a header into the file. It also shows the includes that forward declarations can replace. [Use Include Hierarchy](docs/usage.md#include-hierarchy)

![Include Hierarchy shows the lines of each include, the tree of the includes and the path to vector.](docs/images/include-hierarchy.png)

### Call Hierarchy

Call Hierarchy shows the callers and the called functions. Each call shows its data: the written arguments, the checked results, the async calls and the events. [Use Call Hierarchy](docs/usage.md#call-hierarchy)

![The call graph of process() over the code, and the tab Calls in the details column.](docs/images/call-hierarchy.png)

To see all calls of a function, right-click its name, and click **Show Calls**. Click a call in the list to go to it.

![The list of the calls of fire_transition().](docs/images/show-calls.png)

### Threads and races

Threads and races shows the code that runs on a worker thread, the data that two threads share, and a verdict for each item. The two lanes show the accesses of each thread in sequence. [Use Threads and races](docs/usage.md#threads-and-races)

![Threads and races shows a race on is_dirty, with boxes in the code and the accesses of the two threads.](docs/images/threads.png)

### Change Ripple

Change Ripple shows the code that the changes of your branch affect. The story follows a changed line through the functions, the lambdas and the async calls. [Use Change Ripple](docs/usage.md#change-ripple)

![Change Ripple shows the diff of a changed limit, and a card for each function that the change affects.](docs/images/change-ripple.png)

### MCP tools

The view tools of the MCP server put the words of the model into the side view. [Use the MCP tools](docs/tools.md#the-tools)

`show_blocks` shows the logical blocks of a function, with a maximum of five levels. The tab Model lists the summary of each block, and the data that goes in and comes out.

![Logical blocks with their titles next to the code, and the tab Model with the summaries.](docs/images/model-blocks.png)

`highlight` colors lines and adds a note: red for a problem, orange for a warning and pink for information.

![A red note on line 92 and an orange note on lines 94 to 96.](docs/images/model-notes.png)

`comment_lines` adds a short comment to single lines, with a color for each topic.

![Comments in different colors after the code.](docs/images/model-comments.png)

`add_detail` adds a longer explanation or examples to an expression. To see the card, move the mouse on the symbol **i** at the end of the line.

![A card with examples for the expression FINISHED(...).](docs/images/model-detail.png)

`show_flow` starts Flow Lens on a variable, as a click does. The screenshot at the top shows such a trace. `clear` removes the layers of the model. The read tools give the data of the lenses to the model: `get_view`, `list_functions`, `get_structure`, `get_flow`, `get_calls`, `get_threads`, `get_hidden` and `get_includes`.

### Guided review

Name the files or the folders to review, for example "Do a guided review of src/power". The model makes a plan of steps with `get_review` and `show_review_plan`. The side view shows one step after the other: its lines in the code, what to look at, and the questions to answer. Mark each step as OK, issue or question, and ask the model about it. With `review_step`, the model goes to a step and adds its answer or a finding. [Guided review](docs/tools.md#guided-review)

![A guided review at step 4 of 4: the lines of the step in the code, the plan in the tab Guide with the marks, and a note of the model on an issue.](docs/images/guided-review.png)

## Documents

- [Install DataFlow](docs/install.md): the VSIX package, the build from the source code, and the first start
- [Use DataFlow](docs/usage.md): the side view, each lens, the commands and the settings
- [Use the MCP tools](docs/tools.md): the connection to Claude Code and to other clients, and each tool with its parameters
- [Develop DataFlow](docs/development.md): the files, the debugger, the tests, the screenshots and the releases
- [Changelog](CHANGELOG.md): the changes of each release

## License

DataFlow has the MIT License. See [LICENSE](LICENSE).
