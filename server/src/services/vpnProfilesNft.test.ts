import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ACCESS_PROFILES,
  emptyRanges,
  type AccessProfile,
  type ProfileRanges,
} from './vpnAccessProfiles.js';
import {
  ALL_SET_NAMES,
  EXISTING_EST_FORWARD_LINE,
  FORWARD_LINES_TO_REMOVE,
  GATEWAY_HOST,
  PROFILE_SET,
  RESTRICTED_DESTS_SET,
  RESTRICTED_ICMP_SET,
  buildFragmentParts,
  buildNftablesFragment,
  buildSetsFile,
  type FragmentOptions,
  type ProfilesSetsInput,
} from './vpnProfilesNft.js';
import {
  EXAMPLE_DESTINATIONS,
  FIXTURE_NFTABLES_CONF,
  assembleNftablesConf,
  exampleRanges,
} from './vpnProfilesNft.fixture.js';
import type { RestrictedDestination } from './vpnRestrictedList.js';

/**
 * Perfiles de acceso en nftables (diseno v2): fichero de sets (solo flush set +
 * add element sobre sets que ya existen en inet filter) y fragmento de
 * nftables.conf (sets vacios + reglas fijas). Golden files, propiedades de
 * seguridad que no dependen del golden y `nft -c -f` real si hay nft utilizable
 * (se comprueba el nftables.conf ensamblado: stand-in de la .29 + fragmento +
 * sets). La prueba funcional con paquetes esta en deploy/test-vpn-profiles-netns.sh
 * (NFT_FUNCTIONAL=1, solo Linux).
 *
 * Regenerar los golden tras un cambio intencionado: UPDATE_GOLDEN=1 npm test
 */

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '__golden__', 'vpn-profiles');
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const OPTIONS: FragmentOptions = {
  lanCidr: '192.168.10.0/24',
  egressInterface: null,
};

function rangesOnly(...profiles: AccessProfile[]): ProfileRanges {
  const all = exampleRanges();
  const r = emptyRanges();
  for (const p of profiles) r[p] = all[p];
  return r;
}

function setsInput(overrides: Partial<ProfilesSetsInput> = {}): ProfilesSetsInput {
  return {
    ranges: exampleRanges(),
    destinations: EXAMPLE_DESTINATIONS,
    lanCidr: '192.168.10.0/24',
    generatedAt: FIXED_DATE,
    ...overrides,
  };
}

function assertGolden(name: string, actual: string) {
  const file = join(GOLDEN_DIR, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual, 'utf8');
    return;
  }
  assert.ok(existsSync(file), `Falta el golden ${file} (genera con UPDATE_GOLDEN=1)`);
  assert.equal(actual, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `golden ${name}`);
}

const lines = (text: string) => text.split('\n').map((l) => l.trim());
/** Sin las lineas de comentario (las cabeceras mencionan "add element", "accept", "policy"...). */
const code = (text: string) => text.replace(/^[ \t]*#.*$/gm, '');

/* ------------------------------- golden files ------------------------------- */

for (const profile of ACCESS_PROFILES) {
  test(`golden: fichero de sets con solo el perfil ${profile}`, () => {
    assertGolden(
      `sets-profile-${profile}.nft`,
      buildSetsFile(setsInput({ ranges: rangesOnly(profile) })),
    );
  });
}

test('golden: fichero de sets con todos los perfiles', () => {
  assertGolden('sets-all-profiles.nft', buildSetsFile(setsInput()));
});

test('golden: fichero de sets con la lista restringida vacia', () => {
  assertGolden('sets-empty-list.nft', buildSetsFile(setsInput({ destinations: [] })));
});

test('golden: fragmento de nftables.conf', () => {
  assertGolden('nftables-fragment.conf', buildNftablesFragment(OPTIONS, FIXED_DATE));
});

test('golden: fragmento de nftables.conf con interfaz de salida', () => {
  assertGolden(
    'nftables-fragment-egress-eth0.conf',
    buildNftablesFragment({ ...OPTIONS, egressInterface: 'eth0' }, FIXED_DATE),
  );
});

test('golden: nftables.conf ensamblado (stand-in de la .29 + fragmento + sets)', () => {
  assertGolden(
    'nftables.conf.assembled',
    assembleNftablesConf(OPTIONS, buildSetsFile(setsInput())).conf,
  );
});

/* --------------------------- fichero de sets: propiedades --------------------------- */

const ALLOWED_LINE =
  /^(#.*|flush set inet filter vpn_[a-z_]+|add element inet filter vpn_[a-z_]+ \{ [0-9A-Za-z./, -]+ \}|)$/;

test('fichero de sets: solo comentarios, "flush set" y "add element" (nada de tablas, cadenas ni reglas)', () => {
  const file = buildSetsFile(setsInput());
  for (const line of file.split('\n')) assert.match(line, ALLOWED_LINE);
  assert.ok(!/flush\s+ruleset/.test(file));
  assert.ok(!/\b(table|chain|rule|delete)\b/.test(file.replace(/^#.*$/gm, '')));
});

test('fichero de sets: cada set se vacia antes de rellenarse (carga idempotente)', () => {
  const l = lines(buildSetsFile(setsInput()));
  for (const name of ALL_SET_NAMES) {
    const flush = l.indexOf(`flush set inet filter ${name}`);
    const add = l.findIndex((x) => x.startsWith(`add element inet filter ${name} `));
    assert.ok(flush >= 0, `falta flush de ${name}`);
    if (add >= 0) assert.ok(flush < add, `${name}: flush antes de add`);
  }
});

test('fichero de sets: cada rango va solo en el set de su perfil', () => {
  const l = lines(buildSetsFile(setsInput()));
  const expected: Record<AccessProfile, string> = {
    lan_restricted: '192.168.10.100-192.168.10.104',
    lan_full: '192.168.10.105-192.168.10.109',
    internet_only: '192.168.10.110-192.168.10.114',
    internet_lan_restricted: '192.168.10.115-192.168.10.119',
    internet_lan_full: '192.168.10.75-192.168.10.99',
  };
  for (const profile of ACCESS_PROFILES) {
    assert.ok(
      l.includes(`add element inet filter ${PROFILE_SET[profile]} { ${expected[profile]} }`),
      profile,
    );
  }
});

test('fichero de sets: destinos (ip . proto . puerto) con rangos, puertos sueltos y "todos"; icmp en su set', () => {
  const l = lines(buildSetsFile(setsInput()));
  assert.ok(
    l.includes(
      `add element inet filter ${RESTRICTED_DESTS_SET} { 192.168.10.50 . tcp . 22, 192.168.10.50 . tcp . 443, 192.168.10.50 . tcp . 8000-8100, 192.168.10.0/28 . udp . 53, 192.168.10.70 . tcp . 1-65535 }`,
    ),
  );
  assert.ok(l.includes(`add element inet filter ${RESTRICTED_ICMP_SET} { 192.168.10.60 }`));
});

test('fichero de sets: sin rangos ni lista solo vacia los sets (no hay "add element")', () => {
  const file = buildSetsFile(setsInput({ ranges: emptyRanges(), destinations: [] }));
  assert.ok(!code(file).includes('add element'));
  assert.equal((file.match(/^flush set /gm) ?? []).length, ALL_SET_NAMES.length);
});

test('fichero de sets: el comentario de la lista nunca se escribe (no hay texto libre)', () => {
  const file = buildSetsFile(
    setsInput({
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
  assert.ok(!code(file).includes('accept'));
  assert.ok(!/[$"]/.test(code(file)));
  assert.ok(!file.includes('drop'));
});

test('el generador rechaza entradas invalidas aunque no pasen por las rutas', () => {
  const dest = (overrides: Partial<RestrictedDestination>): RestrictedDestination => ({
    id: 1,
    destCidr: '192.168.10.5',
    protocol: 'tcp',
    ports: null,
    comment: '',
    ...overrides,
  });
  const bad: Partial<ProfilesSetsInput>[] = [
    { destinations: [dest({ destCidr: '192.168.10.5; flush ruleset' })] },
    { destinations: [dest({ ports: '22; accept' })] },
    { destinations: [dest({ destCidr: '8.8.8.8' })] },
    { destinations: [dest({ destCidr: '192.168.10.29' })] },
    { destinations: [dest({ destCidr: '192.168.10.0/24' })] },
    { destinations: [dest({ protocol: 'icmp', ports: '1' })] },
    // entradas que se solapan (un set de intervalos las rechazaria)
    {
      destinations: [
        dest({ id: 1, destCidr: '192.168.10.0/28', ports: '22' }),
        dest({ id: 2, destCidr: '192.168.10.5', ports: '20-30' }),
      ],
    },
    { destinations: [dest({ id: 1, ports: null }), dest({ id: 2, ports: '80' })] },
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
      () => buildSetsFile(setsInput(overrides)),
      Error,
      JSON.stringify(overrides).slice(0, 90),
    );
  }
});

test('mismo destino con otro protocolo, o puertos que no se pisan, NO es un solape', () => {
  assert.doesNotThrow(() =>
    buildSetsFile(
      setsInput({
        destinations: [
          { id: 1, destCidr: '192.168.10.5', protocol: 'tcp', ports: '53', comment: '' },
          { id: 2, destCidr: '192.168.10.5', protocol: 'udp', ports: '53', comment: '' },
          { id: 3, destCidr: '192.168.10.5', protocol: 'icmp', ports: null, comment: '' },
          { id: 4, destCidr: '192.168.10.5', protocol: 'tcp', ports: '80', comment: '' },
        ],
      }),
    ),
  );
});

/* ------------------------------ fragmento: propiedades ------------------------------ */

const PRIVATE_SET = '{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 }';

test('fragmento: declara los 7 sets VACIOS (5 por perfil + destinos concatenados + icmp), todos de intervalos', () => {
  const { sets } = buildFragmentParts(OPTIONS);
  for (const name of ALL_SET_NAMES) assert.ok(sets.includes(`set ${name} {`), name);
  assert.ok(!sets.includes('elements'), 'los sets se declaran vacios');
  assert.equal((sets.match(/flags interval/g) ?? []).length, 7);
  assert.ok(sets.includes('type ipv4_addr . inet_proto . inet_service'));
});

test('fragmento: falla cerrando: toda regla de forward/input lleva "ip saddr @set" y ninguna acepta sin pertenecer a un set', () => {
  const { forward, input } = buildFragmentParts(OPTIONS);
  for (const line of [...lines(forward), ...lines(input)]) {
    if (!line || line.startsWith('#')) continue;
    assert.match(line, /^meta ipsec exists ip saddr @vpn_[a-z_]+_ips /, line);
    assert.ok(line.endsWith(' accept'), line);
  }
  assert.ok(
    !/\bdrop\b|policy/.test(code(`${forward}\n${input}`)),
    'no toca la policy ni mete drops propios',
  );
});

test('fragmento: lan_full e internet_lan_full -> toda la LAN en forward y acceso a la .29 en input', () => {
  const { forward, input } = buildFragmentParts(OPTIONS);
  const f = lines(forward);
  assert.ok(
    f.includes(
      `meta ipsec exists ip saddr @${PROFILE_SET.lan_full} ip daddr 192.168.10.0/24 accept`,
    ),
  );
  assert.ok(
    f.includes(
      `meta ipsec exists ip saddr @${PROFILE_SET.internet_lan_full} ip daddr 192.168.10.0/24 accept`,
    ),
  );
  const i = lines(input);
  assert.ok(
    i.includes(
      `meta ipsec exists ip saddr @${PROFILE_SET.lan_full} ip daddr ${GATEWAY_HOST} accept`,
    ),
  );
  assert.ok(
    i.includes(
      `meta ipsec exists ip saddr @${PROFILE_SET.internet_lan_full} ip daddr ${GATEWAY_HOST} accept`,
    ),
  );
});

test('fragmento: los demas perfiles no tienen accept de toda la LAN ni acceso a la .29', () => {
  const { forward, input } = buildFragmentParts(OPTIONS);
  for (const profile of ['lan_restricted', 'internet_only', 'internet_lan_restricted'] as const) {
    const mine = lines(forward + '\n' + input).filter((x) =>
      x.includes(`@${PROFILE_SET[profile]}`),
    );
    assert.ok(mine.length > 0, profile);
    assert.ok(!mine.some((x) => x.includes('ip daddr 192.168.10.0/24 accept')), profile);
    assert.ok(!mine.some((x) => x.includes(GATEWAY_HOST)), profile);
  }
});

test('fragmento: perfiles con Internet -> todo salvo redes privadas; sin Internet los lan_*', () => {
  const f = lines(buildFragmentParts(OPTIONS).forward);
  for (const profile of [
    'internet_only',
    'internet_lan_restricted',
    'internet_lan_full',
  ] as const) {
    assert.ok(
      f.includes(
        `meta ipsec exists ip saddr @${PROFILE_SET[profile]} ip daddr != ${PRIVATE_SET} accept`,
      ),
      profile,
    );
  }
  for (const profile of ['lan_restricted', 'lan_full'] as const) {
    assert.ok(!f.some((x) => x.includes(`@${PROFILE_SET[profile]}`) && x.includes('!=')), profile);
  }
});

test('fragmento: restringidos -> accept solo si (daddr, proto, puerto) esta en el set; icmp en su set', () => {
  const f = lines(buildFragmentParts(OPTIONS).forward);
  for (const profile of ['lan_restricted', 'internet_lan_restricted'] as const) {
    assert.ok(
      f.includes(
        `meta ipsec exists ip saddr @${PROFILE_SET[profile]} ip daddr . meta l4proto . th dport @${RESTRICTED_DESTS_SET} accept`,
      ),
    );
    assert.ok(
      f.includes(
        `meta ipsec exists ip saddr @${PROFILE_SET[profile]} ip protocol icmp ip daddr @${RESTRICTED_ICMP_SET} accept`,
      ),
    );
  }
});

test('fragmento: NO duplica la regla de EST 8443 que ya existe en forward (ni ninguna regla hacia la .28:8443)', () => {
  const { forward, input } = buildFragmentParts(OPTIONS);
  assert.ok(!code(`${forward}\n${input}`).includes('8443'));
  assert.ok(!code(`${forward}\n${input}`).includes('ip daddr 192.168.10.28'));
  const text = buildNftablesFragment(OPTIONS, FIXED_DATE);
  assert.ok(
    text.includes(EXISTING_EST_FORWARD_LINE),
    'la cabecera cita la regla existente tras la que se pega la PARTE 2',
  );
});

test('fragmento: todas las reglas llevan "meta ipsec exists" (una IP de origen falsificada desde la LAN fisica no hereda permisos)', () => {
  const { forward, input } = buildFragmentParts(OPTIONS);
  const rules = [...lines(code(forward)), ...lines(code(input))].filter(Boolean);
  assert.ok(rules.length >= 10);
  for (const rule of rules) assert.ok(rule.startsWith('meta ipsec exists '), rule);
});

test('fragmento: con interfaz de salida, las reglas de Internet exigen oifname (solo esas)', () => {
  const f = lines(buildFragmentParts({ ...OPTIONS, egressInterface: 'eth0' }).forward);
  const internet = f.filter((x) => x.includes('ip daddr != {'));
  assert.equal(internet.length, 3);
  assert.ok(internet.every((x) => x.endsWith('oifname "eth0" accept')));
  assert.equal(f.filter((x) => x.includes('oifname')).length, 3);
});

test('fragmento: la parte 4 es el include del fichero de sets, tras la tabla', () => {
  assert.equal(buildFragmentParts(OPTIONS).include, 'include "/etc/nftables.d/vpn-profiles.nft"');
  const text = buildNftablesFragment(OPTIONS, FIXED_DATE);
  assert.ok(text.indexOf('===== PARTE 3') < text.indexOf('===== PARTE 4'));
  assert.ok(text.includes('ELIMINAR estas TRES lineas literales'));
  for (const line of FORWARD_LINES_TO_REMOVE) assert.ok(text.includes(line), line);
  assert.ok(text.includes('0. En la .29: nft --version (>= 0.9.4) y uname -r (>= 5.6)'));
});

test('fragmento: parametros invalidos se rechazan', () => {
  assert.throws(() => buildFragmentParts({ ...OPTIONS, egressInterface: 'eth0"; drop' }));
  assert.throws(() => buildFragmentParts({ ...OPTIONS, lanCidr: '192.168.10.0/24; accept' }));
});

test('integrar el fragmento quita EXACTAMENTE las tres lineas literales de forward y conserva el resto de la .29', () => {
  const { conf, removed } = assembleNftablesConf(OPTIONS, null);
  assert.deepEqual(removed, [...FORWARD_LINES_TO_REMOVE]);
  assert.deepEqual(removed, [
    'meta ipsec exists ip daddr { 192.168.10.28, 192.168.10.30 } drop',
    'meta ipsec exists ip saddr 192.168.10.0/24 ip daddr != 192.168.10.0/24 accept',
    'meta ipsec exists ip saddr 192.168.10.0/24 ip daddr 192.168.10.0/24 accept',
  ]);
  assert.ok(!conf.includes('# QUITAR'));
  for (const line of removed)
    assert.ok(!conf.split('\n').some((l) => l.trim() === line), `sigue presente: ${line}`);
  // Lo que NO se toca: input (lo, ct, icmp/icmpv6, IKE, 3799, SSH) y forward (ct, MSS clamp, EST 8443).
  for (const kept of [
    'iif lo accept',
    'ct state invalid drop',
    'ct state established,related accept',
    'ip protocol icmp accept',
    'meta l4proto ipv6-icmp accept',
    'udp dport { 500, 4500 } accept',
    'ip saddr 192.168.10.28 udp dport 3799 accept',
    'meta ipsec missing ip saddr 192.168.10.0/24 tcp dport 22 accept',
    'tcp flags syn tcp option maxseg size set rt mtu',
    EXISTING_EST_FORWARD_LINE,
  ]) {
    assert.ok(conf.includes(kept), kept);
    assert.ok(FIXTURE_NFTABLES_CONF.includes(kept), kept);
  }
  // Orden en forward: ct, MSS clamp y EST existentes ANTES de las reglas de perfil
  const fwd = conf.slice(conf.indexOf('chain forward'), conf.indexOf('chain output'));
  assert.ok(fwd.indexOf('ct state established,related accept') < fwd.indexOf('maxseg'));
  assert.ok(fwd.indexOf('maxseg') < fwd.indexOf(EXISTING_EST_FORWARD_LINE));
  assert.ok(fwd.indexOf(EXISTING_EST_FORWARD_LINE) < fwd.indexOf('@vpn_lan_full_ips'));
  // En input las reglas de perfil van DESPUES de la de SSH
  const inp = conf.slice(conf.indexOf('chain input'), conf.indexOf('chain forward'));
  assert.ok(inp.indexOf('tcp dport 22 accept') < inp.indexOf('@vpn_lan_full_ips'));
});

/* ----------------------- script de aplicacion: coherencia con el generador ----------------------- */

test('el script de aplicacion gestiona EXACTAMENTE los mismos sets que genera el panel (sin deriva)', () => {
  const script = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'deploy',
      'vpn-gateway-apply-profiles.sh',
    ),
    'utf8',
  );
  const match = /^ALLOWED_SETS="([^"]+)"/m.exec(script);
  assert.ok(match, 'ALLOWED_SETS en el script');
  assert.deepEqual(match![1]!.split(' ').sort(), [...ALL_SET_NAMES].sort());
});

test('el fragmento y el script exigen el fichero vacio ANTES de integrar (--init-empty) y el include no puede apuntar a algo inexistente', () => {
  const text = buildNftablesFragment(OPTIONS, FIXED_DATE);
  assert.ok(text.includes('vpn-gateway-apply-profiles.sh --init-empty'));
  assert.ok(text.includes('arranca SIN firewall'));
  assert.ok(
    text.indexOf('--init-empty') < text.indexOf('PARTE 1: pegar'),
    'el paso del fichero vacio va antes de integrar',
  );
  const script = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'deploy',
      'vpn-gateway-apply-profiles.sh',
    ),
    'utf8',
  );
  assert.ok(script.includes('--init-empty'));
  assert.ok(script.includes('atomic_install'));
  assert.ok(/mv -f "\$tmp" "\$dest"/.test(script), 'sustitucion por rename');
  assert.ok(script.includes('NO existe: al arrancar, nft -f abortaria'));
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
const SKIP_NFT = nftRunner ? false : 'nft no esta disponible en este entorno';

function nftCheck(conf: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vpn-profiles-nft-'));
  const file = join(dir, 'nftables.conf');
  writeFileSync(file, conf);
  const r = spawnSync(nftRunner![0]!, [...nftRunner!.slice(1), '-c', '-f', file], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
}

const NFT_CASES: [string, () => string][] = [
  ['5 perfiles + lista', () => assembleNftablesConf(OPTIONS, buildSetsFile(setsInput())).conf],
  [
    '5 perfiles + interfaz de salida',
    () =>
      assembleNftablesConf({ ...OPTIONS, egressInterface: 'eth0' }, buildSetsFile(setsInput()))
        .conf,
  ],
  ['sets vacios (fragmento sin fichero de sets)', () => assembleNftablesConf(OPTIONS, null).conf],
  [
    'sin rangos ni lista',
    () =>
      assembleNftablesConf(
        OPTIONS,
        buildSetsFile(setsInput({ ranges: emptyRanges(), destinations: [] })),
      ).conf,
  ],
  ...ACCESS_PROFILES.map((p): [string, () => string] => [
    `solo ${p}`,
    () => assembleNftablesConf(OPTIONS, buildSetsFile(setsInput({ ranges: rangesOnly(p) }))).conf,
  ]),
];

for (const [name, build] of NFT_CASES) {
  test(`nft -c -f acepta el nftables.conf ensamblado: ${name}`, { skip: SKIP_NFT }, () =>
    nftCheck(build()),
  );
}

test(
  'nft -c -f rechaza un fichero de sets sobre sets que no existen (el script lo detecta antes con un mensaje claro)',
  { skip: SKIP_NFT },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'vpn-profiles-nft-'));
    const file = join(dir, 'sets.nft');
    writeFileSync(file, buildSetsFile(setsInput()));
    const r = spawnSync(nftRunner![0]!, [...nftRunner!.slice(1), '-c', '-f', file], {
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
  },
);

/* ----------------- pruebas funcionales con paquetes (NFT_FUNCTIONAL=1, Linux) ----------------- */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FUNCTIONAL_SKIP =
  process.env.NFT_FUNCTIONAL !== '1'
    ? 'solo con NFT_FUNCTIONAL=1 (Linux, nft, iproute2, nsenter y python3; tarda un par de minutos)'
    : process.platform !== 'linux'
      ? 'solo en Linux'
      : false;

function runNetnsScript(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vpn-profiles-func-'));
  const sets = buildSetsFile(setsInput());
  writeFileSync(join(dir, 'vpn-profiles.nft'), sets);
  writeFileSync(join(dir, 'nftables.conf.ensamblado'), assembleNftablesConf(OPTIONS, sets).conf);
  writeFileSync(
    join(dir, 'nftables.conf.ensamblado-sets-vacios'),
    assembleNftablesConf(OPTIONS, null).conf,
  );
  const r = spawnSync('unshare', ['-rn', 'bash', join(REPO_ROOT, 'deploy', script), dir], {
    encoding: 'utf8',
    timeout: 280_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
}

test(
  'funcional: veredicto de cada perfil hacia .28/.29/.30, otra IP de la LAN e Internet (netns real)',
  { skip: FUNCTIONAL_SKIP, timeout: 300_000 },
  () => {
    runNetnsScript('test-vpn-profiles-netns.sh');
  },
);

test(
  'funcional: vpn-gateway-apply-profiles.sh con nft real (confirmar, revertir, SSH muerto)',
  { skip: FUNCTIONAL_SKIP, timeout: 300_000 },
  () => {
    runNetnsScript('test-apply-profiles-netns.sh');
  },
);
