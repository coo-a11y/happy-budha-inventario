#!/usr/bin/env node
/**
 * tests/verify-production.test.js — Verificador canónico de PRODUCCIÓN (READ-ONLY).
 * NO conecta a ninguna base: mock respaldado por el dataset real. Runner async real.
 *
 * Uso: node tests/verify-production.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const V = require('../scripts/verify-production-farm-map.js');
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

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-production-farm-map.js');
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const norm = JSON.parse(fs.readFileSync(M.NORMALIZED, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const C1_38 = /^C([1-9]|[12][0-9]|3[0-8])$/;

function buildModel() {
  const zones = norm.zones.map((z, i) => ({ id: i + 1, code: z.proposed_code, name: z.proposed_name, zone_type: z.proposed_zone_type, parent_code: z.proposed_parent_code, polygon_geojson: clone(z.polygon_geojson) }));
  const codeToId = new Map(zones.map(z => [z.code, z.id]));
  zones.forEach(z => { z.parent_zone_id = z.parent_code != null ? (codeToId.get(z.parent_code) ?? null) : null; });
  const farmSite = { id: 1000, code: norm.farm_site.code, name: norm.farm_site.name, boundary_geojson: clone(norm.farm_site.boundary_geojson) };
  const aliases = norm.alias_proposals.map(a => ({ geo_zone_id: codeToId.get(a.proposed_geo_zone_code) ?? null, alias: a.alias, source_context: a.source_context }));
  return { farmSite, zones, aliases, workers: 0, workerDevices: 0 };
}

function makeDb(model) {
  const state = { writes: 0 };
  const zoneByCode = (c) => model.zones.find(z => z.code === c);
  const zoneById = (id) => model.zones.find(z => z.id === id);
  const q = async (sql, params = []) => {
    if (!/^\s*SELECT/i.test(sql)) { state.writes++; return { rows: [{}] }; }
    const rows = (a) => ({ rows: a });
    const t = sql.replace(/\s+/g, ' ').trim();
    // COUNTS globales exactos
    if (t === 'SELECT COUNT(*)::int c FROM farm_sites') return rows([{ c: model.farmSite ? 1 : 0 }]);
    if (t === 'SELECT COUNT(*)::int c FROM geo_zones') return rows([{ c: model.zones.length }]);
    if (t === 'SELECT COUNT(*)::int c FROM geo_zone_aliases') return rows([{ c: model.aliases.length }]);
    if (t === 'SELECT COUNT(*)::int c FROM workers') return rows([{ c: model.workers }]);
    if (t === 'SELECT COUNT(*)::int c FROM worker_devices') return rows([{ c: model.workerDevices }]);
    // farm_sites (finca-scoped)
    if (/COUNT\(\*\)::int c FROM farm_sites WHERE code/.test(sql)) return rows([{ c: model.farmSite.code === params[0] ? 1 : 0 }]);
    if (/SELECT id, code, name, boundary_geojson FROM farm_sites WHERE code/.test(sql)) return rows(model.farmSite.code === params[0] ? [{ id: model.farmSite.id, code: model.farmSite.code, name: model.farmSite.name, boundary_geojson: model.farmSite.boundary_geojson }] : []);
    if (/SELECT id, code, boundary_geojson FROM farm_sites WHERE code/.test(sql)) return rows([{ id: model.farmSite.id, code: model.farmSite.code, boundary_geojson: model.farmSite.boundary_geojson }]);
    // geo_zones
    if (/FROM geo_zones WHERE farm_site_id = \$1 AND polygon_geojson IS NULL/.test(sql)) return rows([{ c: model.zones.filter(z => z.polygon_geojson == null).length }]);
    if (/COUNT\(\*\)::int c FROM geo_zones WHERE farm_site_id/.test(sql)) return rows([{ c: model.zones.length }]);
    // aliases
    if (/z\.code <> \('HB-' \|\| a\.alias\)/.test(sql)) return rows([{ c: model.aliases.filter(a => /^C[0-9]+$/.test(a.alias)).filter(a => { const z = zoneById(a.geo_zone_id); return !z || z.code !== 'HB-' + a.alias; }).length }]);
    if (/source_context = 'general'/.test(sql)) return rows([{ c: model.aliases.filter(a => C1_38.test(a.alias) && a.source_context === 'general').length }]);
    if (/alias IN \('C39'/.test(sql)) return rows([{ c: model.aliases.filter(a => ['C39', 'C40', 'C41', 'C42'].includes(a.alias)).length }]);
    if (/a\.alias ~ '\^C\(/.test(sql)) return rows([{ c: model.aliases.filter(a => C1_38.test(a.alias)).length }]);
    // parentOf / zone_type / invariantes
    if (/LEFT JOIN geo_zones p ON p\.id = z\.parent_zone_id/.test(sql)) { const z = zoneByCode(params[1]); return rows(z ? [{ parent_code: z.parent_code ?? null }] : []); }
    if (/SELECT zone_type FROM geo_zones WHERE farm_site_id = \$1 AND code = \$2/.test(sql)) { const z = zoneByCode(params[1]); return rows(z ? [{ zone_type: z.zone_type }] : []); }
    if (/WHERE parent_zone_id = id/.test(sql)) return rows([{ c: model.zones.filter(z => z.parent_zone_id === z.id).length }]);
    if (/z\.farm_site_id <> p\.farm_site_id/.test(sql)) return rows([{ c: 0 }]);
    if (/GROUP BY farm_site_id, code/.test(sql)) return rows([{ c: 0 }]);
    if (/GROUP BY geo_zone_id, alias/.test(sql)) return rows([{ c: 0 }]);
    if (/SELECT id, code, name, zone_type, parent_zone_id, polygon_geojson FROM geo_zones WHERE farm_site_id/.test(sql))
      return rows(model.zones.map(z => ({ id: z.id, code: z.code, name: z.name, zone_type: z.zone_type, parent_zone_id: z.parent_zone_id, polygon_geojson: z.polygon_geojson })));
    if (/SELECT id FROM geo_zone_aliases WHERE geo_zone_id = \$1 AND alias = \$2/.test(sql)) {
      const [zid, alias, ctx] = params;
      const hit = model.aliases.find(a => a.geo_zone_id === zid && a.alias === alias && (a.source_context || '') === (ctx || ''));
      return rows(hit ? [{ id: 1 }] : []);
    }
    return rows([{}]);
  };
  return { q, state };
}

console.log('\n=========  TESTS: verificador canónico de PRODUCCIÓN (READ-ONLY)  =========\n');

// ---- Barreras de entorno ----
test('env incorrecto → BLOCKED', () => {
  assert.ok(!V.checkEnv({ FARM_OS_DB_ENV: 'TEST', FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL: 'x' }).ok);
});
test('falta URL → BLOCKED', () => {
  assert.ok(!V.checkEnv({ FARM_OS_DB_ENV: 'PRODUCTION_MAP_VERIFY' }).ok);
});
test('env + URL correctos → OK', () => {
  assert.ok(V.checkEnv({ FARM_OS_DB_ENV: 'PRODUCTION_MAP_VERIFY', FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL: 'postgres://h/db' }).ok);
});
test('NUNCA lee DATABASE_URL / IMPORT / TEST (fuera de comentarios)', () => {
  // Los nombres prohibidos pueden mencionarse en comentarios (como prohibición); se analiza
  // el código sin comentarios para confirmar que no se LEEN.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.ok(!/\bDATABASE_URL\b/.test(code.replace(/FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL/g, ' ')), 'no debe usar DATABASE_URL/IMPORT/TEST');
  assert.ok(!/FARM_OS_PRODUCTION_IMPORT_DATABASE_URL/.test(code));
  assert.ok(!/FARM_OS_TEST_DATABASE_URL/.test(code));
  assert.ok(/FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL/.test(code), 'debe usar su propia variable');
});
test('spawn: sin env correcto aborta (exit 1) y no conecta', () => {
  const res = cp.spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15000, env: Object.assign({}, process.env, { FARM_OS_DB_ENV: '', FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL: '', DATABASE_URL: 'postgres://prod/no' }) });
  assert.strictEqual(res.status, 1);
});

// ---- Barrera SELECT-only ----
test('SELECT permitido; INSERT/UPDATE/DELETE/ALTER/CREATE/DROP/TRUNCATE y multi-statement rechazados', () => {
  assert.doesNotThrow(() => V.assertSelectOnly('SELECT 1'));
  for (const bad of ['INSERT INTO x VALUES(1)', 'UPDATE x SET a=1', 'DELETE FROM x', 'ALTER TABLE x ADD y int', 'CREATE TABLE x(id int)', 'DROP TABLE x', 'TRUNCATE x', 'SELECT 1; DELETE FROM x', 'SELECT 1; DROP TABLE x'])
    assert.throws(() => V.assertSelectOnly(bad), /BLOQUEADO/, `debía rechazar: ${bad}`);
});

// ---- Verificación canónica ----
test('dataset canónico → PASS (y cero escrituras)', async () => {
  const { q, state } = makeDb(buildModel());
  const r = await V.runCanonicalVerification(q, norm);
  assert.ok(r.ok, 'checks fallidos: ' + r.checks.filter(c => !c.ok).map(c => c.name).join('; '));
  assert.strictEqual(state.writes, 0, 'no debe escribir');
});
test('geometría alterada → FAIL', async () => {
  const m = buildModel(); m.zones[10].polygon_geojson.coordinates[0][0][0] += 0.001;
  const { q, state } = makeDb(m);
  const r = await V.runCanonicalVerification(q, norm);
  assert.ok(!r.ok && state.writes === 0);
});
test('alias alterado → FAIL', async () => {
  const m = buildModel(); m.aliases.find(a => a.alias === 'C7').alias = 'C99';
  const r = await V.runCanonicalVerification(makeDb(m).q, norm);
  assert.ok(!r.ok);
});
test('hierarchy alterada → FAIL', async () => {
  const m = buildModel(); const z = m.zones.find(x => x.code === 'HB-C10'); z.parent_code = 'HB-CAMPO-C1-C4'; z.parent_zone_id = m.zones.find(x => x.code === 'HB-CAMPO-C1-C4').id;
  const r = await V.runCanonicalVerification(makeDb(m).q, norm);
  assert.ok(!r.ok);
});
test('review != 0 (dataset esperado) → FAIL', async () => {
  const bad = clone(norm); bad.zones[0].review = true;
  const r = await V.runCanonicalVerification(makeDb(buildModel()).q, bad);
  assert.ok(!r.ok);
});
test('C39 presente → FAIL', async () => {
  const m = buildModel(); m.aliases.push({ geo_zone_id: 1, alias: 'C39', source_context: 'general' });
  const r = await V.runCanonicalVerification(makeDb(m).q, norm);
  assert.ok(!r.ok);
});
test('conteos incorrectos (workers=1) → FAIL', async () => {
  const m = buildModel(); m.workers = 1;
  const r = await V.runCanonicalVerification(makeDb(m).q, norm);
  assert.ok(!r.ok && r.checks.find(c => c.name === 'workers = 0' && !c.ok));
});

runTests();
