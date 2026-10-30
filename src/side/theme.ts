import { readFile } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SideStyle } from './protocol';
import {
	customSections, customTextMateRules, fallbackStyles, isObject, parseJsonc, parsePlist, resolveStyles, semanticRulesOf, SemanticRule,
	TextMateRule, textMateRulesOf, ThemeData,
} from './themeRules';

// Finds the styles of the side view in the active color theme. docs/side-view-strategy.md, section 5.8, gives the
// method. If DataFlow cannot read the theme, the side view gets colors of the workbench.

export interface ThemeStyles {
	styles: SideStyle[];
	theme?: string; // the id of the theme, or undefined for the colors of the workbench
	error?: string;
}

interface ThemeFile {
	id: string;
	label: string;
	file: string;
}

const KIND_OF_UI_THEME: Record<string, vscode.ColorThemeKind> = {
	'vs': vscode.ColorThemeKind.Light,
	'vs-dark': vscode.ColorThemeKind.Dark,
	'hc-black': vscode.ColorThemeKind.HighContrast,
	'hc-light': vscode.ColorThemeKind.HighContrastLight,
};

// The old ids of the default themes that VS Code changes to the new ids
const MIGRATED_THEME_IDS: Record<string, string> = {
	'Default Dark Modern': 'Dark Modern',
	'Default Light Modern': 'Light Modern',
	'Default Dark+': 'Dark+',
	'Default Light+': 'Light+',
	'Experimental Dark': 'Dark 2026',
	'VS Code Dark': 'Dark 2026',
	'Experimental Light': 'Light 2026',
	'VS Code Light': 'Light 2026',
};

const THEME_SETTINGS = ['workbench.colorTheme', 'workbench.preferredDarkColorTheme', 'workbench.preferredLightColorTheme',
	'workbench.preferredHighContrastColorTheme', 'workbench.preferredHighContrastLightColorTheme', 'editor.tokenColorCustomizations',
	'editor.semanticTokenColorCustomizations', 'editor.semanticHighlighting.enabled'];

// The theme files of all extensions, also of the built-in extensions
function allThemes(): (ThemeFile & { kind?: vscode.ColorThemeKind })[] {
	const out: (ThemeFile & { kind?: vscode.ColorThemeKind })[] = [];
	for (const ext of vscode.extensions.all) {
		const themes = ext.packageJSON?.contributes?.themes;
		if (!Array.isArray(themes)) {
			continue;
		}
		for (const t of themes) {
			if (isObject(t) && typeof t.path === 'string') {
				const label = typeof t.label === 'string' ? t.label : '';
				out.push({
					id: typeof t.id === 'string' ? t.id : label,
					label,
					file: path.join(ext.extensionPath, t.path),
					kind: typeof t.uiTheme === 'string' ? KIND_OF_UI_THEME[t.uiTheme] : undefined,
				});
			}
		}
	}
	return out;
}

// The theme of the workbench. With an automatic theme for the color scheme of the system, the active theme can be a
// preferred theme. The kind of the active theme selects it.
function activeThemeFile(): ThemeFile | undefined {
	const config = vscode.workspace.getConfiguration('workbench');
	const names = ['colorTheme', 'preferredDarkColorTheme', 'preferredLightColorTheme', 'preferredHighContrastColorTheme',
		'preferredHighContrastLightColorTheme'].map((key) => config.get<string>(key)).filter((n): n is string => !!n)
		.map((name) => MIGRATED_THEME_IDS[name] ?? name);
	const kind = vscode.window.activeColorTheme.kind;
	const themes = allThemes();
	for (const name of names) {
		const theme = themes.find((t) => (t.id === name || t.label === name) && (t.kind === undefined || t.kind === kind));
		if (theme) {
			return theme;
		}
	}
	return undefined;
}

interface RawTheme {
	tokenColors: TextMateRule[];
	semanticRules: SemanticRule[];
	semanticHighlighting?: boolean;
}

// Reads a theme file and the files that it includes. The rules of an included file come first.
async function readTheme(file: string, depth = 0): Promise<RawTheme> {
	// a theme of TextMate: a property list with the rules in its settings
	if (!file.toLowerCase().endsWith('.json')) {
		return { tokenColors: textMateRulesOf(parsePlist(await readFile(file, 'utf8'))), semanticRules: [] };
	}
	const json = parseJsonc(await readFile(file, 'utf8'));
	if (!isObject(json)) {
		throw new Error(`${file} is not a color theme`);
	}
	const out: RawTheme = typeof json.include === 'string' && depth < 8
		? await readTheme(path.join(path.dirname(file), json.include), depth + 1)
		: { tokenColors: [], semanticRules: [] };

	if (Array.isArray(json.tokenColors)) {
		out.tokenColors.push(...json.tokenColors);
	} else if (typeof json.tokenColors === 'string') {
		// a separate file of rules: JSON, or a theme of TextMate
		const rulesFile = path.join(path.dirname(file), json.tokenColors);
		const text = await readFile(rulesFile, 'utf8');
		if (!rulesFile.toLowerCase().endsWith('.json')) {
			out.tokenColors.push(...textMateRulesOf(parsePlist(text)));
		} else {
			const rules = parseJsonc(text);
			out.tokenColors.push(...(Array.isArray(rules) ? rules : isObject(rules) && Array.isArray(rules.tokenColors) ? rules.tokenColors : []));
		}
	}
	out.semanticRules.push(...semanticRulesOf(json.semanticTokenColors));
	if (typeof json.semanticHighlighting === 'boolean') {
		out.semanticHighlighting = json.semanticHighlighting;
	}
	return out;
}

// The rules of the theme and of the user settings
async function loadThemeData(theme: ThemeFile): Promise<ThemeData> {
	const raw = await readTheme(theme.file);
	const editor = vscode.workspace.getConfiguration('editor');
	const names = [theme.id, theme.label];

	const tokenColors = [...raw.tokenColors];
	for (const section of customSections(editor.get('tokenColorCustomizations'), names)) {
		tokenColors.push(...customTextMateRules(section));
	}

	const semanticRules = [...raw.semanticRules];
	let enabledByTheme = raw.semanticHighlighting ?? false;
	for (const section of customSections(editor.get('semanticTokenColorCustomizations'), names)) {
		semanticRules.push(...semanticRulesOf(section.rules));
		if (typeof section.enabled === 'boolean') {
			enabledByTheme = section.enabled;
		}
	}
	const setting = editor.get<boolean | string>('semanticHighlighting.enabled', 'configuredByTheme');
	const semanticHighlighting = setting === true || (setting !== false && enabledByTheme);
	return { tokenColors, semanticRules, semanticHighlighting };
}

// Without semantic tokens of an extension, the text editor shows only the colors of the grammar
export async function loadThemeStyles(hasSemanticTokens = true): Promise<ThemeStyles> {
	const theme = activeThemeFile();
	if (!theme) {
		return { styles: fallbackStyles(), error: 'DataFlow did not find the file of the color theme.' };
	}
	try {
		const data = await loadThemeData(theme);
		return { styles: resolveStyles({ ...data, semanticHighlighting: data.semanticHighlighting && hasSemanticTokens }), theme: theme.id };
	} catch (error) {
		return { styles: fallbackStyles(), error: `DataFlow cannot read the color theme ${theme.id}: ${error}` };
	}
}

// Calls the listener when the styles can change: a new color theme, a change of the settings, or a new extension
export function onDidChangeThemeStyles(listener: () => void): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.window.onDidChangeActiveColorTheme(listener),
		vscode.extensions.onDidChange(listener),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (THEME_SETTINGS.some((s) => e.affectsConfiguration(s))) {
				listener();
			}
		}),
	);
}
