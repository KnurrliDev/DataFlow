// The names of functions for the user. This module does not use the VS Code API, so the webview and the unit tests can
// use it. A function that ## in a macro makes, for example a test case of Catch2, has a name such as
// CATCH2_INTERNAL_TEST_0. The engine gives the text of the macro call for it, for example TEST_CASE("split").

export interface NamedFunction {
	name: string;
	qualifiedName: string;
	macroCall?: string;
}

// The text of the macro call of a function, or its name. With isQualified, the name has its scope
export function functionTitle(fn: NamedFunction, isQualified = false): string {
	return fn.macroCall ?? (isQualified ? fn.qualifiedName : fn.name);
}

// True if a title is the text of a macro call: a name with no scope before the first round bracket. A qualified name
// such as ns::f::(lambda 1) is not a macro call
export function isMacroCall(title: string): boolean {
	return /^[^:(]+\(/.test(title);
}

// A title with round brackets, for example process(). The text of a macro call has its brackets
export function withBrackets(title: string): string {
	return isMacroCall(title) ? title : `${title}()`;
}
