import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const [useNextest, fail] of [[false, false], [false, true], [true, false]]) {
  test(`verification (${useNextest ? 'nextest' : 'cargo test'}) ${fail ? 'stops on Clippy failure' : 'runs all three stages'}`, { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-verification-'));
    try {
      writeFileSync(join(dir, 'cargo'), `#!/bin/sh\necho CALLED:$1:$2\n${fail ? '[ "$1" != clippy ] || exit 73' : 'exit 0'}\n`, { mode: 0o755 });
      if (useNextest) {
        writeFileSync(join(dir, 'cargo-nextest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      const systemPath = '/usr/bin:/bin';
      const result = spawnSync('bash', [fileURLToPath(new URL('./verify-core.sh', import.meta.url))], {
        env: { ...process.env, SOURCE_DIR: dir, PATH: `${dir}:${systemPath}` },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, fail ? 73 : 0, result.stderr);
      assert.match(result.stdout, /CALLED:fmt:/);
      assert.match(result.stdout, /CALLED:clippy:/);
      if (fail) assert.doesNotMatch(result.stdout, /CALLED:(?:test|nextest):/);
      else if (useNextest) assert.match(result.stdout, /CALLED:nextest:run/);
      else assert.match(result.stdout, /CALLED:test:--workspace/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
