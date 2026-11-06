# Go to definition, forward declarations and type outline: implementation strategy

This document proposes how to add three features to DataFlow. All three are possible. Section 11 lists the decisions that the user must make before the work starts.

## 1. Goal and scope

| Feature | What the user does | What the user sees |
| --- | --- | --- |
| Go to definition | Ctrl+click on a name in the side view | The side view shows the file of the definition at the definition. |
| Forward declarations | Turn on Include Hierarchy | For each include of the file: forward declarations can replace the include, or the line that needs the full type. |
| Type outline | Right-click on the name of a class, a struct, a union or an enum, then click **Outline** | A panel with the bases, the data members, the functions, the nested types and the memory layout of the type. |

The result of the analysis for each feature:

- Go to definition: possible, with the same behavior as the text editor. A definition in a different source file needs a C/C++ extension, for example the C/C++ extension of Microsoft or clangd. With no such extension, DataFlow goes to a definition in the same translation unit, or else to the declaration.
- Forward declarations: possible. The result is exact for most code. For templates and for the standard library, the analysis is conservative: if it is not sure, the include is necessary.
- Type outline: possible for each type that has a definition in a translation unit. This includes the types of libraries, for example of Unreal Engine and Qt.

These items are not in the scope: a peek view in the side view, a rename, and a change of the code by DataFlow. Section 5.6 has an optional action that changes the code.

## 2. Key decisions (proposed)

1. One engine function finds the name at a position. Features 1 and 3 use it. It uses the walk of the names that the request `dataflow/tokens` does already (`NameClassifier` in `tokens.hpp`).
2. Go to definition asks the definition providers of VS Code first, as the text editor does. The engine is the fallback.
3. The side view goes to the definition, and the focus stays in the side view (decision of the user). A visible text editor of the file of the definition gets its cursor there, as for a click in the side view. Else the text editor stays at its place. The side view has its own Back and Forward.
4. The modifier key obeys `editor.multiCursorModifier`, as in the text editor: Ctrl (Cmd on macOS) by default, Alt if the setting is `ctrlCmd`.
5. The forward declaration check is a part of the include analysis of the engine. It is conservative: a kind of use that the check does not know needs the full type.
6. The outline comes from the engine (Clang), not from the document symbols of a C/C++ extension. Clang gives the access, the virtual functions, the overrides, the inherited members and the layout. It also works with no C/C++ extension.
7. The outline shows in a panel over the code, as the list of **Show Calls**.

## 3. Shared engine part: the name at a position

A new engine function `name_at(ast, line, col)` gives the declaration that the name at the position refers to, and the range of the name.

- It is a variant of `NameClassifier`. It stops at the first name whose place in the file contains the position.
- `NameClassifier` visits all names of the file. Examples are the references to declarations, the member accesses, the overloads, the types and the declarations. It also visits the using declarations, the namespace aliases, the constructor initializers and the qualifiers of names.
- A name in an argument of a macro has its place in the file. A name in the body of a macro has no place in the file, so the result is the macro.
- A macro name gives the definition of the macro from the preprocessor of the parse (`MacroInfo::getDefinitionLoc`).
- An #include line gives the file of its node in the include pass.

The ast of the file is in the cache, so a request takes some milliseconds.

## 4. Feature 1: go to definition (Ctrl+click)

### 4.1 Behavior

- Hold Ctrl, and move the mouse over a name. The name gets an underline, and the mouse pointer is a hand, as in the text editor.
- Ctrl+click on a name goes to its definition:
  - For one definition, the side view shows the file at the definition, and the focus stays in the side view. A visible text editor of that file gets its cursor at the definition. Else the text editor stays at its place.
  - For more than one definition, the panel of **Show Calls** shows the places. A click on a place moves the side view.
  - On the definition itself, a function shows **Show Calls**. For a different name, a message tells that this is the definition.
- Ctrl+click on the file name of an #include shows the header in the side view.
- F12 in the side view goes to the definition of the name at the cursor of the side view.
- Back and Forward of the side view: Alt+Left and Alt+Right while the side view has the focus, and the mouse buttons Back and Forward. A click in the text editor also shows the file of the editor in the side view again.
- A click with no modifier does not change. It moves the cursor, or with Flow Lens on, it traces a variable.

### 4.2 Webview

- `CodeView.onMouseUp`: a click with the modifier posts `{ type: 'goToDefinition', line, col }` and does nothing else. A mouse down with the modifier prevents a text selection.
- The handlers of `mousemove`, `keydown` and `keyup` set the class `goto-link` on the token under the mouse while the modifier is down. Only names get it: the style indices of the semantic types, and the file name of an #include.
- The controller sends `editor.multiCursorModifier` with the other settings of the text editor (`EDITOR_SETTINGS`).

### 4.3 Extension

A new method of the controller, `goToDefinition(file, line, col)`, does these steps:

1. It asks `vscode.executeDefinitionProvider`, with the time limit of 10 s that `openDefinition` uses.
2. If no provider gives an answer, it asks the engine with `dataflow/definition`.
3. It removes the place of the click from the results.
4. For one result, it puts the place of the side view into the history, and it moves the side view. A visible text editor of the file gets its cursor there. For more results, it shows the list panel.

The history (`PlaceHistory` in `src/side/definition.ts`) keeps the last 50 places. The commands `dataflow.side.back` and `dataflow.side.forward` have the keys Alt+Left and Alt+Right when `activeWebviewPanelId` is the side view. The button **Find the definition** of Call Hierarchy keeps its behavior: it moves the text editor.

### 4.4 Engine

A new request `dataflow/definition` `{file, line, col}` gives `{name, kind, targets: [{file, line, col, role}]}`:

- role `definition`: the translation unit has the definition (`FunctionDecl::getDefinition`, `VarDecl::getDefinition`, `TagDecl::getDefinition`).
- role `declaration`: the translation unit has no definition. The target is the first declaration, for example in a header. The status line of the side view tells that the definition is in a different source file.

## 5. Feature 2: forward declarations in Include Hierarchy

### 5.1 The rule

Forward declarations can replace an include of the main file if all these conditions are true:

- The include is used. A "possibly unused" include gets no result, because the file needs no replacement for it.
- Each name that the main file uses from the header is a class, a struct, a union, a class template or an enum. These names also include the names of the headers that only this include brings in, as for the check of the unused includes.
- Each of these types can have a forward declaration (5.2).
- Each use of these types in the main file needs only an incomplete type (5.3).

The result contains the forward declarations, for example `namespace power { class Battery; }`.

The engine parses a header with the command of a near source file, so the header is the main file of its parse. Thus the check also works for the includes of a header. Headers are the most important case, because a source file usually needs the full types.

### 5.2 Types that can have a forward declaration

| Type | Forward declaration |
| --- | --- |
| A class, a struct or a union in a namespace or at global scope | `class X;` with the keyword of the definition. MSVC gives `class` and `struct` different names in the object files. |
| A class template with no default template arguments | `template <class T> class X;` with the template parameters |
| An `enum class`, or an enum with a fixed underlying type | `enum class E : int;` |
| A nested type, a type in an anonymous namespace, or an enum with no fixed underlying type | None |
| A type alias (`typedef`, `using`) | None |
| A class template with default template arguments | None. The forward declaration cannot give the default arguments again. |
| A class template with a constraint, or with a non-type parameter that is not a builtin type or `auto` | None. The concept or the type can be in the header (found during the implementation). |
| A type of the namespace `std` | None. A declaration in `std` is undefined behavior. The headers of the standard library get no check. The proposed rule "the stream types give `#include <iosfwd>`" is not in the first version (5.7). |

Classes of Unreal Engine (for example `AActor`) and of Qt (for example `QString`) can have forward declarations. The documentation of both recommends them in headers.

### 5.3 Uses that need only an incomplete type

These uses need only an incomplete type:

- A pointer or a reference to the type (`T*`, `T&`, `const T&`, `T&&`), also as a data member, a parameter or a return type.
- A parameter or a return type by value in a function declaration with no body.
- A friend declaration.
- An `extern` variable declaration, and a declaration of a static data member in a class.
- A template argument of a template on a short list of templates that accept an incomplete type: `std::shared_ptr`, `std::weak_ptr`, `TObjectPtr`, `TWeakObjectPtr`, `TSoftObjectPtr`, `TSubclassOf` and `QPointer`.
- A pointer to the type as a template argument, for example `std::vector<T*>`.

All other uses need the full type, for example:

- A variable or a data member by value.
- A base class.
- A member access.
- `sizeof`, `new` and `delete`.
- A cast to a base class.
- A function body with a parameter by value.
- A call with an argument or a result by value.
- `std::unique_ptr<T>`, because its destructor needs the full type.
- The implementation also found these uses: an aggregate initialization (`X{1, 2}`), a parameter by value of a lambda, `catch` and `throw` also through a pointer or a reference, a definition of a member function or a static data member out of its class, and a call of a function template with the type as a type argument, for example `std::swap(a, b)`.

The engine also finds uses that have no name in the text. Examples are a call that returns the type by value, and a member access through a variable of type `auto`.

### 5.4 Engine

- A new visitor `ForwardUseCollector` in `includes.hpp` collects each reference of the main file to a declaration, and each place that needs the full type of a class, with its line and its kind. The visitor `UseCollector` keeps only the first use of each name, so it cannot do this. The visitor walks only the declarations of the main file.
- In the result of `dataflow/includes`, each include node of the main file gets `forward: { state, text, types, blocker }`:
  - `state`: `possible` or `needed`. An include with no result, for example an unused include, has no `forward`.
  - `text`: the forward declarations, grouped by namespace.
  - `types`: each type with its uses and their lines.
  - `blocker`: for `needed`, the first use that needs the header: the name, the line and the kind of the use.
- The check uses the include pass and the ast in the cache. It adds one walk of the declarations of the main file.

### 5.5 Side view

- In the tree of Include Hierarchy, each include that forward declarations can replace gets the badge `fwd`. The first version had the badge `forward declaration`, but the narrow details column cut it.
- The #include line in the code gets a hint, for example `→ class Battery;`. A click on the hint opens the include in Include Hierarchy, as the hint "possibly unused" does.
- The details of the include show the forward declarations as code, a button **Copy**, and each type with the lines that use it.
- For an include that the file needs, the details show the first line that needs the full type, for example `line 45: member access of Battery`. Thus Include Hierarchy also tells why the file needs each include.
- The status line of Include Hierarchy counts the includes that forward declarations can replace.

### 5.6 Optional actions

- **Check with a parse**: the engine parses a copy of the file with the forward declarations in the place of the include. Then it shows the new errors. This takes the time of a full parse, so it starts only after a click. Not in the first version.
- **Replace**: DataFlow replaces the include with the forward declarations in the text editor, as one edit that Ctrl+Z removes. Decision of the user: DataFlow does not edit files. Thus there is no **Replace**, and the details have only **Copy**.

### 5.7 Limits

- A template that is not on the list of 5.3 gives the result `needed`, also if the template accepts an incomplete type.
- A class with a `std::unique_ptr<T>` data member and a destructor in its source file can use a forward declaration of `T`. The first version gives `needed` for it. A later rule can find this case.
- If a different include also brings in the header, the parse of 5.6 shows no error. The other include hides the full type.
- A file with parse errors gets no result, because its ast is not complete.
- The visitor does not walk the instantiations of templates. Thus it does not see a use that only an instantiation has, for example a specialization of `fmt::formatter` that the header declares. A call of a function template with the type as a type argument gives `needed`, so most of these cases give the correct result.
- The headers of the standard library get no check. The rule for `<iosfwd>` of 5.2 needs the uses of each name of the standard library, and the check of the used includes keeps only the first use of each public header. It can come in a later version.
- The text of the declarations uses `namespace a::b { ... }` from C++17. Before C++17, each namespace gets its own braces.

## 6. Feature 3: outline of a type

### 6.1 Behavior

- Right-click on the name of a class, a struct, a union or an enum in the side view. The menu has **Outline** (the label of the user). This also works on the name of a constructor and on a type alias of a class.
- A panel over the code shows the type, below the place of the click:
  - The head: the kind, the qualified name, the template parameters, the bases and `final`.
  - The layout: `sizeof`, the alignment, the bytes of padding, and a bar of the memory with the data members.
  - The groups: Bases, Data members, Constructors and destructor, Functions, Static members, Nested types, Friends and Enumerators.
  - Each member: the access, the type or the signature, and badges: `virtual`, `override`, `pure`, `static`, `const`, `= delete`, `= default`, `noexcept`. A data member also shows its offset and its size.
  - For Unreal Engine, the text of `UPROPERTY(...)` and `UFUNCTION(...)`. For Qt, the signals, the slots and `Q_PROPERTY`.
  - A group "Inherited from Base" for each base, closed at the start.
- A filter field, the arrow keys, Enter and Escape work as in the list of **Show Calls**.
- A click on a member moves the side view to its declaration, as Ctrl+click does (decision of the user). Ctrl+click on a function goes to its definition (feature 1).

### 6.2 Engine

A new request `dataflow/outline` `{file, line, col}` or `{file, name}` gives the outline of the type:

- `name_at` (section 3) gives the declaration. A type alias gives its class. A constructor gives its class.
- The translation unit must have the definition. Else the result has `hasDefinition: false` and the place of the declaration.
- The layout comes from `ASTContext::getASTRecordLayout`, only for a complete type that does not depend on a template parameter.
- The text of the macros of Unreal Engine and Qt comes from the source text before each member. The compiler does not see these macros, because they expand to no code.
- A member function with its definition in the translation unit gets the place of the definition, for example `battery.cpp:40`.

### 6.3 Extension and webview

- The menu: `webview/context` gets the command `dataflow.showOutline` with `webviewId == 'dataflow.sideView' && dataflowType`. `CodeView.onContextMenu` sets `dataflowType` for the style indices of `class`, `enum` and `type`, as it sets `dataflowCallable` for **Show Calls**.
- For a type with no definition in the translation unit, the extension finds the header of the definition. It asks the definition provider, or it searches the project headers. Then it sends `dataflow/outline` `{file: header, name}`.
- A new webview module `outline.tsx` shows the panel. It uses the position and the keys of `calllist.tsx`.

## 7. MCP tools (optional)

- A new tool `get_outline` `{file, line}` or `{file, name}` gives the outline to a language model, for example to explain a class.
- The tool `get_includes` gets the forward declaration result of each include.

## 8. Phases

| Phase | Content | Size |
| --- | --- | --- |
| A | `name_at`, `dataflow/definition`, Ctrl+click, the underline, F12, the file of an #include, the documents | Small to medium |
| B | `dataflow/outline`, the menu, the panel, the layout, the documents | Medium |
| C | The forward declaration check in the engine, the badge, the hint and the details, the documents | Large |
| D (optional) | **Check with a parse**, **Replace**, the MCP tools | Small for each item |

The proposed order is A, B, C. Phases A and B use `name_at`. Phase C has the most rules and needs the most tests.

## 9. Tests

- Engine tests (`test/engine/protocol.test.mjs`):
  - `dataflow/definition` for a variable, a data member, a macro and a type. Also for a function with its definition in the translation unit, and for a function with only a declaration.
  - `dataflow/outline` for a class with a base, virtual functions, a static member, a nested enum and padding.
  - The forward declaration check for each row of 5.2 and each kind of use of 5.3.
- Fixtures: a new header in `test/fixtures/battery` with pointer members, a reference parameter, an `enum class` and a nested type. In the Unreal fixture, a `TObjectPtr<AActor>` member.
- Tests of the side view (`test/ui`):
  - Ctrl+click, with mouse events of the Chrome DevTools Protocol and the Ctrl modifier.
  - The menu item **Outline** and its panel.
  - The badge and the hint of a forward declaration.
- Unit tests: the steps of 4.3 with a fake provider, and the text of the forward declarations with namespaces.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| The test build of VS Code has no C/C++ extension. | The tests use the engine fallback. One test with a copy of the C/C++ extension checks the provider path, as for Call Hierarchy. |
| The language server of the C/C++ extension stopped on a project of the user after a request of DataFlow. | The guard of `callHierarchyCommand` also applies to the definition requests: one request at a time, and no more requests after a failure. |
| A wrong result `possible` for a template. | The list of 5.3 is short, and all other templates give `needed`. The optional parse of 5.6 checks a result. |
| A library type has a very large outline, for example `std::vector`. | The panel hides the private names of library types that start with `_`, and it has a filter. |
| A header that the engine parses alone has errors. | No forward declaration result for a file with parse errors. |

## 11. Decisions of the user

1. Ctrl+click: decided. The side view goes to the definition and keeps the focus. The side view has Back and Forward. In the file of a visible text editor, the cursor of that editor follows.
2. Outline: decided. A panel over the code. A click on a member moves the side view, as Ctrl+click does. The menu label is **Outline**.
3. Outline: decided. The panel shows the memory layout.
4. Forward declarations: decided. DataFlow only shows the result. It does not edit files, so the details have **Copy** and no **Replace**.
5. The order of the phases: decided. A, B, C.
