# Changelog

## Unreleased

- Go to a definition in the side view: Ctrl+click on a name, or F12, goes to its definition. The side view moves, and the text editor stays at its place. Ctrl+click on the file of an `#include` shows the header.
- Back and Forward of the side view: Alt+Left and Alt+Right, or the mouse buttons, go through the jumps of the side view.
- The engine has the new request `dataflow/definition`. It finds the definition of a name, a macro or the file of an include, if the definition providers of VS Code find none.

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
