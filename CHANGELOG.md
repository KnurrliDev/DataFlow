# Changelog

## Unreleased

- Guided review: name the files and the folders to review, and a language model makes a plan of steps. The side view shows one step after the other, with its lines, its text and its questions. Mark each step as OK, issue or question, and copy a summary of the review.
- The MCP server has the new tools `get_review`, `show_review_plan` and `review_step`, and the prompt `guided-review`.
- The commands **DataFlow: Next Review Step**, **DataFlow: Previous Review Step**, **DataFlow: Copy Review Summary** and **DataFlow: Close Guided Review**, and the theme color `dataflow.reviewGuide`.

## 0.1.0

The first release of DataFlow. The VSIX package is for Windows x64, and it contains the engine.

- The side view shows the file of the active C++ editor beside the editor, with the colors of your color theme.
- The lenses: Flow Lens, Logic Map, Hidden C++, Include Hierarchy, Call Hierarchy, Threads and races, and Change Ripple.
- The MCP server gives the data of the engine to a language model. The view tools show the logical blocks, the notes, the comments and the details of the model in the side view.
- The command **DataFlow: Connect to Claude Code** connects Claude Code with no MCP setup.
- The engine on Clang 23 reads the compile databases of CMake, qmake and Qt Creator.
