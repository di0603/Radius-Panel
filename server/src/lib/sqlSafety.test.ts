import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Ninguna migracion de sql/ puede borrar tablas ni filas: son ficheros que se
 * aplican contra bases de datos reales (algunas con datos de produccion,
 * como la fila de prueba "vps" en vpn_certificates) y tienen que poder
 * revertirse a mano si algo sale mal. DROP COLUMN si esta permitido (evoluciona
 * el esquema, no borra datos de negocio).
 */
const SQL_DIR = join(import.meta.dirname, '..', '..', '..', 'sql');
const FORBIDDEN: [name: string, pattern: RegExp][] = [
  ['DROP TABLE', /\bDROP\s+TABLE\b/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['DELETE FROM', /\bDELETE\s+FROM\b/i],
];

test('las migraciones de sql/ no contienen DROP TABLE, TRUNCATE ni DELETE FROM', () => {
  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, `no se encontraron ficheros .sql en ${SQL_DIR}`);

  const offenders: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(SQL_DIR, file), 'utf8');
    for (const [name, pattern] of FORBIDDEN) {
      if (pattern.test(content)) offenders.push(`${file}: contiene ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});
