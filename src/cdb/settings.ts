import { readFileSync, statSync } from 'fs';
import * as path from 'path';

// The DataFlow settings in the .vscode/settings.json of a project that is not open in VS Code. VS Code reads this file
// only for a folder of the window, so DataFlow reads it for its project. This module does not use the VS Code API, so
// the unit tests can call it.

// The text of a settings file as JSON: VS Code allows comments, and a comma after the last item of an object or an array
export function parseJsonc(text: string): unknown {
	let out = '';
	let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') {
				j += text[j] === '\\' ? 2 : 1;
			}
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
		} else if (c === ',' && /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*[}\]]/.test(text.slice(i + 1))) {
			i++; // the comma after the last item
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out);
}

// The settings of an object as keys with dots. { "dataflow": { "logic": { "eventFunctions": [] } } } and
// { "dataflow.logic.eventFunctions": [] } give the same key. An array is a value
export function flattenSettings(value: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		if (prefix) {
			out.set(prefix, value);
		}
		return out;
	}
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		flattenSettings(item, prefix ? `${prefix}.${key}` : key, out);
	}
	return out;
}

// The settings of the projects, from the file on disk. A change of the file gives new values at the next call
export class ProjectSettings {
	private cache = new Map<string, { mtime: number; values: Map<string, unknown> }>();

	constructor(private readonly warn: (message: string) => void = () => undefined) {}

	static fileOf(root: string): string {
		return path.join(root, '.vscode', 'settings.json');
	}

	// All settings of the project as keys with dots. Empty if the project has no settings file
	values(root: string): Map<string, unknown> {
		const file = ProjectSettings.fileOf(root);
		let mtime: number;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			this.cache.delete(file);
			return new Map();
		}
		const cached = this.cache.get(file);
		if (cached && cached.mtime === mtime) {
			return cached.values;
		}
		let values = new Map<string, unknown>();
		try {
			values = flattenSettings(parseJsonc(readFileSync(file, 'utf8')));
		} catch (error) {
			this.warn(`${file} is not valid JSON: ${error}`);
		}
		this.cache.set(file, { mtime, values });
		return values;
	}

	// The value of a setting with its full key, for example dataflow.logic.eventFunctions, or undefined
	get(root: string, key: string): unknown {
		return this.values(root).get(key);
	}
}
