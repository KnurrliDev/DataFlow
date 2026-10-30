# P5 notes

- Date: 26 October 2026
- Status: P5 is complete. Acceptance scenario 4 passed on the review fixture, a git copy of the CMake fixture.
- Plan: [implementation-strategy.md](implementation-strategy.md), sections 7.4 and 11
- Open issues: [TODO.md](../TODO.md)

## Result

Change Ripple shows the code that the changes of a branch affect. The review fixture has two branches. The branch `review` changes the threshold in `solve_power_plan()` from `1e-5` to `1e-4`. The base is the branch `main`. For this change, the ripple has these steps:

| Line in the fixture | Code | Step |
| --- | --- | --- |
| 69 | `if (cost < 1e-4) {` | The change |
| 70 | `res = cost;` | Control, exact |
| 77 | `return res;` | Data, exact. The return value goes to the callers. |
| 95 | `executor.async([&]() { return solve_power_plan(charge); })` | The caller in the lambda, then the async call. The result goes into the field `charging_future`. |
| 102 | `auto converged = home_battery_ctl.charging_future->get();` | Data, estimated |
| 104 | `if (converged) {` | Data and control, estimated |
| 109 | `requests = make_requests(...);` | Control, estimated. `return requests;` on line 169 is an exit. |

With a call hierarchy provider, the ripple also gets to `main()` in `main.cpp`, two caller levels from the change. The test uses a provider of the test. A manual check with a copy of cpptools 1.34.4 in the test build of VS Code gave the same caller.

| Check | Result |
| --- | --- |
| Unit tests | 33 passed, 5 of them for Change Ripple |
| P1 exit checks, the acceptance tests of P2, P3 and P4, and the qmake check | 14 passed |
| Acceptance test of P5 on the review fixture | 3 passed |
| Engine protocol tests | 14 passed, 2 of them for the slice |
| Screenshots in VS Code, dark theme and light theme | The border of the change, the wave, the background of the lines, the hints, the panel and the diff editor are correct. |
| cpptools 1.34.4 in the test build | The call hierarchy of cpptools gives the caller in `main.cpp`. |

## What Change Ripple shows

**DataFlow: Review Changes** compares the files with the merge base of `HEAD` and the base branch. The comparison includes the changes that are not committed. For each C or C++ file, the engine slices the changed lines. Then the extension follows each return value to the callers, to a maximum of 2 levels.

In the editor:

- A changed line has a border on the left, in the color of writes.
- A wave moves from the changed lines to the lines that the changes affect, one step each 400 ms. A step is one dependence. A long ripple has more dependences in each step, to a maximum of 20 steps.
- After the wave, the affected lines have a purple background. An estimated line has a lighter background.
- A hint at the end of a line shows an async call, a field that later calls read, or the number of callers of a return.
- The overview ruler shows the changed lines and the affected lines.
- The diff editor shows the ripple on the side of the branch. The **Diff** link in the panel opens it.

In the DataFlow view, each changed function has the number of functions, async boundaries and exits that it affects. Below it are the functions and the lambdas of the ripple, with their steps and exits. A caller has an indent for each level. A click on a line opens it.

Each step has a confidence: exact for a dependence in the changed function, call for a step in a caller, and estimated for a step through a field in a later call or through an async call. [engine/README.md](../engine/README.md) gives the kinds of steps and exits.

## Rules for a useful slice

The first slice of `process()` contained most of the function. These rules come from that result:

| Rule | Reason |
| --- | --- |
| The values are variables and `this`, with a path of up to 3 fields. | A write to `home_battery_ctl.charging_future` does not affect the reads of `home_battery_ctl.state`. |
| A write to a field reaches a use of the whole object only if the use copies the object. | Each `fire_transition(home_battery_ctl, ...)` gets the object by reference. Without this rule, all calls of `fire_transition` were in the slice. |
| A possible write to a whole persistent object, for example a call with a reference argument, is an exit. | The engine does not know what the call changes. If the slice follows the object, all later code of the function is in the slice. |
| A step from one expression changes only the writes that get the value of the expression. A changed line or a decision changes all writes of the statement. | `return solve_power_plan(charge);` changes the return value, not `charge`. |
| A capture by reference, and the binding of a local reference, are not writes. | The mutation analyzer of Clang reports them as writes. The slice follows the lambda and the reference instead. |
| A chain of steps follows a maximum of one jump to the reads of a field in a later call. | A jump gives estimated steps. A second jump gives steps with little relation to the change. |

## Contents of P5

### Engine

| File | Function |
| --- | --- |
| `slice.hpp` | The forward slice: bodies, statements, values with fields, accesses, reaching definitions, control dependence, the exits, the lambdas and the async calls |
| `server.hpp` | The request `dataflow/slice` |
| `analysis.hpp` | `nameAt` in the data of a function, for the call hierarchy |

Control dependence comes from `ControlDependencyCalculator` of Clang. The reaching definitions use the same method as Flow Lens, with values that have fields.

### Extension

| Module | Function |
| --- | --- |
| `review/git.ts` | The merge base, the changed files and the diff of each file, through the git extension of VS Code. The diff parser is a pure function. |
| `review/ripple.ts` | The pipeline: the slice of each change, the callers of each return value, and the slices of the callers. The tests give fakes for the engine and the call hierarchy. |
| `lenses/ripple.ts` | The lines, the waves and the hints of each file, and the panel data. Pure functions. |
| `render/overlay.ts` | The decorations of the changed and affected lines, the wave and the hints |
| `webview/panel.ts` | The Change Ripple section of the DataFlow view |
| `extension.ts` | The review, the call hierarchy of VS Code, the diff editor and the commands |

| Command or setting | Function |
| --- | --- |
| `DataFlow: Review Changes` | Compares the files with the base and shows the ripple. |
| `DataFlow: Clear Review` | Removes the ripple. |
| `dataflow.ripple.baseRef` | The base branch. The default is `origin/main`. If it does not exist, Change Ripple uses `main`. |
| `dataflow.ripple.maxDepth` | The number of caller levels. The default is 2. |
| `dataflow.ripple.asyncFunctions` | The async functions. The default is `std::async`, `QtConcurrent::run` and `tf::Executor::async`. |

The theme colors `dataflow.ripple`, `dataflow.rippleEstimated` and `dataflow.rippleWave` are new.

### Fixture and tests

- `process()` has the async call of line 628 of the example, and `types.hpp` has a stub of `tf::Executor`. The lines after line 93 of `battery.cpp` moved down by 4 lines. The warning of scenario 2 is now on line 109, not line 105.
- `src/main.cpp` calls `process()`. It gives a caller in a different file.
- `scripts/prepare-fixtures.mjs` makes `build/fixtures/battery-review`: a git repository with the branches `main` and `review`, and a compile database in `build/`.
- The test configuration `review` of `.vscode-test.mjs` opens this repository.

## Numbers

| Measurement | Time |
| --- | --- |
| Review of the fixture in VS Code, with the git calls and 2 caller levels | 1.3 s. The budget is 3 s. |
| Slice of line 69 in the fixture, the first after a parse | 214 ms |
| Slice of the caller of `solve_power_plan()` | 56 ms |
| Slice of one line in TBT `compiler.hpp` and `tests.cpp` | 36 ms and 81 ms |
| Slice of all lines in TBT `compiler.hpp` | 1019 ms, then 256 ms |
| Slice of all lines in TBT `tests.cpp` | 5.7 s, then 4.5 s |

The slice of all lines is the worst case, for example a new file. The engine builds the model of each body again for each request. [TODO.md](../TODO.md) has this issue.

## Changes from the strategy

1. A deleted block brings the later uses of the variables that its old text writes. The strategy maps a deleted line to the next statement. But the next statement often has no relation to the deleted code. For example, when the change deletes `res = cost;`, the next statements are `break;` and `opt.last_cost = cost;`. The correct seed is `return res;`.
2. The engine finds the callers in the same file. The call hierarchy of the editor adds the callers in other files. The strategy says that Change Ripple stays in one function if no call hierarchy provider is active. Now it stays in one file.
3. The slice tracks fields, not only whole variables. Section [Rules for a useful slice](#rules-for-a-useful-slice) gives the other rules.
4. The request `dataflow/slice` gives only forward slices. Change Ripple does not need backward slices.
5. If the base ref `origin/main` does not exist, Change Ripple uses `main`. A repository with no remote has no `origin/main`.

## Limits

- The engine does not know what a called function changes. A call with a reference argument is an exit, and a statement that a decision controls has no exit for its calls.
- Only references to persistent objects are aliases. A write through a reference or a pointer to a local variable does not reach the uses of that variable.
- The slice enters a lambda body only from a changed line or a call in the body. A call of a lambda variable, as in `f()`, does not enter the lambda.
- A changed line outside of a function, for example in a type or a global variable, gets no ripple. A changed line in the member initializer list of a constructor has no statement.
- The rule for deleted blocks is a heuristic. A deleted condition, for example `if (x) {`, brings the later uses of `x`, not the statements that it controlled.
- A call in a template to a dependent function is not a caller.
- The review does not update after an edit. Run it again.
- `git diff` does not show untracked files. A new file in a commit has all its lines as changes.
- The engine builds the model of each body again for each request.
- The panel shows a maximum of 40 steps for each body.

## How to do the tests

1. Build the engine. See [engine/README.md](../engine/README.md).
2. Run `npm test`. This runs the unit tests, the exit checks of P1, and the acceptance tests of P2 to P5. The `pretest` script makes the review fixture.
3. Run `npm run test:engine`. This runs the engine protocol tests.
4. To make screenshots of Change Ripple in the test build of VS Code, run `npm run pretest`. Then run `node spikes/ui/ripple-snapshot.mjs <folder> dark`. Use `light` for the light theme.

## Next phase

P6 makes the release: the performance budgets, the error states, the user documentation, a VSIX for each platform, and a beta on real code.
