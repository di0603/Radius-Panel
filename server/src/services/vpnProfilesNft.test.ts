import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ACCESS_PROFILES,
  emptyRanges,
  type AccessProfile,
  type ProfileRanges,
} from './vpnAccessProfiles.js';
import { GATEWAY_HOST, buildProfilesRuleset, type ProfilesRulesetInput } from './vpnProfilesNft.js';
import type { RestrictedDestination } from './vpnRestrictedList.js';

/**
 * Generador de vpn-profiles.nft: golden files por perfil (el texto exacto que
 * se carga en la .29 no cambia sin que alguien lo vea en el diff), propiedades
 * de seguridad que no dependen del golden, y `nft -c -f` si hay nft utilizable
 * en el entorno (no se carga nada: -c solo comprueba la sintaxis).
 *
 * Regenerar los golden tras un cambio intencionado: UPDATE_GOLDEN=1 npm test
 */

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '__golden__', 'vpn-profiles');
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

const PROFILE_RANGES: Record<AccessProfile, [string, string]> = {
  lan_restricted: ['192.168.10.100', '192.168.10.104'],
  lan_full: ['192.168.10.105', '192.168.10.109'],
  internet_only: ['192.168.10.110', '192.168.10.114'],
  internet_lan_restricted: ['192.168.10.115', '192.168.10.119'],
  internet_lan_full: ['192.168.10.75', '192.168.10.99'],
};

const DESTINATIONS: RestrictedDestination[] = [
  {
    id: 1,
    destCidr: '192.168.10.50',
    protocol: 'tcp',
    ports: '22,443,8000-8100',
    comment: 'Servidor de ficheros',
  },
  { id: 2, destCidr: '192.168.10.0/28', protocol: 'udp', ports: '53', comment: '' },
  { id: 3, destCidr: '192.168.10.60', protocol: 'icmp', ports: null, comment: 'ping al NAS' },
  { id: 4, destCidr: '192.168.10.70', protocol: 'tcp', ports: null, comment: 'todo tcp' },
];

function rangesOnly(...profiles: AccessProfile[]): ProfileRanges {
  const r = emptyRanges();
  for (const p of profiles)
    r[p] = { rangeStart: PROFILE_RANGES[p][0], rangeEnd: PROFILE_RANGES[p][1] };
  return r;
}

function input(overrides: Partial<ProfilesRulesetInput> = {}): ProfilesRulesetInput {
  return {
    ranges: rangesOnly(...ACCESS_PROFILES),
    destinations: DESTINATIONS,
    lanCidr: '192.168.10.0/24',
    estPort: 8443,
    egressInterface: null,
    generatedAt: FIXED_DATE,
    ...overrides,
  };
}

function assertGolden(name: string, actual: string) {
  const file = join(GOLDEN_DIR, `${name}.nft`);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual, 'utf8');
    return;
  }
  assert.ok(existsSync(file), `Falta el golden ${file} (genera con UPDATE_GOLDEN=1)`);
  assert.equal(actual, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `golden ${name}`);
}

/* ------------------------------- golden por perfil ------------------------------ */

for (const profile of ACCESS_PROFILES) {
  test(`golden: solo el perfil ${profile}`, () => {
    assertGolden(
      `profile-${profile}`,
      buildProfilesRuleset(input({ ranges: rangesOnly(profile) })),
    );
  });
}

test('golden: todos los perfiles, con interfaz de salida', () => {
  assertGolden(
    'all-profiles-egress-eth0',
    buildProfilesRuleset(input({ egressInterface: 'eth0' })),
  );
});

test('golden: lista restringida vacia', () => {
  assertGolden('empty-list', buildProfilesRuleset(input({ destinations: [] })));
});

/* ------------------- propiedades que no dependen del golden -------------------- */

function lines(nft: string): string[] {
  return nft.split('\n').map((l) => l.trim());
}

const PRIVATE_SET = '{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 }';

test('lan_full e internet_lan_full: toda la LAN en forward y accept en input hacia la .29', () => {
  const l = lines(buildProfilesRuleset(input()));
  assert.ok(l.includes('ip saddr @lan_full_ips ip daddr 192.168.10.0/24 accept'));
  assert.ok(l.includes('ip saddr @internet_lan_full_ips ip daddr 192.168.10.0/24 accept'));
  assert.ok(l.includes(`ip saddr @lan_full_ips ip daddr ${GATEWAY_HOST} accept`));
  assert.ok(l.includes(`ip saddr @internet_lan_full_ips ip daddr ${GATEWAY_HOST} accept`));
});

test('los perfiles NO completos no tienen accept de toda la LAN ni acceso a la .29', () => {
  const l = lines(buildProfilesRuleset(input()));
  for (const profile of ['lan_restricted', 'internet_only', 'internet_lan_restricted']) {
    const mine = l.filter((x) => x.includes(`@${profile}_ips`));
    assert.ok(mine.length > 0, profile);
    assert.ok(
      !mine.some((x) => x.includes('ip daddr 192.168.10.0/24 accept')),
      `${profile} no debe abrir toda la LAN`,
    );
    assert.ok(!mine.some((x) => x.includes(GATEWAY_HOST)), `${profile} no debe llegar a la .29`);
  }
});

test('internet_*: Internet = todo menos redes privadas; lan_* sin Internet', () => {
  const l = lines(buildProfilesRuleset(input()));
  for (const profile of ['internet_only', 'internet_lan_restricted', 'internet_lan_full']) {
    assert.ok(l.includes(`ip saddr @${profile}_ips ip daddr != ${PRIVATE_SET} accept`), profile);
  }
  for (const profile of ['lan_restricted', 'lan_full']) {
    assert.ok(
      !l.some((x) => x.includes(`@${profile}_ips`) && x.includes('!=')),
      `${profile} no tiene Internet`,
    );
  }
});

test('con interfaz de salida, las reglas internet exigen oifname', () => {
  const l = lines(buildProfilesRuleset(input({ egressInterface: 'eth0' })));
  const internet = l.filter((x) => x.includes('ip daddr != {'));
  assert.equal(internet.length, 3);
  assert.ok(internet.every((x) => x.endsWith('oifname "eth0" accept')));
});

test('restringidos: solo la lista (jump a restricted_allow); las entradas salen de la lista', () => {
  const nft = buildProfilesRuleset(input());
  const l = lines(nft);
  assert.ok(l.includes('ip saddr @lan_restricted_ips jump restricted_allow'));
  assert.ok(l.includes('ip saddr @internet_lan_restricted_ips jump restricted_allow'));
  assert.ok(l.includes('ip daddr 192.168.10.50 tcp dport { 22, 443, 8000-8100 } accept'));
  assert.ok(l.includes('ip daddr 192.168.10.0/28 udp dport 53 accept'));
  assert.ok(l.includes('ip daddr 192.168.10.60 ip protocol icmp accept'));
  assert.ok(l.includes('ip daddr 192.168.10.70 ip protocol tcp accept'));
});

test('el accept de EST hacia la .28 va antes que cualquier regla de perfil y cubre a todos', () => {
  const l = lines(buildProfilesRuleset(input()));
  const est = l.indexOf('ip saddr @vpn_all_ips ip daddr 192.168.10.28 tcp dport 8443 accept');
  const firstProfileRule = l.findIndex(
    (x) => x.startsWith('ip saddr @') && x !== l[est] && !x.includes('@vpn_all_ips'),
  );
  assert.ok(est >= 0, 'falta el accept de EST');
  assert.ok(est < firstProfileRule, 'EST tiene que ir antes de los perfiles');
});

test('todo lo demas: drop con contador, al final de forward y de input', () => {
  const nft = buildProfilesRuleset(input());
  assert.ok(
    nft.includes('\t\tcounter drop\n\t}\n\n\t# Trafico dirigido'),
    'forward termina en counter drop',
  );
  assert.ok(nft.endsWith('\t\tcounter drop\n\t}\n}\n'), 'input termina en counter drop');
});

test('no sustituye /etc/nftables.conf: no hace flush ruleset ni toca otras tablas', () => {
  const nft = buildProfilesRuleset(input());
  assert.ok(!/flush\s+ruleset/.test(nft));
  const tables = lines(nft).filter((l) => l.startsWith('table ') || l.startsWith('delete table'));
  assert.deepEqual(tables, [
    'table inet vpn_profiles {}',
    'delete table inet vpn_profiles',
    'table inet vpn_profiles {',
  ]);
});

test('un comentario con texto de regla queda inerte: solo una linea # saneada', () => {
  const nft = buildProfilesRuleset(
    input({
      destinations: [
        {
          id: 1,
          destCidr: '192.168.10.50',
          protocol: 'tcp',
          ports: '22',
          comment: 'x { accept } ; drop "y" $(z)',
        },
      ],
    }),
  );
  const noteLine = lines(nft).find((l) => l.startsWith('# x '));
  assert.ok(noteLine, 'el comentario debe aparecer como linea #');
  assert.ok(!/[{};"$]/.test(noteLine!.slice(2)), noteLine);
});

test('el generador rechaza entradas invalidas aunque no pasen por las rutas', () => {
  const bad: Partial<ProfilesRulesetInput>[] = [
    {
      destinations: [
        {
          id: 1,
          destCidr: '192.168.10.5; flush ruleset',
          protocol: 'tcp',
          ports: null,
          comment: '',
        },
      ],
    },
    {
      destinations: [
        { id: 1, destCidr: '192.168.10.5', protocol: 'tcp', ports: '22; accept', comment: '' },
      ],
    },
    { destinations: [{ id: 1, destCidr: '8.8.8.8', protocol: 'tcp', ports: null, comment: '' }] },
    {
      destinations: [
        { id: 1, destCidr: '192.168.10.5', protocol: 'icmp', ports: '1', comment: '' },
      ],
    },
    { egressInterface: 'eth0"; drop' },
    { estPort: 0 },
    {
      ranges: {
        ...rangesOnly(),
        lan_full: { rangeStart: '192.168.10.20', rangeEnd: '192.168.10.40' },
      },
    }, // incluye .28-.30
    {
      ranges: {
        ...rangesOnly(),
        lan_full: { rangeStart: '192.168.10.100', rangeEnd: '192.168.10.110' },
        internet_only: { rangeStart: '192.168.10.105', rangeEnd: '192.168.10.120' },
      },
    }, // solape
  ];
  for (const overrides of bad) {
    assert.throws(
      () => buildProfilesRuleset(input(overrides)),
      Error,
      JSON.stringify(overrides).slice(0, 80),
    );
  }
});

test('sin rangos configurados: sets vacios y el fichero sigue siendo valido', () => {
  const nft = buildProfilesRuleset(input({ ranges: emptyRanges(), destinations: [] }));
  assert.ok(!nft.includes('elements ='));
  assert.ok(nft.includes('set vpn_all_ips {'));
});

/* ------------------------------ nft -c -f (opcional) ---------------------------- */

/** Un nft capaz de hacer `-c` en este entorno (directo, o dentro de un netns de usuario), o null. */
function findNft(): string[] | null {
  const dir = mkdtempSync(join(tmpdir(), 'vpn-profiles-nft-'));
  const probe = join(dir, 'probe.nft');
  writeFileSync(probe, 'table inet vpn_probe {}\n');
  for (const prefix of [[], ['unshare', '-rn']]) {
    const argv = [...prefix, 'nft'];
    const r = spawnSync(argv[0]!, [...argv.slice(1), '-c', '-f', probe], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return argv;
  }
  return null;
}

const nftRunner = findNft();

for (const [name, build] of [
  ['todos los perfiles', () => buildProfilesRuleset(input({ egressInterface: 'eth0' }))],
  [
    'sin rangos ni lista',
    () => buildProfilesRuleset(input({ ranges: emptyRanges(), destinations: [] })),
  ],
  ...ACCESS_PROFILES.map(
    (p) => [`solo ${p}`, () => buildProfilesRuleset(input({ ranges: rangesOnly(p) }))] as const,
  ),
] as const) {
  test(
    `nft -c -f acepta el fichero generado: ${name}`,
    { skip: nftRunner ? false : 'nft no esta disponible en este entorno' },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'vpn-profiles-nft-'));
      const file = join(dir, 'vpn-profiles.nft');
      writeFileSync(file, build());
      const r = spawnSync(nftRunner![0]!, [...nftRunner!.slice(1), '-c', '-f', file], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
    },
  );
}
