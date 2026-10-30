// Bundles the script of the side view with esbuild.
// > node scripts/build-webviews.mjs: one build
// > node scripts/build-webviews.mjs --watch: a new build after each change. This mode also runs the TypeScript
//   compiler in watch mode, so the default build task of VS Code needs only this command.
// esbuild does not check types. "npm run compile" checks them with tsconfig.webview.json.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..');
const options = {
	entryPoints: {
		side: path.join(repo, 'src', 'webview-side', 'main.tsx'),
	},
	outdir: path.join(repo, 'out', 'webview'),
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	jsx: 'automatic',
	jsxImportSource: 'preact',
	sourcemap: true,
	logLevel: 'info',
};

if (process.argv.includes('--watch')) {
	// The output of the TypeScript compiler tells VS Code when a build is complete
	const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
	const child = spawn(process.execPath, [tsc, '-b', '-w', './tsconfig.json', './tsconfig.webview.json'], { cwd: repo, stdio: 'inherit' });
	process.on('exit', () => child.kill());
	process.on('SIGINT', () => process.exit(0));
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
