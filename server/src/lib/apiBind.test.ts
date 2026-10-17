import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..', '..', '..');

test('radius-panel.service no activa IPAddressAllow/IPAddressDeny (rompen EST sobre IPsec)', () => {
  const unit = readFileSync(join(ROOT, 'deploy', 'radius-panel.service'), 'utf8');
  const active = unit.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));
  assert.ok(!active.some((l) => /^\s*IPAddress(Allow|Deny)\s*=/i.test(l)), 'la unidad no debe filtrar por IP');
});

const configUrl = pathToFileURL(resolve(ROOT, 'server', 'src', 'config.ts')).href;

test('config: API_BIND vale 127.0.0.1 por defecto y se puede cambiar', () => {
  const run = (extra: Record<string, string>) =>
    execFileSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '-e', `import(${JSON.stringify(configUrl)}).then(m => console.log(m.config.bind))`],
      {
        // cwd vacio: dotenv no encuentra ningun server/.env que altere el defecto.
        cwd: mkdtempSync(join(tmpdir(), 'api-bind-')),
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'test',
          JWT_SECRET: 'x'.repeat(32),
          RADIUS_DB_USER: 'u',
          PANEL_DB_USER: 'u',
          ...extra,
        },
        encoding: 'utf8',
      },
    ).trim();
  assert.equal(run({}), '127.0.0.1');
  assert.equal(run({ API_BIND: '10.0.0.5' }), '10.0.0.5');
});
