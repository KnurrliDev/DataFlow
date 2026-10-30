# S5 notes

- Date: 27 October 2026
- Status: phase S5 of the side view is complete. Acceptance scenario 4 passes in the side view.
- Plan: [side-view-strategy.md](side-view-strategy.md), section 7
- Open issues: [TODO.md](../TODO.md)

## Result

With `dataflow.view` set to `side`, a review shows a story of each change in the side view, as the Change Ripple of the prototype in the design study. The text editor shows no marks of Change Ripple. The story has the diff of the change, the facts of the ripple, and a chain of code cards with one card for each function or lambda of the ripple.

| Exit criterion | Result |
| --- | --- |
| Acceptance scenario 4 passes in the side view. | Passed. For the change from `1e-5` to `1e-4` on line 69 of the review fixture, the story has three cards. The card of `solve_power_plan()` has lines 69, 70 and 77. The card of the lambda in `process()` has the call on line 95. The card of `process()` has the async call on line 95, and lines 102, 104 and 109. |
| With a call hierarchy provider, the story shows the caller in `main.cpp`. | Passed. The story has a fourth card for `main()` in `main.cpp`, two caller levels from the change. Its arrow is "process() returns to main(), main.cpp:10". The card has the lines `auto requests = `, `if (requests)`, `sent += requests->count` and `return sent`. |

| Check | Result |
| --- | --- |
| Unit tests | 61 passed. 6 are new for the story: the hunks of a diff, the lexer of the old lines, the story, the lines for the tokens, a review that runs or fails, and the ripple in the file view. |
| Fixture tests of P1 to P4 and of the side view | 33 passed. Phase S5 did not change them. |
| qmake fixture and review fixture | 8 passed: 1 for qmake, 3 for P5 and 4 new for the story |
| Engine protocol tests | 17 passed. Phase S5 did not change the engine. |

## What the side view shows

- **Story mode:** a review in the side mode opens the side view, and the side view shows the story. The toolbar shows "Review of the changes". The bars of Flow Lens, Logic Map and Hidden C++ and the details column do not show in the story.
- **Change Ripple bar:** under the toolbar. It has **File view** or **Story**, the base of the review, **Review again** and **Clear**. If the review has more than one changed function, a list selects the change of the story. In a narrow side view, the text of the bar gets shorter, and the buttons stay on one line.
- **Diff:** the hunks of the diff with a changed line in the function, with their lines of context. A removed line has the colors of the diff editor of VS Code, and its line in the base. The changed characters of a pair of a removed line and an added line have a darker background. **Open the diff editor** opens the diff editor in the group of the text editor.
- **Facts:** the number of changed lines, functions, files, async boundaries, steps and exits, as the pills of the prototype.
- **Chain "Where the change goes":** one card for each function and each lambda of the ripple, in the sequence of the ripple. A line at the left connects the cards. Each card has a dot on this line.
- **Card:** the name of the function or of the lambda, the file and the line, and badges: "changed" for the card of the change, "caller" for a caller, and "estimated" if all lines of the card are estimated. An estimated card has a dashed border. The card shows the lines of the steps with the tokens of the engine. A gap of a maximum of 2 lines shows as lines of context. A larger gap shows as "⋯ n lines". The changed line has a bar in the color of writes, and its changed characters have a mark.
- **Notes:** a note after the code of a line tells why the line is in the ripple, for example "changed", "runs on a branch of line 69", "reads res", "async call: tf::Executor::async" or "returns to 1 caller". A line with the same note as the line before it has no note. The title of each line has its note.
- **Arrows:** an arrow on the line of the chain connects two cards. Its text tells how the change goes to the next card: a return to a caller, a lambda, or an async call. For the async call of the fixture: "async call: tf::Executor::async. The value comes back through home_battery_ctl.charging_future."
- **Exits:** the badges at the end of a card, after "Leaves the card". An exit is a point where the ripple leaves the analysis, for example "return requests" or "can change settings". A click on a badge opens its line.
- **Wave:** the wave lights the lines and the cards in the sequence of the ripple. The first step lights after 250 ms, and each next step after 420 ms, as in the prototype. A long ripple has more steps of the ripple in each step of the wave, to a maximum of 20 steps. The front of the wave is brighter. **Replay ripple** plays the wave again. With the setting `dataflow.animations` off, or with reduced motion, all lines are lit at once.
- **Click:** a click on a line, on the name of a card or on a line of the diff shows the file view at the line, and the text editor goes to the line. The focus stays in the side view. **Story** in the bar goes back to the story.
- **File view:** the lines that the changes reach have a light background in the color of the ripple, with no alpha. An estimated line has a lighter background. A changed line has a bar next to its line number. The hints of the editor mode come after the code: an async call, a field that later calls read, and the number of callers of a return.
- **Layout:** a side view that is wider than 900 px shows the diff and the facts at the left, and the chain at the right, as the prototype. A narrower side view shows them one after the other.

## Contents of S5

### Extension

| File | Change |
| --- | --- |
| `review/git.ts` | `diffHunks`: the hunks of a unified diff with the lines of the base and of the working tree. `reviewDiff` keeps the hunks of each file. |
| `review/ripple.ts` | Each body of a caller has the call that it comes from, so the story knows the bodies of one call. |
| `side/storyLayer.ts` | New. Makes the story of each change: the rows of the diff, the cards with their rows, notes, exits and arrows, the facts and the steps of the wave. Also makes the ripple of a file for the file view. |
| `side/model.ts` | `lexSpans`: a small lexer for a line with no tokens of the engine, for example a line of the base. `pairedSpans`: the spans of an old line from the spans of the new line that replaces it. |
| `side/protocol.d.ts` | The messages `story` and `ripple`, the types of the story, the mode of the side view, and the actions of Change Ripple |
| `side/controller.ts` | Loads the tokens of the lines of the story from the engine, and sends the story and the ripple of the file. Shows a line of a card in the file view and in the text editor. |
| `state/store.ts` | `RippleLayerState`: the ripple and the hunks of the last review. `sideMode`: the file view or the story. |
| `extension.ts` | In the side mode, a review shows the story and no marks in the editor. The actions of the story. A change of `dataflow.view` moves the ripple between the editor and the side view. |

### Webview

| File | Change |
| --- | --- |
| `webview-side/ripple.tsx` | New. The Change Ripple bar, the story with the diff, the facts, the chain, the cards and the wave, and the ripple in the file view |
| `webview-side/code.tsx` | New. The text of a row with its tokens and its boxes, from `CodeView.tsx`. The code view and the story use it. |
| `webview-side/CodeView.tsx` | The ripple in the file view: the background of the lines, the bar of a changed line, and the hints after the code |
| `webview-side/main.tsx` | The switch of Change Ripple, the story mode, the bar and the change of the story |
| `webview-side/styles.ts` | The styles of the story, of the diff and of the ripple in the file view |

### Tests and tools

- `src/test/unit/story.test.ts`: the hunks of a diff, the lexer, the spans of an old line, the story of scenario 4 with fake data, the lines for the tokens, and the ripple in the file view
- `src/test/fixtures/side-ripple.test.ts`: scenario 4 in the story, a click on a card, the buttons **Story** and **File view**, the caller in `main.cpp` with a call hierarchy provider of the test, and **Clear**. The configuration `review` runs it after the test of P5.
- `spikes/ui/side-ripple-snapshot.mjs`: screenshots of the wave, of the story, of the end of the chain, of a wide side view, of the file view after a click on a card and on the diff, and of the diff editor

## Checks on the screen

| Check | Result |
| --- | --- |
| Review fixture, dark, light and high contrast theme | The diff, the facts, the cards, the arrows, the badges and the wave are correct. 420 ms after the second step, the front of the wave is on line 77, and only the card of `solve_power_plan()` is lit. |
| Wide side view | The diff and the facts are at the left, and the chain is at the right. |
| A click on the line of `auto converged` | The side view shows the file view at line 102, and the cursor of the editor is on line 102. The hints of lines 77, 95 and 107 come after the code. |
| A click on the added line of the diff | The file view shows line 69 with the bar of a changed line. |
| **Open the diff editor** | The diff editor opens in the group of the text editor. The side view stays open. |

## Numbers

| Measurement | Result |
| --- | --- |
| Size of the script of the side view | 128 KB. It was 107 KB after phase S4. |
| Render of the visible rows of a file of 2,402 lines | A maximum of 4.1 ms in two test runs. The budget is 100 ms. |
| Story of the fixture | 3 cards, 31 steps and 6 exits. With the call hierarchy provider of the test, 4 cards. |

## Changes from the strategy and from the prototype

- **One card for each function and lambda:** the prototype has one card for each step, with a note that a person wrote. The story has the cards of the strategy, with one row for each step, because the slice of `process()` in the fixture has 28 steps. The extension makes the notes from the kinds of the steps.
- **No questions for the reviewer:** the prototype has a list of questions that a person wrote, and a card for a branch that runs less often. The engine has no data for them.
- **Facts:** the prototype has the fact "reaches inverter requests". The story has the number of steps and exits.
- **File view:** the strategy describes only the story. In the side mode, the editor shows no marks of Change Ripple, so the file view shows the ripple, as the editor mode did.
- **Colors of the old lines:** the engine parses only the working tree. The removed lines get the spans of their added line for the same text, and a small lexer gives the spans of the changed part.

## Limits

[TODO.md](../TODO.md) has the open issues. The most important for the story:

- The chain is a list in the sequence of the ripple. If a function returns to two callers, their cards come one after the other. The arrow names the card that the value comes from.
- On a long line, the note of the line is outside of the visible area of the card until a scroll to the right.
- The story does not update after an edit. Click **Review again**.
- The diff comes from git, with the files on the disk. If the editor has changes that are not saved, the lines of the diff and of the slices can be different.
- The default of `dataflow.view` is still `editor`. The plan changes the default after phase S5. This needs a decision of the user.

## How to do the tests

1. Type `npm test`. The configuration `review` contains the test of the story.
2. Type `npm run test:engine`.
3. For screenshots, type `node spikes/ui/side-ripple-snapshot.mjs <folder> dark`. The theme can be `dark`, `light`, `hc` or `hclight`.

## Next step

Phase S6 makes the side view the only view. It removes the overlays, the sidebar view and the setting `dataflow.view`.
