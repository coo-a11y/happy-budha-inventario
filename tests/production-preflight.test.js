#!/usr/bin/env node
/**
 * tests/production-preflight.test.js — Pruebas del preflight de producción (READ-ONLY).
 * NO conecta a ninguna base. Runner async real (se esperan las Promises).
 *
 * Uso: node tests/production-preflight.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../scripts/farm-os-production-preflight.js');
const { lintAdditive } = require('../scripts/lib/migration-lint.js');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
process.on('unhandledRejection', (e) => { console.error('❌ unhandledRejection:', e && e.message || e); process.exit(1); });
async function runTests() {
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✅ ${t.name}`); pass++; }
    catch (e) { console.log(`  ❌ ${t.name}\n       ${e.message}`); fail++; }
  }
  console.log(`\nResultado: ${pass} OK, ${fail} fallos.\n`);
  process.exit(fail ? 1 : 0);
}

const SCRIPT = path.join(__dirname, '..', 'scripts', 'farm-os-production-preflight.js');
const SRC = fs.readFileSync(SCRIPT, 'utf8');
// Fuente sin comentarios (los comentarios mencionan palabras clave a propósito).
const SRC_NOCOMMENTS = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const SQL_002 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '002_farm_location_foundation.sql'), 'utf8');

console.log('\n=========  TESTS: production preflight (READ-ONLY)  =========\n');

test('assertSelectOnly: permite SELECT y bloquea escrituras', () => {
  assert.doesNotThrow(() => P.assertSelectOnly('SELECT 1'));
  assert.doesNotThrow(() => P.assertSelectOnly('  select current_database()'));
  for (const bad of ['INSERT INTO x VALUES(1)', 'UPDATE x SET a=1', 'DELETE FROM x', 'ALTER TABLE x ADD y int', 'CREATE TABLE x(id int)', 'DROP TABLE x', 'TRUNCATE x'])
    assert.throws(() => P.assertSelectOnly(bad), /BLOQUEADO/, `debía bloquear: ${bad}`);
});

test('el script NO contiene sentencias de escritura (fuera de comentarios)', () => {
  const bad = [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w/i, /\bDELETE\s+FROM\b/i, /\bALTER\s+TABLE\b/i, /\bCREATE\s+TABLE\b/i, /\bDROP\s+TABLE\b/i, /\bTRUNCATE\b/i];
  const hit = bad.find(r => r.test(SRC_NOCOMMENTS));
  assert.ok(!hit, `patrón de escritura encontrado: ${hit && hit.source}`);
});

test('el script NO lee process.env.DATABASE_URL', () => {
  assert.ok(!/process\.env\.DATABASE_URL\b/.test(SRC), 'no debe leer DATABASE_URL');
  // sí debe usar la variable de producción específica
  assert.ok(/FARM_OS_PRODUCTION_DATABASE_URL/.test(SRC));
});

test('checkPreflightEnv exige FARM_OS_DB_ENV=PRODUCTION_PREFLIGHT y la URL', () => {
  assert.ok(!P.checkPreflightEnv({}).ok);
  assert.ok(!P.checkPreflightEnv({ FARM_OS_DB_ENV: 'TEST', FARM_OS_PRODUCTION_DATABASE_URL: 'x' }).ok, 'ENV incorrecto debe fallar');
  assert.ok(!P.checkPreflightEnv({ FARM_OS_DB_ENV: 'PRODUCTION_PREFLIGHT' }).ok, 'sin URL debe fallar');
  assert.ok(P.checkPreflightEnv({ FARM_OS_DB_ENV: 'PRODUCTION_PREFLIGHT', FARM_OS_PRODUCTION_DATABASE_URL: 'postgres://h/db' }).ok);
});

test('--run sin env correcto aborta (exit 1) y no conecta', () => {
  const res = require('child_process').spawnSync('node', [SCRIPT], { encoding: 'utf8', env: Object.assign({}, process.env, { FARM_OS_DB_ENV: '', FARM_OS_PRODUCTION_DATABASE_URL: '', DATABASE_URL: 'postgres://prod/should-not-use' }) });
  assert.strictEqual(res.status, 1);
});

test('revisa EXACTAMENTE las 8 tablas históricas', () => {
  assert.deepStrictEqual(P.HISTORICAL_TABLES.slice().sort(), ['conversiones', 'cultivo_calendario', 'lotes', 'mediciones', 'movimientos', 'productos', 'produccion', 'usuarios'].sort());
  assert.strictEqual(P.HISTORICAL_TABLES.length, 8);
});

test('conoce las 5 tablas nuevas para el conflict-check', () => {
  assert.deepStrictEqual(P.NEW_TABLES.slice().sort(), ['farm_sites', 'geo_zone_aliases', 'geo_zones', 'worker_devices', 'workers'].sort());
});

test('checkConflicts detecta si YA existe alguna de las 5 tablas nuevas', async () => {
  // Mock: geo_zones ya existe → conflicto
  const qConflict = async (sql) => ({ rows: [{ exists: /geo_zones/.test(sql) }] });
  const c = await P.checkConflicts(qConflict);
  assert.ok(c.includes('geo_zones'));
  // Mock: ninguna existe → sin conflicto
  const qNone = async () => ({ rows: [{ exists: false }] });
  assert.strictEqual((await P.checkConflicts(qNone)).length, 0);
});

test('buildSnapshot solo consulta las 8 tablas históricas (read-only)', async () => {
  const seen = new Set();
  const q = async (sql, params = []) => {
    if (/to_regclass/.test(sql)) { const m = sql.match(/public\.(\w+)/); if (m) seen.add(m[1]); return { rows: [{ exists: false }] }; }
    return { rows: [{}] };
  };
  const snap = await P.buildSnapshot(q);
  assert.strictEqual(snap.length, 8);
  assert.deepStrictEqual([...seen].sort(), P.HISTORICAL_TABLES.slice().sort());
});

test('safeHost devuelve solo el hostname (nunca la contraseña)', () => {
  assert.strictEqual(P.safeHost('postgres://user:supersecret@db.example.com:5432/mydb'), 'db.example.com');
  assert.ok(!/supersecret/.test(P.safeHost('postgres://user:supersecret@db.example.com:5432/mydb')));
});

test('no se imprime la URL/credencial completa en el código', () => {
  // No debe haber console.log de la URL de producción cruda
  assert.ok(!/console\.log\([^)]*FARM_OS_PRODUCTION_DATABASE_URL/.test(SRC));
});

test('002 sigue siendo aditiva (solo CREATE TABLE/INDEX, sin tablas históricas)', () => {
  const lint = lintAdditive(SQL_002, P.HISTORICAL_TABLES);
  assert.ok(lint.ok, 'findings: ' + lint.findings.join('; '));
  assert.ok(lint.statements >= 12);
  // sanity: una migración con ALTER debe fallar el lint
  assert.ok(!lintAdditive('ALTER TABLE productos ADD COLUMN x int;', P.HISTORICAL_TABLES).ok);
  // sanity: referenciar una tabla histórica debe fallar
  assert.ok(!lintAdditive('CREATE INDEX i ON productos(id);', P.HISTORICAL_TABLES).ok);
});

test('analyzeMigration002 lee el archivo real y lo reporta aditivo', () => {
  const r = P.analyzeMigration002();
  assert.ok(r.ok, 'findings: ' + r.findings.join('; '));
});

runTests();
