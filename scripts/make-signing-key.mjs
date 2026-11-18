// Makes the key pair for the signatures of the VSIX packages: node scripts/make-signing-key.mjs
// > The private key goes into a file in your user folder. Do not put this file into the repository.
// > The script writes the public key to the console. UPDATE_PUBLIC_KEY in src/update/release.ts must have this value.
// > The script does not replace a key. The installed versions of DataFlow accept only the key that they contain.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { signingKeyFile } from './sign-vsix.mjs';

const file = signingKeyFile();
if (existsSync(file)) {
	console.error(`${file} exists. The script does not replace a key.`);
	process.exit(2);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
console.log(`The private key is in ${file}. Keep a safe copy of this file.`);
console.log('The public key for UPDATE_PUBLIC_KEY in src/update/release.ts:');
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
