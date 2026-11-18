import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebStream } from 'stream/web';
import { isNewer, isSignatureValid, readRelease, Release, RELEASE_API, RELEASES_PAGE, ReleaseAsset, updateStatement } from './release';

// The updates of an installed package from the releases on GitHub. All windows of VS Code share a folder with the state
// and a lock, so one window downloads a new version, and each window offers the reload. This module does not use the VS
// Code API, so the unit tests can call it directly.

// auto: install a new version, then offer a reload. ask: ask the user first. off: no automatic checks
export type UpdateMode = 'auto' | 'ask' | 'off';

export interface UpdaterUi {
	askToUpdate(version: string, running: string, notesUrl: string): Promise<'update' | 'skip' | undefined>;
	offerReload(version: string, notesUrl: string): Promise<void>;
	progress<T>(title: string, work: () => Promise<T>): Promise<T>;
	info(message: string): void;
	warn(message: string): void;
}

export interface UpdaterDeps {
	version: string; // the version that runs in this window
	platform: string; // for example win32-x64
	publicKey: string; // the public key of the signatures of the packages
	storageDir: string; // the folder of the state, the lock and the downloads
	mode(): UpdateMode;
	fetch: typeof fetch;
	install(vsix: string): Promise<void>;
	ui: UpdaterUi;
	log: { info(message: string): void; warn(message: string): void };
	now(): number; // milliseconds since 1970
}

// The state that the windows share
interface UpdaterState {
	nextCheck?: number; // the time of the next automatic check
	etag?: string; // GitHub does not count a request with the ETag of its last reply
	release?: Release; // the release of the last reply
	skipped?: string; // the version that the user does not want
	installed?: string; // the version that runs after a reload
	rejected?: string; // the version with a wrong signature. The user got a warning
}

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024;

const BUSY = Symbol('busy'); // a different window has the lock
const BUSY_TEXT = 'A different window of VS Code updates DataFlow now. Try again in some minutes.';

class SignatureError extends Error {}

const textOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Updater {
	private readonly asked = new Set<string>(); // the versions that this window asked about
	private readonly offered = new Set<string>(); // the versions that this window offered a reload for

	constructor(private readonly deps: UpdaterDeps) {}

	// The timer: offers the reload for a version that a different window installed, and checks if the time for it came
	async tick(): Promise<void> {
		const { deps } = this;
		if (deps.mode() === 'off') {
			return;
		}
		const state = await this.load();
		if (state.installed && isNewer(state.installed, deps.version)) {
			this.offerReload(state.installed, state.release?.notesUrl ?? RELEASES_PAGE, false);
		}
		if (deps.now() >= (state.nextCheck ?? 0)) {
			await this.check(false);
		}
	}

	// A check for a new version. isManual: the user runs the command, so the user gets each result, and a question before
	// the install
	async check(isManual: boolean): Promise<void> {
		const { deps } = this;
		let release: Release | undefined;
		try {
			const result = await this.withLock(() => this.fetchRelease());
			if (result === BUSY) {
				if (isManual) {
					deps.ui.info(BUSY_TEXT);
				}
				return;
			}
			release = result;
		} catch (error) {
			await this.save({ nextCheck: deps.now() + RETRY_INTERVAL_MS });
			deps.log.warn(`The check for a new version of DataFlow failed: ${textOf(error)}`);
			if (isManual) {
				deps.ui.warn(`DataFlow could not check for updates: ${textOf(error)}`);
			}
			return;
		}
		if (!release || !isNewer(release.version, deps.version)) {
			if (isManual) {
				deps.ui.info(`DataFlow ${deps.version} is the latest version.`);
			}
			return;
		}

		const state = await this.load();
		if (state.installed === release.version) {
			this.offerReload(release.version, release.notesUrl, isManual);
			return;
		}
		if (!isManual && (state.skipped === release.version || state.rejected === release.version)) {
			return;
		}
		const isAsked = isManual || deps.mode() === 'ask';
		if (isAsked) {
			if (!isManual && this.asked.has(release.version)) {
				return;
			}
			this.asked.add(release.version);
			const answer = await deps.ui.askToUpdate(release.version, deps.version, release.notesUrl);
			if (answer === 'skip') {
				await this.save({ skipped: release.version });
			}
			if (answer !== 'update') {
				return;
			}
		}
		await this.installRelease(release, isAsked);
	}

	private offerReload(version: string, notesUrl: string, isAlways: boolean): void {
		if (isAlways || !this.offered.has(version)) {
			this.offered.add(version);
			void this.deps.ui.offerReload(version, notesUrl);
		}
	}

	private async installRelease(release: Release, isShown: boolean): Promise<void> {
		const { deps } = this;
		const work = () => this.withLock(() => this.downloadAndInstall(release));
		try {
			const result = isShown ? await deps.ui.progress(`Installing DataFlow ${release.version}`, work) : await work();
			if (result === BUSY) {
				if (isShown) {
					deps.ui.info(BUSY_TEXT);
				}
				return;
			}
		} catch (error) {
			if (error instanceof SignatureError) {
				// the warning comes one time. Only the command tries this version again
				await this.save({ rejected: release.version });
				deps.log.warn(`DataFlow did not install version ${release.version}: the signature of the package is not correct.`);
				deps.ui.warn(`DataFlow did not install version ${release.version}, because the signature of the package is not correct.`);
				return;
			}
			await this.save({ nextCheck: deps.now() + RETRY_INTERVAL_MS });
			deps.log.warn(`DataFlow could not install version ${release.version}: ${textOf(error)}`);
			if (isShown) {
				deps.ui.warn(`DataFlow could not install version ${release.version}: ${textOf(error)}`);
			}
			return;
		}
		deps.log.info(`DataFlow installed version ${release.version}. It runs after a reload of the window.`);
		this.offerReload(release.version, release.notesUrl, true);
	}

	// The latest release. A reply with no change gives the release of the last reply
	private async fetchRelease(): Promise<Release | undefined> {
		const { deps } = this;
		const state = await this.load();
		const reply = await this.get(RELEASE_API, REQUEST_TIMEOUT_MS, {
			Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(state.etag ? { 'If-None-Match': state.etag } : {}),
		});
		const nextCheck = deps.now() + CHECK_INTERVAL_MS;
		if (reply.status === 304) {
			await this.save({ nextCheck });
			return state.release;
		}
		if (reply.status === 404) { // the repository has no published release
			await this.save({ nextCheck, etag: undefined, release: undefined });
			return undefined;
		}
		if (!reply.ok) {
			throw new Error(`GitHub answered with the status ${reply.status}.`);
		}
		const release = readRelease(await reply.json(), deps.platform);
		await this.save({ nextCheck, etag: reply.headers.get('etag') ?? undefined, release });
		return release;
	}

	// Installs a package only after the check of its signature
	private async downloadAndInstall(release: Release): Promise<void> {
		const { deps } = this;
		const folder = path.join(deps.storageDir, 'download');
		await rm(folder, { recursive: true, force: true });
		await mkdir(folder, { recursive: true });
		try {
			const signature = await this.downloadSignature(release.signature);
			const file = path.join(folder, release.vsix.name);
			const sha256 = await this.downloadPackage(release.vsix, file);
			if (release.vsix.digest && release.vsix.digest !== `sha256:${sha256}`) {
				throw new Error('The download is damaged.');
			}
			if (!isSignatureValid(updateStatement(release.vsix.name, release.version, sha256), signature, deps.publicKey)) {
				throw new SignatureError();
			}
			await deps.install(file);
			await this.save({ installed: release.version, skipped: undefined, rejected: undefined });
		} finally {
			await rm(folder, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async downloadSignature(asset: ReleaseAsset): Promise<string> {
		const reply = await this.get(asset.url, REQUEST_TIMEOUT_MS);
		if (!reply.ok) {
			throw new Error(`The server answered with the status ${reply.status} for ${asset.name}.`);
		}
		const text = await reply.text();
		if (text.length > MAX_SIGNATURE_BYTES) {
			throw new SignatureError();
		}
		return text;
	}

	// Writes the package into the file, and gives its SHA-256
	private async downloadPackage(asset: ReleaseAsset, file: string): Promise<string> {
		const reply = await this.get(asset.url, DOWNLOAD_TIMEOUT_MS);
		if (!reply.ok || !reply.body) {
			throw new Error(`The server answered with the status ${reply.status} for ${asset.name}.`);
		}
		const hash = createHash('sha256');
		let bytes = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				bytes += chunk.length;
				if (bytes > MAX_PACKAGE_BYTES) {
					done(new Error(`${asset.name} is too large.`));
					return;
				}
				hash.update(chunk);
				done(null, chunk);
			},
		});
		await pipeline(Readable.fromWeb(reply.body as unknown as WebStream), meter, createWriteStream(file));
		if (bytes !== asset.size) {
			throw new Error(`The download of ${asset.name} is not complete.`);
		}
		return hash.digest('hex');
	}

	private get(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
		return this.deps.fetch(url, {
			headers: { 'User-Agent': `DataFlow/${this.deps.version}`, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
		});
	}

	// Runs the work while this window has the lock of all windows. The lock of a window that stopped becomes stale
	private async withLock<T>(work: () => Promise<T>): Promise<T | typeof BUSY> {
		const { deps } = this;
		const lock = path.join(deps.storageDir, 'updater.lock');
		await mkdir(deps.storageDir, { recursive: true });
		const take = () => open(lock, 'wx').then((handle) => handle.close()).then(() => true, () => false);
		if (!await take()) {
			const info = await stat(lock).catch(() => undefined);
			if (info && deps.now() - info.mtimeMs < LOCK_STALE_MS) {
				return BUSY;
			}
			await rm(lock, { force: true }).catch(() => undefined);
			if (!await take()) {
				return BUSY;
			}
		}
		try {
			return await work();
		} finally {
			await rm(lock, { force: true }).catch(() => undefined);
		}
	}

	private get stateFile(): string {
		return path.join(this.deps.storageDir, 'updater.json');
	}

	private async load(): Promise<UpdaterState> {
		try {
			return JSON.parse(await readFile(this.stateFile, 'utf8')) as UpdaterState;
		} catch {
			return {};
		}
	}

	// The next window reads a complete file, because the rename replaces the file in one step
	private async save(change: Partial<UpdaterState>): Promise<void> {
		const temp = `${this.stateFile}.${process.pid}.tmp`;
		try {
			await mkdir(this.deps.storageDir, { recursive: true });
			await writeFile(temp, JSON.stringify({ ...await this.load(), ...change }));
			await rename(temp, this.stateFile);
		} catch (error) {
			this.deps.log.warn(`DataFlow could not save the state of its updates: ${textOf(error)}`);
			await rm(temp, { force: true }).catch(() => undefined);
		}
	}
}
