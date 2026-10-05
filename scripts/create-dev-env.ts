// Creates a local .env from .env.example with random development secrets.
// Runs with Node 24 native type stripping: `node scripts/create-dev-env.ts [--force]`.
//   __SECRET:<NAME>__  -> 24 random bytes, hex (safe inside URLs and shell-interpolated Compose files)
//   __KEY32:<NAME>__   -> 32 random bytes, base64 (AES-256 keys)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const examplePath = join(root, '.env.example');
const targetPath = join(root, '.env');
const force = process.argv.includes('--force');

if (existsSync(targetPath) && !force) {
  console.error('.env already exists. Re-run with --force to overwrite it.');
  process.exit(1);
}

const generated = new Map<string, string>();
const output = readFileSync(examplePath, 'utf8').replace(
  /__(SECRET|KEY32):([A-Z0-9_]+)__/g,
  (_match, kind: string, name: string) => {
    const id = `${kind}:${name}`;
    let value = generated.get(id);
    if (value === undefined) {
      value = kind === 'KEY32' ? randomBytes(32).toString('base64') : randomBytes(24).toString('hex');
      generated.set(id, value);
    }
    return value;
  },
);

writeFileSync(targetPath, output, { encoding: 'utf8', mode: 0o600 });
console.log(`Wrote ${targetPath} with ${generated.size} generated development secrets.`);
