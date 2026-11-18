// The signature of a VSIX package. The updater of DataFlow installs a package of a GitHub release only with a correct
// signature in the file <package>.sig next to the package.
// > The signature is an Ed25519 signature of a short text: the name of the package, its version and the SHA-256 of the
//   file. Thus an old package cannot come back as a new version.
// > The private key stays on the computer of the person who makes the release. scripts/make-signing-key.mjs makes it.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The file of the private key. The environment variable DATAFLOW_SIGNING_KEY can name a different file
export const signingKeyFile = () => process.env.DATAFLOW_SIGNING_KEY ?? path.join(os.homedir(), '.dataflow', 'update-signing-key.pem');

// IMPORTANT: updateStatement in src/update/release.ts makes the same text
export const updateStatement = (name, version, sha256) => `dataflow-update-1\n${name}\n${version}\n${sha256}\n`;

// Writes the signature of a package into <vsix>.sig, and gives the path of this file
export function signVsix(vsix, version, privateKeyPem) {
	const sha256 = createHash('sha256').update(readFileSync(vsix)).digest('hex');
	const statement = updateStatement(path.basename(vsix), version, sha256);
	const signature = sign(null, Buffer.from(statement), createPrivateKey(privateKeyPem));
	const file = `${vsix}.sig`;
	writeFileSync(file, `${signature.toString('base64')}\n`);
	return file;
}
