// The tokens of dataflow/tokens. This file has only types, so the script of the side view can use them with no Node
// types. engine/README.md describes the request.

export interface TokenLegend {
	kinds: string[];
	modifiers: string[];
}

export interface TokenLine {
	line: number;
	text: string;
	tokens: number[];
}
