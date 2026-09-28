import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MARIADB_HOST, RADIUS_HOST, buildFirewallRuleset, type DeviceFirewallInput } from './vpnFirewall.js';

/**
 * `buildFirewallRuleset` es pura (sin base de datos): se prueba con casos
 * concretos de dispositivos y se comprueba el orden de las lineas -critico,
 * ver el comentario en el propio fichero- y, si esta disponible, que
 * `nft -c -f` acepta de verdad la sintaxis generada.
 */

const OPTIONS = { estPort: 8443, lanCidr: '192.168.10.0/24' };

function device(overrides: Partial<DeviceFirewallInput> = {}): DeviceFirewallInput {
  return {
    username: 'vpn-juan-laptop',
    framedIp: '192.168.10.80',
    allowRadiusHost: false,
    allowMariadbHost: false,
    rules: [],
    ...overrides,
  };
}

test('buildFirewallRuleset: siempre anade el acceso a EST antes que nada', () => {
  const nft = buildFirewallRuleset([device()], OPTIONS);
  const lines = nft.split('\n').filter((l) => l.includes('192.168.10.80') && !l.trim().startsWith('#'));
  assert.match(lines[0]!, /ip daddr 192\.168\.10\.28 tcp dport 8443 accept/);
});

test('buildFirewallRuleset: bloquea RADIUS y MariaDB por defecto', () => {
  const nft = buildFirewallRuleset([device({ rules: [{ id: 1, kind: 'internet', destCidr: null, protocol: null, port: null }] })], OPTIONS);
  assert.match(nft, new RegExp(`ip daddr ${RADIUS_HOST.replace(/\./g, '\\.')} drop`));
  assert.match(nft, new RegExp(`ip daddr ${MARIADB_HOST.replace(/\./g, '\\.')} drop`));
});

test('buildFirewallRuleset: el bloqueo va antes que "internet", para que no lo anule', () => {
  const nft = buildFirewallRuleset(
    [device({ rules: [{ id: 1, kind: 'internet', destCidr: null, protocol: null, port: null }] })],
    OPTIONS,
  );
  const deviceLines = nft.split('\n').filter((l) => l.includes('192.168.10.80'));
  const dropIdx = deviceLines.findIndex((l) => l.includes(`daddr ${RADIUS_HOST}`) && l.includes('drop'));
  const internetIdx = deviceLines.findIndex((l) => l.includes('0.0.0.0/0'));
  assert.ok(dropIdx >= 0 && internetIdx >= 0);
  assert.ok(dropIdx < internetIdx, 'el drop de RADIUS debe ir antes que el accept a internet');
});

test('buildFirewallRuleset: "lan" usa el lan_cidr configurado, no un literal fijo', () => {
  const nft = buildFirewallRuleset(
    [device({ rules: [{ id: 1, kind: 'lan', destCidr: null, protocol: null, port: null }] })],
    { estPort: 8443, lanCidr: '10.0.0.0/8' },
  );
  assert.match(nft, /ip daddr 10\.0\.0\.0\/8 accept/);
  assert.doesNotMatch(nft, /ip daddr 192\.168\.10\.0\/24 accept/);
});

test('buildFirewallRuleset: excepcion explicita permite RADIUS/MariaDB para ese dispositivo', () => {
  const nft = buildFirewallRuleset(
    [device({ allowRadiusHost: true, allowMariadbHost: true, rules: [] })],
    OPTIONS,
  );
  const deviceLines = nft.split('\n').filter((l) => l.includes('192.168.10.80'));
  assert.ok(!deviceLines.some((l) => l.includes(`daddr ${RADIUS_HOST}`) && l.includes('drop')));
  assert.ok(!deviceLines.some((l) => l.includes(`daddr ${MARIADB_HOST}`) && l.includes('drop')));
  // El EST accept sigue ahi de todas formas.
  assert.ok(deviceLines.some((l) => l.includes('tcp dport 8443 accept')));
});

test('buildFirewallRuleset: la excepcion es por dispositivo, no global', () => {
  const nft = buildFirewallRuleset(
    [
      device({ username: 'vpn-con-excepcion', framedIp: '192.168.10.80', allowRadiusHost: true }),
      device({ username: 'vpn-sin-excepcion', framedIp: '192.168.10.81' }),
    ],
    OPTIONS,
  );
  const withException = nft.split('\n').filter((l) => l.includes('192.168.10.80'));
  const without = nft.split('\n').filter((l) => l.includes('192.168.10.81'));
  assert.ok(!withException.some((l) => l.includes(`daddr ${RADIUS_HOST}`) && l.includes('drop')));
  assert.ok(without.some((l) => l.includes(`daddr ${RADIUS_HOST}`) && l.includes('drop')));
});

test('buildFirewallRuleset: destino concreto con protocolo y puerto', () => {
  const nft = buildFirewallRuleset(
    [
      device({
        rules: [{ id: 1, kind: 'custom', destCidr: '8.8.8.8', protocol: 'udp', port: 53 }],
      }),
    ],
    OPTIONS,
  );
  assert.match(nft, /ip daddr 8\.8\.8\.8 udp dport 53 accept/);
});

test('buildFirewallRuleset: destino concreto con protocolo sin puerto (todos los puertos de ese protocolo)', () => {
  const nft = buildFirewallRuleset(
    [device({ rules: [{ id: 1, kind: 'custom', destCidr: '1.2.3.4/32', protocol: 'tcp', port: null }] })],
    OPTIONS,
  );
  assert.match(nft, /ip daddr 1\.2\.3\.4\/32 ip protocol tcp accept/);
});

test('buildFirewallRuleset: destino concreto sin protocolo (cualquier protocolo/puerto)', () => {
  const nft = buildFirewallRuleset(
    [device({ rules: [{ id: 1, kind: 'custom', destCidr: '1.2.3.4', protocol: null, port: null }] })],
    OPTIONS,
  );
  assert.match(nft, /ip daddr 1\.2\.3\.4 accept\s*$/m);
});

test('buildFirewallRuleset: sin dispositivos activos, la tabla queda vacia pero valida', () => {
  const nft = buildFirewallRuleset([], OPTIONS);
  assert.match(nft, /table inet vpn_clients/);
  assert.match(nft, /policy drop/);
});

test('buildFirewallRuleset: varios dispositivos, cada uno con sus propias lineas', () => {
  const nft = buildFirewallRuleset(
    [
      device({ username: 'vpn-juan-laptop', framedIp: '192.168.10.80', rules: [{ id: 1, kind: 'internet', destCidr: null, protocol: null, port: null }] }),
      device({ username: 'vpn-maria-vps', framedIp: '192.168.10.81', rules: [{ id: 2, kind: 'lan', destCidr: null, protocol: null, port: null }] }),
    ],
    OPTIONS,
  );
  assert.match(nft, /vpn-juan-laptop/);
  assert.match(nft, /vpn-maria-vps/);
  assert.match(nft, /ip saddr 192\.168\.10\.80 ip daddr 0\.0\.0\.0\/0 accept/);
  assert.match(nft, /ip saddr 192\.168\.10\.81 ip daddr 192\.168\.10\.0\/24 accept/);
});

function hasCli(bin: string): boolean {
  try {
    execFileSync(bin, ['-v'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

test(
  'buildFirewallRuleset: nft -c -f acepta la sintaxis generada de verdad',
  { skip: !hasCli('nft') && 'nft no disponible en este entorno' },
  () => {
    const nft = buildFirewallRuleset(
      [
        device({ rules: [{ id: 1, kind: 'internet', destCidr: null, protocol: null, port: null }] }),
        device({
          username: 'vpn-maria-vps',
          framedIp: '192.168.10.81',
          allowMariadbHost: true,
          rules: [
            { id: 2, kind: 'lan', destCidr: null, protocol: null, port: null },
            { id: 3, kind: 'custom', destCidr: '8.8.8.8', protocol: 'udp', port: 53 },
          ],
        }),
      ],
      OPTIONS,
    );
    const dir = mkdtempSync(join(tmpdir(), 'radius-panel-nft-test-'));
    const file = join(dir, 'firewall.nft');
    writeFileSync(file, nft);
    execFileSync('nft', ['-c', '-f', file], { encoding: 'utf8', timeout: 5000 });
  },
);
