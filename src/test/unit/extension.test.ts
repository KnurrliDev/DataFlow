import * as assert from 'assert';
import * as vscode from 'vscode';

// The extension ID has the format "<publisher>.<name>". The values come from package.json.
const EXTENSION_ID = 'local-dev.dataflow';
const COMMAND_ID = 'dataflow.helloWorld';

// These tests run in a VS Code window that the "vscode-test" command starts.
// The tests can use the full VS Code API in this window.
suite('DataFlow extension', () => {
	test('The extension is not active before its command starts', () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `VS Code did not find the extension "${EXTENSION_ID}".`);

		// VS Code does not activate an extension until one of its activation events occurs.
		assert.strictEqual(extension.isActive, false);
	});

	test('The Hello World command activates the extension and returns the message', async () => {
		const message = await vscode.commands.executeCommand<string>(COMMAND_ID);

		assert.strictEqual(message, 'Hello World from DataFlow!');
		assert.strictEqual(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
	});
});
