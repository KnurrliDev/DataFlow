# P2 notes

- Date: 26 October 2026
- Status: P2 is complete. Acceptance scenario 1 passed on the CMake fixture.
- Plan: [implementation-strategy.md](implementation-strategy.md), sections 7.1 and 11

## Result

Flow Lens shows where the value of a variable comes from and where it goes. On `bestFit` in `initial_power()`, the lens marks line 46 of the fixture as an unchecked optional access.

| Check | Result |
| --- | --- |
| Unit tests: rails, Flow Lens, qmake Makefile reader, extension | 16 passed |
| P1 exit checks on the CMake fixture and on the qmake fixture | Passed |
| Acceptance scenario 1, and the tests for edits, follow mode and Clear Trace | 4 passed |
| Engine protocol tests | 9 passed |
| Screenshots in VS Code, dark theme and light theme | The marks, the rails, the pulse, the hint and the panel are correct. |

## What Flow Lens shows

| Item | Description |
| --- | --- |
| Box around the name, bold name | A definition or a write |
| Dashed box around the name | A possible write: a call of a non-const member function, a non-const reference, or a write to a member |
| Green line below the name | A check: a read in a condition |
| Blue line below the name | A read |
| Red dashed line and red background | A use with a finding |
| Hint at the end of the line | The text of the finding, for example "bestFit: optional not checked here" |
| Rail in the gutter | Connects a definition or a write with the uses that it reaches. The rail starts with a large dot. |
| Ring on a rail | A possible write. The old value stays, so the rail continues after the ring. |
| Red dashed part of a rail | The part that goes to a use with a finding |
| Marks in the overview ruler | All references of the variable. The findings are in the right lane. |

The gutter has 3 slots for rails. Rails that do not share a line can use the same slot. A rail with a finding gets a slot first. If a variable has more rails, the panel tells the user.

When the user traces a new variable, a dot moves down each rail one time. This takes 650 ms, or a maximum of 80 ms for each line on a short rail. The setting `dataflow.animations` and the setting `workbench.reduceMotion` can stop the animation.

## Contents of P2

### Engine

| File | Function |
| --- | --- |
| `flow.hpp` | The variables of a function, the references with their roles, the reaching definitions, and the optional findings |
| `server.hpp` | The request `dataflow/flow`. [engine/README.md](../engine/README.md) describes the result. |

- Roles: `ExprMutationAnalyzer` of Clang finds the changes. An assignment, an increment or a decrement is a write. All other changes are possible writes.
- Reaching definitions: a bit-vector analysis on the CFG. A write stops the old definitions. A possible write does not stop them.
- Findings: `UncheckedOptionalAccessModel` of the dataflow framework of Clang.
- A name in a macro argument gets the position where the argument is written, not the position of the macro.

`ExprMutationAnalyzer` reports each call of a non-const member function as a change. Flow Lens then shows reads as possible writes. The engine changes these cases to reads:

- `->`, `*` and `[]`, and the accessors `value`, `get`, `front`, `back`, `at` and `data`, if the code only reads through the result
- the format functions of the standard library, for example `std::format` and `std::print`. They take forwarding references.
- a `return` statement that returns a copy of the variable

### Extension

| Module | Function |
| --- | --- |
| `lenses/flow.ts` | Makes the marks, the rails and the panel data from the flow model. Changes the UTF-8 columns of the engine to the UTF-16 columns of VS Code. It does not use the VS Code API, so the unit tests can call it. |
| `render/overlay.ts` | Draws the token marks, the hints and the marks in the overview ruler. Puts the scope rail and the rails of Flow Lens into one icon for each line. Lines with the same icon share one decoration type. |
| `render/rails.ts` | Lines, dots, rings and pulses in the SVG icons |
| `extension.ts` | The commands, follow mode, the cache of the last flow model, and the update of the trace after an edit |
| `webview/panel.ts` | The Flow section of the DataFlow view |

| Command or setting | Function |
| --- | --- |
| `DataFlow: Trace Variable`, Ctrl+Alt+F | Traces the variable at the cursor. If no variable is at the cursor, the command removes the trace. The editor context menu also has this command. |
| `DataFlow: Clear Trace` | Removes the trace. |
| `DataFlow: Toggle Follow Cursor` | Sets follow mode on or off. |
| `dataflow.flow.followCursor` | Follow mode. When the cursor stops for 300 ms, Flow Lens traces the variable at the cursor. The default is off. |
| Theme color `dataflow.problemBackground` | The background of a use with a finding |

After an edit, the extension gets the flow of the function again. It finds the variable by its name and by its position among the variables with the same name. If the variable is not there, the extension removes the trace.

## Numbers

| Measurement | Value | Budget in the strategy |
| --- | --- | --- |
| First flow analysis of `initial_power` after a parse | 160 ms to 225 ms | less than 100 ms for a lens update |
| Next flow analyses of the same parse | 29 ms | less than 100 ms |
| Trace of a second variable of the same function | 6 ms, from the cache of the extension | less than 100 ms |

The first flow analysis after a parse is slower than the budget. The cause is not known yet. P6 examines it with the other budgets.

## Changes from the strategy

1. A possible write gets no rail of its own. Rails for possible writes give many parallel rails to the same uses, for example 6 rails for `startPlans`. One rail with rings is easier to read.
2. Follow mode is a setting with a check box in the panel. The default is off.
3. The scope rail moved to the left side of the icon, to make space for 3 slots of Flow Lens.

## Repairs to P1

- The qmake exit check failed in a new test run. The fixture script wrote the compile database for the engine tests into `build-qmake/`. This database was newer than `Makefile.Release`, so the extension used it and did not read the Makefile. Now the script writes this database to `build/fixtures/battery-qmake/` and removes the old file.
- The high contrast light theme used the SVG colors of the dark high contrast theme. The yellow scope rail was difficult to see on white. This theme now has its own colors.
- The top-level README described only the Hello World command. It now describes Flow Lens, the files and the tests.

## Limits

- Flow Lens tracks a variable as one unit. A write to a member is a possible write of the variable.
- A use in the body of a lambda gets a mark, but no dot on a rail. The CFG of the function does not contain the body of a lambda. A write in a lambda does not stop the old definitions.
- SVG icons cannot read theme colors. A change of the DataFlow colors in `workbench.colorCustomizations` changes the marks, but not the rails.
- After an edit, the extension finds the function by its qualified name. If two overloads have the same name, it can select the wrong function.
- The lists of accessors and format functions in `flow.hpp` are fixed. Other functions that only read through a non-const reference show as possible writes.
- The engine does not keep the flow model. The extension keeps only the last model.

## How to do the tests

1. Build the engine. See [engine/README.md](../engine/README.md).
2. Run `npm test`. This runs the unit tests, the exit checks of P1 and the acceptance tests of P2.
3. Run `npm run test:engine`. This runs the engine protocol tests.
4. To make screenshots of Flow Lens in the test build of VS Code, run `node spikes/ui/flow-snapshot.mjs <folder> dark`. Use `light` for the light theme. The script stops VS Code at the end.

## Next phase

P3 adds the Logic Map: the decisions of a function, path evaluation, dimmed lines that the path cannot reach, the path walk, and "why does this line run".
