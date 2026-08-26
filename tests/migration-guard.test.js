#!/usr/bin/env node
/**
 * tests/migration-guard.test.js — Production Migration Write Guard (unitario/simulado).
 * NO se conecta a ninguna base. Runner async real.
 *
 * Uso: node tests/migration-guard.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { evaluateMigrationGuard, REQUIRED_ENV, REQUIRED_CONFIRM } = require('../scripts/lib/migration-guard.js');

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

const LOCAL = 'postgres://u:p@127.0.0.1:5432/hb_farm_os_test';
const REMOTE = 'postgres://u:p@db.example.com:5432/railway';
const OK_ENV = { FARM_OS_DB_ENV: REQUIRED_ENV, FARM_OS_PRODUCTION_MIGRATION_CONFIRM: REQUIRED_CONFIRM };
const MIGRATE = path.join(__dirname, '..', 'scripts', 'migrate.js');
const SRC = fs.readFileSync(MIGRATE, 'utf8');

console.log('\n=========  TESTS: Production Migration Write Guard  =========\n');

test('local real apply → permitido (sin variables de deploy)', () => {
  const g = evaluateMigrationGuard({}, LOCAL, false);
  assert.ok(g.allowed && !g.blocked && g.isRemote === false);
});

test('remote apply SIN variables → BLOCKED', () => {
  const g = evaluateMigrationGuard({}, REMOTE, false);
  assert.ok(g.blocked && !g.allowed);
  assert.strictEqual(g.reason, 'PRODUCTION MIGRATION BLOCKED');
  assert.strictEqual(g.missing.length, 2);
});

test('remote apply con SOLO FARM_OS_DB_ENV → BLOCKED', () => {
  const g = evaluateMigrationGuard({ FARM_OS_DB_ENV: REQUIRED_ENV }, REMOTE, false);
  assert.ok(g.blocked);
  assert.ok(g.missing.some(m => /FARM_OS_PRODUCTION_MIGRATION_CONFIRM/.test(m)));
});

test('remote apply con SOLO confirmación → BLOCKED', () => {
  const g = evaluateMigrationGuard({ FARM_OS_PRODUCTION_MIGRATION_CONFIRM: REQUIRED_CONFIRM }, REMOTE, false);
  assert.ok(g.blocked);
  assert.ok(g.missing.some(m => /FARM_OS_DB_ENV/.test(m)));
});

test('remote apply con AMBOS valores exactos → permitido por el guard', () => {
  const g = evaluateMigrationGuard(OK_ENV, REMOTE, false);
  assert.ok(g.allowed && !g.blocked && g.isRemote === true);
});

test('valor INCORRECTO (env o confirm) → BLOCKED', () => {
  assert.ok(evaluateMigrationGuard({ FARM_OS_DB_ENV: 'PRODUCTION', FARM_OS_PRODUCTION_MIGRATION_CONFIRM: REQUIRED_CONFIRM }, REMOTE, false).blocked);
  assert.ok(evaluateMigrationGuard({ FARM_OS_DB_ENV: REQUIRED_ENV, FARM_OS_PRODUCTION_MIGRATION_CONFIRM: 'yes' }, REMOTE, false).blocked);
  // valores correctos pero con espacios NO valen (exactitud)
  assert.ok(evaluateMigrationGuard({ FARM_OS_DB_ENV: ' PRODUCTION_DEPLOY', FARM_OS_PRODUCTION_MIGRATION_CONFIRM: REQUIRED_CONFIRM }, REMOTE, false).blocked);
});

test('--dry-run remoto → permitido sin variables de deploy (cero escrituras)', () => {
  const g = evaluateMigrationGuard({}, REMOTE, true);
  assert.ok(g.allowed && !g.blocked);
});

test('hosts locales (localhost/127.0.0.1/::1) no requieren guard', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) {
    const g = evaluateMigrationGuard({}, `postgres://u:p@${h}:5432/x`, false);
    assert.ok(g.allowed && g.isRemote === false, `host ${h} debería ser local`);
  }
});

test('el guard se evalúa ANTES de conectar / CREATE / BEGIN (orden en migrate.js)', () => {
  const iGuard = SRC.indexOf('evaluateMigrationGuard(process.env');
  const iPool = SRC.indexOf('new Pool(');
  const iCreate = SRC.indexOf('CREATE TABLE IF NOT EXISTS');
  const iBegin = SRC.indexOf("client.query('BEGIN')");
  assert.ok(iGuard > -1, 'debe invocar el guard');
  assert.ok(iGuard < iPool, 'el guard debe evaluarse antes de new Pool');
  assert.ok(iCreate === -1 || iGuard < iCreate, 'el guard debe evaluarse antes de CREATE');
  assert.ok(iBegin === -1 || iGuard < iBegin, 'el guard debe evaluarse antes de BEGIN');
  assert.ok(/process\.exitCode = 1;\s*\n\s*return;/.test(SRC.slice(iGuard, iPool)), 'debe abortar (return) al bloquear');
});

// Prueba de proceso: remoto sin variables → imprime BLOCKED y sale 1, SIN conectar.
test('spawn: apply remoto sin variables imprime PRODUCTION MIGRATION BLOCKED y sale 1', () => {
  const res = cp.spawnSync('node', [MIGRATE], { encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, { DATABASE_URL: REMOTE, FARM_OS_DB_ENV: '', FARM_OS_PRODUCTION_MIGRATION_CONFIRM: '' }) });
  assert.strictEqual(res.status, 1, 'debe salir con código 1');
  assert.ok(/PRODUCTION MIGRATION BLOCKED/.test(res.stdout), 'debe imprimir el bloqueo');
});

// Prueba de proceso: local no imprime BLOCKED (el guard permite; la conexión luego puede fallar).
test('spawn: apply local NO es bloqueado por el guard', () => {
  const res = cp.spawnSync('node', [MIGRATE], { encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, { DATABASE_URL: 'postgres://u:p@127.0.0.1:5599/x', FARM_OS_DB_ENV: '', FARM_OS_PRODUCTION_MIGRATION_CONFIRM: '' }) });
  assert.ok(!/PRODUCTION MIGRATION BLOCKED/.test(res.stdout + res.stderr), 'un host local no debe ser bloqueado por el guard');
});

runTests();
