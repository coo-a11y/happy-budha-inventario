#!/usr/bin/env node
/**
 * tests/import-guard.test.js — Production Map Import Write Guard (unitario/simulado).
 * NO se conecta a ninguna base. Runner async real.
 *
 * Uso: node tests/import-guard.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { evaluateImportGuard, REQUIRED_ENV, REQUIRED_CONFIRM } = require('../scripts/lib/import-guard.js');
const M = require('../scripts/import-farm-map-db.js');

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
const OK_ENV = { FARM_OS_DB_ENV: REQUIRED_ENV, FARM_OS_PRODUCTION_IMPORT_CONFIRM: REQUIRED_CONFIRM };
const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-farm-map-db.js');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

console.log('\n=========  TESTS: Production Map Import Guard  =========\n');

test('local real apply → permitido (sin variables de deploy)', () => {
  const g = evaluateImportGuard({}, LOCAL, false);
  assert.ok(g.allowed && !g.blocked && g.isRemote === false);
});
test('remote apply SIN variables → BLOCKED', () => {
  const g = evaluateImportGuard({}, REMOTE, false);
  assert.ok(g.blocked && g.reason === 'PRODUCTION MAP IMPORT BLOCKED' && g.missing.length === 2);
});
test('remote apply con SOLO FARM_OS_DB_ENV → BLOCKED', () => {
  const g = evaluateImportGuard({ FARM_OS_DB_ENV: REQUIRED_ENV }, REMOTE, false);
  assert.ok(g.blocked && g.missing.some(m => /FARM_OS_PRODUCTION_IMPORT_CONFIRM/.test(m)));
});
test('remote apply con SOLO confirmación → BLOCKED', () => {
  const g = evaluateImportGuard({ FARM_OS_PRODUCTION_IMPORT_CONFIRM: REQUIRED_CONFIRM }, REMOTE, false);
  assert.ok(g.blocked && g.missing.some(m => /FARM_OS_DB_ENV/.test(m)));
});
test('remote apply con AMBOS valores exactos → permitido por el guard', () => {
  const g = evaluateImportGuard(OK_ENV, REMOTE, false);
  assert.ok(g.allowed && !g.blocked && g.isRemote === true);
});
test('valores INCORRECTOS → BLOCKED', () => {
  assert.ok(evaluateImportGuard({ FARM_OS_DB_ENV: 'PRODUCTION', FARM_OS_PRODUCTION_IMPORT_CONFIRM: REQUIRED_CONFIRM }, REMOTE, false).blocked);
  assert.ok(evaluateImportGuard({ FARM_OS_DB_ENV: REQUIRED_ENV, FARM_OS_PRODUCTION_IMPORT_CONFIRM: 'yes' }, REMOTE, false).blocked);
  assert.ok(evaluateImportGuard({ FARM_OS_DB_ENV: REQUIRED_ENV + ' ', FARM_OS_PRODUCTION_IMPORT_CONFIRM: REQUIRED_CONFIRM }, REMOTE, false).blocked);
});
test('--dry-run remoto → permitido sin variables (cero escrituras)', () => {
  assert.ok(evaluateImportGuard({}, REMOTE, true).allowed);
});
test('hosts locales (localhost/127.0.0.1/::1) no requieren guard', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) assert.ok(evaluateImportGuard({}, `postgres://u:p@${h}:5432/x`, false).allowed);
});

test('el guard se evalúa ANTES de conectar / BEGIN / INSERT (orden en import-farm-map-db.js)', () => {
  const iGuard = SRC.indexOf('evaluateImportGuard(env, url, false)');
  const iPool = SRC.indexOf('new Pool(');
  const iBegin = SRC.indexOf("client.query('BEGIN')");
  assert.ok(iGuard > -1 && iGuard < iPool, 'el guard debe evaluarse antes de new Pool');
  // BEGIN precede a todos los INSERT del apply, así que guard<BEGIN ⇒ guard antes de escrituras.
  assert.ok(iGuard < iBegin, 'el guard debe evaluarse antes de BEGIN (y por tanto de cualquier INSERT/DDL)');
});

// Estado inicial compatible (0/0/0 o 1/58/38); cualquier otra cosa → error → ROLLBACK.
const mkQ = (fs2, gz, ga) => async () => ({ rows: [{ fs: fs2, gz, ga }] });
test('assertInitialStateCompatible: base vacía (0/0/0) → OK', async () => {
  const r = await M.assertInitialStateCompatible(mkQ(0, 0, 0));
  assert.ok(r.zero && !r.canonical);
});
test('assertInitialStateCompatible: dataset canónico (1/58/38) → OK', async () => {
  const r = await M.assertInitialStateCompatible(mkQ(1, 58, 38));
  assert.ok(r.canonical);
});
test('assertInitialStateCompatible: estado parcial (1/57/38) → BLOCKED', async () => {
  await assert.rejects(() => M.assertInitialStateCompatible(mkQ(1, 57, 38)), /PRODUCTION MAP IMPORT BLOCKED/);
});
test('assertInitialStateCompatible: datos inesperados (2/58/38) → BLOCKED', async () => {
  await assert.rejects(() => M.assertInitialStateCompatible(mkQ(2, 58, 38)), /incompatible/);
});

// Prueba de proceso: import remoto sin variables → BLOCKED + exit 1, SIN conectar.
test('spawn: apply remoto (PRODUCTION_IMPORT) sin confirmación imprime BLOCKED y sale 1', () => {
  const res = cp.spawnSync('node', [SCRIPT, '--apply'], { encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, { FARM_OS_DB_ENV: 'PRODUCTION_IMPORT', FARM_OS_PRODUCTION_IMPORT_CONFIRM: '', FARM_OS_PRODUCTION_IMPORT_DATABASE_URL: REMOTE }) });
  assert.strictEqual(res.status, 1);
  assert.ok(/PRODUCTION MAP IMPORT BLOCKED/.test(res.stdout + res.stderr));
});

// ---------- 2E.1C: SSL host-aware para PRODUCTION_IMPORT ----------
const SSL = require('../scripts/lib/db-ssl.js');
test('PRODUCTION_IMPORT + 127.0.0.1 → SSL deshabilitado', () => {
  assert.strictEqual(SSL.resolveHostAwareSsl('postgresql://u:p@127.0.0.1:55432/db'), false);
});
test('PRODUCTION_IMPORT + localhost → SSL deshabilitado', () => {
  assert.strictEqual(SSL.resolveHostAwareSsl('postgresql://u:p@localhost:55432/db'), false);
});
test('PRODUCTION_IMPORT + ::1 → SSL deshabilitado', () => {
  assert.strictEqual(SSL.resolveHostAwareSsl('postgresql://u:p@[::1]:55432/db'), false);
});
test('PRODUCTION_IMPORT + host remoto → SSL habilitado', () => {
  assert.deepStrictEqual(SSL.resolveHostAwareSsl('postgresql://u:p@shuttle.proxy.rlwy.net:12345/railway'), { rejectUnauthorized: false });
});
test('resolveMigrateSsl reutiliza la política host-aware (no duplica lógica)', () => {
  assert.strictEqual(SSL.resolveMigrateSsl('postgres://u:p@127.0.0.1:5432/x'), false);
  assert.deepStrictEqual(SSL.resolveMigrateSsl('postgres://u:p@db.example.com:5432/x'), { rejectUnauthorized: false });
});
test('el importador resuelve SSL por HOST (usa resolveHostAwareSsl) y el guard va antes del Pool', () => {
  const iSsl = SRC.indexOf('resolveHostAwareSsl(url)');
  const iGuard = SRC.indexOf('evaluateImportGuard(env, url, false)');
  const iPool = SRC.indexOf('new Pool(');
  assert.ok(iSsl > -1, 'la rama PRODUCTION_IMPORT debe usar resolveHostAwareSsl(url)');
  assert.ok(!/PRODUCTION_IMPORT'\)\s*\{[\s\S]*?rejectUnauthorized: false/.test(SRC.slice(SRC.indexOf("=== 'PRODUCTION_IMPORT'"), iPool)), 'la rama no debe fijar SSL por modo');
  assert.ok(iGuard < iPool, 'el guard debe evaluarse antes de crear el Pool');
});

// ---------- 2E.1D: el mensaje final de COMMIT NO está hardcodeado a TEST ----------
test('el log final de COMMIT usa el entorno real (no "en TEST" hardcodeado)', () => {
  assert.ok(!/Importación aplicada en TEST/.test(SRC), 'no debe estar hardcodeado a TEST');
  assert.ok(/Importación aplicada en \$\{env\.FARM_OS_DB_ENV\}/.test(SRC), 'debe interpolar env.FARM_OS_DB_ENV');
});

runTests();
