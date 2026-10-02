import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'imd-tsc-'));
try {
  execFileSync('tar', ['-xzf', join(root, 'vendor/typescript-lib.tar.gz'), '-C', temp]);
  execFileSync(process.execPath, [join(temp, 'lib/tsc.js'), '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
