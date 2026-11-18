import * as assert from 'assert';
import { createHash, generateKeyPairSync, sign } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isNewer, isSignatureValid, readRelease, RELEASE_API, updateStatement } from '../../update/release';
import { CHECK_INTERVAL_MS, RETRY_INTERVAL_MS, UpdateMode, Updater } from '../../update/updater';

// The updates from the releases on GitHub: the data of a release, the signature of a package, and the work of the updater
// with a server in memory

const keys = generateKeyPairSync('ed25519');
const PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const HOST = 'https://releases.test';

// A release on the server. signedVersion: the signature is for a different version. digest: GitHub gives this digest
function releaseOf(version: string, options: { signedVersion?: string; digest?: string } = {}) {
	const name = `dataflow-win32-x64-${version}.vsix`;
	const bytes = Buffer.from(`package ${version}`);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const statement = updateStatement(name, options.signedVersion ?? version, sha256);
	const signature = Buffer.from(sign(null, Buffer.from(statement), keys.privateKey).toString('base64'));
	return {
		json: {
			tag_name: `v${version}`, draft: false, prerelease: false, html_url: `${HOST}/v${version}`,
			assets: [
				{ name, browser_download_url: `${HOST}/${name}`, size: bytes.length, state: 'uploaded', digest: options.digest ?? `sha256:${sha256}` },
				{ name: `${name}.sig`, browser_download_url: `${HOST}/${name}.sig`, size: signature.length, state: 'uploaded' },
			],
		},
		files: new Map([[`${HOST}/${name}`, bytes], [`${HOST}/${name}.sig`, signature]]),
	};
}

suite('Updates from the releases on GitHub', () => {
	let dir: string;
	let clock: number;
	let mode: UpdateMode;
	let latest: ReturnType<typeof releaseOf>;
	let isOffline: boolean;
	let requests: { url: string; etag: string | null }[];
	let answer: 'update' | 'skip' | undefined;
	let installFails: boolean;
	let installs: string[];
	let asks: string[];
	let reloads: string[];
	let infos: string[];
	let warnings: string[];

	const downloads = () => requests.filter((r) => r.url !== RELEASE_API).length;

	// The updater of a window with the running version. Two updaters with the same folder are two windows
	const window = (version = '0.6.2') => new Updater({
		version, platform: 'win32-x64', publicKey: PUBLIC_KEY, storageDir: dir, mode: () => mode,
		fetch: async (input, init) => {
			const url = String(input);
			const etag = new Headers(init?.headers).get('if-none-match');
			requests.push({ url, etag });
			if (isOffline) {
				throw new Error('The network is not available.');
			}
			if (url === RELEASE_API) {
				const tag = `"${latest.json.tag_name}${latest.json.assets[0].digest}"`;
				return etag === tag ? new Response(null, { status: 304 }) : new Response(JSON.stringify(latest.json), { headers: { ETag: tag } });
			}
			const file = latest.files.get(url);
			return file ? new Response(new Uint8Array(file)) : new Response('', { status: 404 });
		},
		install: async (vsix) => {
			if (installFails) {
				throw new Error('VS Code did not install the package.');
			}
			installs.push(readFileSync(vsix, 'utf8'));
		},
		ui: {
			askToUpdate: async (version_) => {
				asks.push(version_);
				return answer;
			},
			offerReload: async (version_) => {
				reloads.push(version_);
			},
			progress: (_title, work) => work(),
			info: (message) => infos.push(message),
			warn: (message) => warnings.push(message),
		},
		log: { info: () => undefined, warn: () => undefined },
		now: () => clock,
	});

	setup(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-update-'));
		clock = Date.now();
		mode = 'auto';
		latest = releaseOf('0.6.3');
		isOffline = false;
		installFails = false;
		answer = undefined;
		[requests, installs, asks, reloads, infos, warnings] = [[], [], [], [], [], []];
	});

	teardown(() => rmSync(dir, { recursive: true, force: true }));

	test('A version is newer only if its numbers are higher, and a text that is not a version is never newer', () => {
		assert.deepStrictEqual([isNewer('0.6.3', '0.6.2'), isNewer('v0.10.0', '0.9.9'), isNewer('1.0.0', '0.99.99')], [true, true, true]);
		assert.deepStrictEqual([isNewer('0.6.2', '0.6.2'), isNewer('0.6.1', '0.6.2'), isNewer('0.7.0-beta', '0.6.2'), isNewer('latest', '0.6.2')],
			[false, false, false, false]);
	});

	test('A release needs a published version, and a package and a signature for the platform', () => {
		const { json } = releaseOf('0.6.3');
		const release = readRelease(json, 'win32-x64');
		assert.deepStrictEqual([release?.version, release?.notesUrl, release?.vsix.name, release?.signature.name],
			['0.6.3', `${HOST}/v0.6.3`, 'dataflow-win32-x64-0.6.3.vsix', 'dataflow-win32-x64-0.6.3.vsix.sig']);
		assert.strictEqual(readRelease(json, 'linux-x64'), undefined);
		assert.strictEqual(readRelease({ ...json, prerelease: true }, 'win32-x64'), undefined);
		assert.strictEqual(readRelease({ ...json, draft: true }, 'win32-x64'), undefined);
		assert.strictEqual(readRelease({ ...json, tag_name: 'nightly' }, 'win32-x64'), undefined);
		assert.strictEqual(readRelease({ ...json, assets: [json.assets[0]] }, 'win32-x64'), undefined, 'no signature');
		assert.strictEqual(readRelease({ ...json, assets: [{ ...json.assets[0], state: 'starter' }, json.assets[1]] }, 'win32-x64'), undefined, 'an upload that is not complete');
		assert.strictEqual(readRelease(null, 'win32-x64'), undefined);
	});

	test('A signature is correct only for the name, the version and the file that it signs, and only with the key', () => {
		const statement = updateStatement('a.vsix', '0.6.3', 'abc');
		const signature = sign(null, Buffer.from(statement), keys.privateKey).toString('base64');
		assert.strictEqual(isSignatureValid(statement, `${signature}\n`, PUBLIC_KEY), true);
		assert.strictEqual(isSignatureValid(updateStatement('a.vsix', '0.6.4', 'abc'), signature, PUBLIC_KEY), false, 'a different version');
		assert.strictEqual(isSignatureValid(updateStatement('a.vsix', '0.6.3', 'abd'), signature, PUBLIC_KEY), false, 'a different file');
		assert.strictEqual(isSignatureValid(statement, 'not a signature', PUBLIC_KEY), false);
		const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
		assert.strictEqual(isSignatureValid(statement, signature, other), false, 'a different key');
		assert.strictEqual(isSignatureValid(statement, signature, 'not a key'), false);
	});

	test('auto: a new version installs one time, the window offers a reload, and the download is removed', async () => {
		const updater = window();
		await updater.tick();
		assert.deepStrictEqual([installs, reloads, asks, warnings], [['package 0.6.3'], ['0.6.3'], [], []]);
		assert.strictEqual(existsSync(path.join(dir, 'download')), false);
		assert.strictEqual(existsSync(path.join(dir, 'updater.lock')), false);

		// the time for the next check did not come, and the reload shows one time in the window
		const count = requests.length;
		await updater.tick();
		assert.deepStrictEqual([requests.length, installs.length, reloads.length], [count, 1, 1]);
	});

	test('A different window does not install the version again, and it offers the reload too', async () => {
		await window().tick();
		const count = requests.length;
		await window().tick();
		assert.deepStrictEqual([requests.length, installs.length, reloads], [count, 1, ['0.6.3', '0.6.3']]);
		// after the reload, the window runs the new version
		const reloaded = window('0.6.3');
		clock += CHECK_INTERVAL_MS;
		await reloaded.tick();
		assert.deepStrictEqual([installs.length, reloads.length, warnings], [1, 2, []]);
	});

	test('ask: nothing downloads until the user clicks Update, and a skipped version does not ask again', async () => {
		mode = 'ask';
		const updater = window();
		await updater.tick();
		assert.deepStrictEqual([asks, installs, downloads()], [['0.6.3'], [], 0]);
		// the same window asks one time
		clock += CHECK_INTERVAL_MS;
		await updater.tick();
		assert.deepStrictEqual(asks, ['0.6.3']);

		answer = 'skip';
		clock += CHECK_INTERVAL_MS;
		await window().tick();
		assert.deepStrictEqual(asks, ['0.6.3', '0.6.3']);
		clock += CHECK_INTERVAL_MS;
		await window().tick();
		assert.deepStrictEqual(asks, ['0.6.3', '0.6.3'], 'a skipped version');

		// the command asks also for a skipped version, and a newer version asks again
		answer = 'update';
		await window().check(true);
		assert.deepStrictEqual([installs, reloads], [['package 0.6.3'], ['0.6.3']]);
	});

	test('off: no automatic check, but the command still works', async () => {
		mode = 'off';
		await window().tick();
		assert.strictEqual(requests.length, 0);
		answer = 'update';
		await window().check(true);
		assert.deepStrictEqual([asks, installs], [['0.6.3'], ['package 0.6.3']]);
	});

	test('The command tells that the version is the latest version, and an older release installs nothing', async () => {
		await window('0.6.3').check(true);
		assert.deepStrictEqual([infos, installs], [['DataFlow 0.6.3 is the latest version.'], []]);
		latest = releaseOf('0.6.1');
		clock += CHECK_INTERVAL_MS;
		await window('0.6.3').tick();
		assert.deepStrictEqual([installs, reloads], [[], []]);
	});

	test('A check waits for the interval, sends the ETag of the last reply, and finds a new release', async () => {
		const updater = window('0.6.3');
		await updater.tick();
		assert.deepStrictEqual(requests.map((r) => r.etag), [null]);
		await updater.tick();
		assert.strictEqual(requests.length, 1, 'the interval');
		clock += CHECK_INTERVAL_MS;
		await updater.tick();
		assert.deepStrictEqual(requests.map((r) => r.etag), [null, `"v0.6.3${latest.json.assets[0].digest}"`]);

		latest = releaseOf('0.6.4');
		clock += CHECK_INTERVAL_MS;
		await updater.tick();
		assert.deepStrictEqual([installs, reloads], [['package 0.6.4'], ['0.6.4']]);
	});

	test('An old package with its correct signature does not install as a new version, and the warning comes one time', async () => {
		latest = releaseOf('0.6.3', { signedVersion: '0.6.0' });
		await window().tick();
		assert.deepStrictEqual([installs, reloads], [[], []]);
		assert.deepStrictEqual(warnings, ['DataFlow did not install version 0.6.3, because the signature of the package is not correct.']);

		// the next checks do not download the version again
		const count = downloads();
		clock += CHECK_INTERVAL_MS;
		await window().tick();
		assert.deepStrictEqual([downloads(), warnings.length], [count, 1]);

		// the command tries again, and a correct package of a newer version installs
		answer = 'update';
		await window().check(true);
		assert.deepStrictEqual([installs.length, warnings.length], [0, 2]);
		latest = releaseOf('0.6.4');
		clock += CHECK_INTERVAL_MS;
		await window().tick();
		assert.deepStrictEqual(installs, ['package 0.6.4']);
	});

	test('A damaged download does not install, shows no warning, and tries again after a short time', async () => {
		latest = releaseOf('0.6.3', { digest: 'sha256:0000' });
		await window().tick();
		assert.deepStrictEqual([installs, warnings], [[], []]);
		latest = releaseOf('0.6.3');
		clock += RETRY_INTERVAL_MS - 1000;
		await window().tick();
		assert.strictEqual(installs.length, 0, 'the time did not come');
		clock += 1000;
		await window().tick();
		assert.deepStrictEqual(installs, ['package 0.6.3']);
	});

	test('A failure of the network or of the install is quiet, and the command tells it', async () => {
		isOffline = true;
		await window().tick();
		assert.deepStrictEqual([installs, warnings], [[], []]);
		await window().check(true);
		assert.deepStrictEqual(warnings, ['DataFlow could not check for updates: The network is not available.']);

		isOffline = false;
		installFails = true;
		warnings = [];
		clock += RETRY_INTERVAL_MS;
		await window().tick();
		assert.deepStrictEqual([reloads, warnings], [[], []]);
		answer = 'update';
		await window().check(true);
		assert.deepStrictEqual([reloads, warnings], [[], ['DataFlow could not install version 0.6.3: VS Code did not install the package.']]);
		assert.strictEqual(existsSync(path.join(dir, 'download')), false);
	});

	test('A window waits for the lock of a different window, and takes a lock that is stale', async () => {
		mkdirSync(dir, { recursive: true });
		const lock = path.join(dir, 'updater.lock');
		writeFileSync(lock, '');
		await window().tick();
		assert.strictEqual(requests.length, 0);
		await window().check(true);
		assert.deepStrictEqual(infos, ['A different window of VS Code updates DataFlow now. Try again in some minutes.']);

		const old = new Date(clock - 60 * 60 * 1000);
		utimesSync(lock, old, old);
		await window().tick();
		assert.deepStrictEqual(installs, ['package 0.6.3']);
	});
});
