import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUtcDateTime } from './dates.js';

test('formatUtcDateTime: formatea en UTC sin importar el huso horario del proceso', () => {
  const d = new Date(Date.UTC(2026, 0, 1, 12, 30, 45));
  assert.equal(formatUtcDateTime(d), '2026-01-01 12:30:45');
});

test('formatUtcDateTime: no arrastra milisegundos', () => {
  const d = new Date(Date.UTC(2026, 5, 15, 0, 0, 0, 999));
  assert.equal(formatUtcDateTime(d), '2026-06-15 00:00:00');
});
