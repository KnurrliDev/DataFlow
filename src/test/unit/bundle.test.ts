import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

// esbuild bundles the script of the side view. A webview cannot load packages, so the bundle must contain all its code.
suite('Webview bundle', () => {
	test('side.js contains all its code', () => {
		const file = path.join(__dirname, '..', '..', 'webview', 'side.js');
		assert.ok(existsSync(file), `${file} is missing. Run "npm run compile".`);
		assert.ok(!/^\s*import\s/m.test(readFileSync(file, 'utf8')), 'side.js imports a module');
	});
});
