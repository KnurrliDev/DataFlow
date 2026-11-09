# Changelog

## Unreleased

- Diff walk: the side view goes through the changes of a diff, one step after the other. The changes are the changes that are not committed, the changes against a branch, or the changes since a commit. The C and C++ files that git does not track yet are new files.
- The code view marks the added lines of the current step in green, with the changed characters. A red line marks the place of removed lines. A card shows the removed lines. The tab Guide shows the diff of each step, and **Diff editor** opens the diff editor of VS Code at the step.
- The command **DataFlow: Walk Through the Changes** makes one step for each changed function. For the changes against a different branch, it shows a list of the local and the remote branches.
- The MCP server has the new tools `get_diff` and `show_diff_walk`, and the prompt `diff-walk`. The model puts the changes in a sequence, and tells what changed and why. `review_step` also goes to a step of a diff walk.
- The commands of the guide have new names: **DataFlow: Next Guide Step**, **DataFlow: Previous Guide Step**, **DataFlow: Copy Guide Summary** and **DataFlow: Close Guide**.

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
