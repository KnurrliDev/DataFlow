# P3 notes

- Date: 26 October 2026
- Status: P3 is complete. Acceptance scenario 2 passed on the CMake fixture.
- Plan: [implementation-strategy.md](implementation-strategy.md), sections 7.2 and 11
- Open issues: [TODO.md](../TODO.md)

## Result

Logic Map shows what a function does for the values that the user selects. In `process()` of the fixture, the two parts of acceptance scenario 2 give the expected result:

| Choices | Result |
| --- | --- |
| `METER_READING`, new readings found, timeout | The events `_measured` and `_timeout` are on the path. The warning for two events on one path shows. |
| `CHARGE_PLANNING`, converged, `POWER_AUTO` | The warning for the null pointer shows on line 105. |

| Check | Result |
| --- | --- |
| Unit tests: rails, Flow Lens, Logic Map paths, qmake Makefile reader, extension | 22 passed |
| P1 exit checks, and the acceptance tests of P2 and P3 on the fixtures | 10 passed |
| Engine protocol tests | 10 passed |
| Screenshots in VS Code, dark theme and light theme | The dimmed lines, the events, the warnings, the path walk and the panel are correct. |

## What Logic Map shows

| Item | Description |
| --- | --- |
| Dimmed line | The path cannot reach the line. Lines in a branch that the path cannot enter are dimmed with their braces and comments. |
| Box around a string literal | An event on the path, for example `fire_transition(home_battery_ctl, "_measured")` |
| Red hint at the end of a line | A problem on the path: two events on one path, or a pointer that can be null |
| Red mark on an expression | A dereference of a pointer that can be null |
| Highlight that moves down | The path walk. It moves down the lines of the path after each new choice. |

The panel shows:

- the number of lines that cannot run, with the buttons "Walk the path" and "Reset"
- the events on the path, and the warnings. A click opens the line.
- why the line at the cursor runs: the decisions and the values that the line needs, with the button "Use these choices"
- the decision outline. An `if` and a conditional operator have the options any, yes and no. A loop has any, enter and skip. A `do` loop has any, repeat and once. A `switch` and an else-if chain that compares one value have a list with one option for each value.

## Contents of P3

### Engine

| File | Function |
| --- | --- |
| `logic.hpp` | The blocks of the CFG with their lines, the decisions with their branches and their parent decisions, the else-if chains, the events, and the pointers from nullable functions |
| `server.hpp` | The request `dataflow/logic`. [engine/README.md](../engine/README.md) describes the result. |

- The CFG has each expression as an element, so each call has a block.
- An edge that the CFG marks as unreachable is -1. A decision with such an edge has a constant condition, so it is not a decision for the user.
- The blocks of `&&` and `||` in a condition belong to the decision of the condition. A choice for the decision also removes their edges. For example, "no" for `if (a && b)` removes the edge from `a` to the body.
- An else-if chain needs 2 or more items that compare the same value with a constant with `==`.
- An event is a call of a function in `eventFunctions` with a string literal argument that is not empty. `fire_transition(home_battery_ctl, "", true)` is not an event.
- A null check is a condition of the form `p`, `!p`, `p != nullptr` or `p == nullptr`, also as the left side of `&&` and `||`.

### Extension

| Module | Function |
| --- | --- |
| `logic/paths.ts` | The outline, the choices, the path, the dimmed lines, the warnings, and why a line runs. Pure functions with unit tests. |
| `lenses/logic.ts` | The data for the overlay and the panel |
| `render/overlay.ts` | The dimmed lines, the event boxes, the problem marks, the hints and the path walk |
| `webview/panel.ts` | The Logic Map section of the DataFlow view |
| `extension.ts` | The requests to the engine, the choices of each function, the commands, and the update after an edit |

| Command or setting | Function |
| --- | --- |
| `DataFlow: Toggle Logic Map` | Turns Logic Map on or off. |
| `DataFlow: Why Does This Line Run` | Turns Logic Map on and shows why the line at the cursor runs. The editor context menu also has this command. |
| `DataFlow: Reset Logic Map Choices` | Sets all decisions to "any". |
| `dataflow.logic.eventFunctions` | The functions that send events. The default is an empty list. |
| `dataflow.logic.nullableFunctions` | The functions that can return a null pointer. The default is an empty list. |
| Theme color `dataflow.path` | The background of the path walk |

The fixture folder sets `fire_transition` as the event function and `get_if` as the nullable function in `.vscode/settings.json`.

### The path

- A choice removes the edges from the decision block and its condition blocks to the other branches.
- "enter" and "repeat" remove no edge, because the loop also ends. "skip" removes the edge to the body, and "once" removes the edge back to the body.
- A value of a chain sets "no" for the items before it and "yes" for its item. "other" sets "no" for all items.
- Two events are on one path if the block of the second event follows the block of the first event.
- A pointer can be null at a dereference if a path from the assignment reaches the dereference with no edge of a null check.

### Why a line runs

The first method used control dependence. It gave wrong results for a line after a join. For example, `return requests;` got the conditions of the early returns in all states. Control dependence tells which decision controls a block, but a join has many such decisions on different paths.

The method now uses dominators. A decision on each path to the line needs a value if only one branch can reach the line, with no new pass through the decision. A loop needs only "enter": a line after a loop runs also if the body runs. If a line has more than one block, it needs only the values that all its blocks need.

## Numbers

| Measurement | Value | Budget in the strategy |
| --- | --- | --- |
| Logic analysis of `process()`, the first time after a parse | 64 ms | less than 100 ms for a lens update |
| Logic analysis of `process()`, then | 2 ms to 3 ms | less than 100 ms |
| Path evaluation for a new choice, in the extension | 0.04 ms | less than 100 ms |
| Why a line runs, for one line | 0.06 ms | none |

The logic analysis uses no AST matchers, so it is much faster than the flow analysis of P2.

## Changes from the strategy

1. Why a line runs uses dominators in the extension, not `CFGPostDomTree` in the engine. See "Why a line runs" above.
2. The path walk highlights the lines of the path. A long path has more lines in each step, so the walk takes a maximum of 25 steps of 120 ms.
3. The warning for a null pointer needs the setting `dataflow.logic.nullableFunctions`. The default is empty, as in the strategy.

## Limits

[TODO.md](../TODO.md) lists these limits with the other open issues.

- Decisions in the body of a lambda are not in the outline. The CFG of the function does not contain the body of a lambda.
- An event needs a string literal. A label from a constant or a variable is not an event.
- The null checks are only the four forms above. A check in a helper function, for example `if (is_valid(p))`, is not a null check. Smart pointers and `std::optional` are not nullable pointers.
- An event in a loop body is not a pair with itself, so two runs of the same event do not give a warning.
- A switch case that other cases can reach through fallthrough does not show in the why-list.
- The key of a choice contains the text of the condition. An edit of the condition removes its choice.
- A whole-line decoration cannot dim a part of a line. A line with a live statement and dead code stays bright. A line such as `} else {` after a live branch is dimmed, because a brace is not a statement.

## How to do the tests

1. Build the engine. See [engine/README.md](../engine/README.md).
2. Run `npm test`. This runs the unit tests, the exit checks of P1 and the acceptance tests of P2 and P3.
3. Run `npm run test:engine`. This runs the engine protocol tests.
4. To make screenshots of Logic Map in the test build of VS Code, run `node spikes/ui/logic-snapshot.mjs <folder> dark`. Use `light` for the light theme. The script uses the panel as a user does, and it stops VS Code at the end.

## Next phase

P4 adds Hidden C++: implicit operations, lookups, destructors, categories, rules against noise, and "Not useful".
