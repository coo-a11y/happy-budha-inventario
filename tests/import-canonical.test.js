#!/usr/bin/env node
/**
 * tests/import-canonical.test.js — Verificación canónica del estado inicial (2E.1B).
 * NO conecta a ninguna base: usa un mock de PostgreSQL respaldado por el dataset real.
 * Runner async real.
 *
 * Uso: node tests/import-canonical.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
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

const norm = JSON.parse(fs.readFileSync(M.NORMALIZED, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- Modelo en memoria a partir del dataset real ----
function buildModel() {
  const zones = norm.zones.map((z, i) => ({
    id: i + 1, code: z.proposed_code, name: z.proposed_name, zone_type: z.proposed_zone_type,
    parent_code: z.proposed_parent_code, polygon_geojson: clone(z.polygon_geojson),
  }));
  const codeToId = new Map(zones.map(z => [z.code, z.id]));
  zones.forEach(z => { z.parent_zone_id = z.parent_code != null ? (codeToId.get(z.parent_code) ?? null) : null; });
  const farmSite = { id: 1000, code: norm.farm_site.code, name: norm.farm_site.name, boundary_geojson: clone(norm.farm_site.boundary_geojson) };
  const aliases = norm.alias_proposals.map(a => ({ geo_zone_id: codeToId.get(a.proposed_geo_zone_code) ?? null, alias: a.alias, source_context: a.source_context }));
  return { farmSite, zones, aliases };
}

const C1_38 = /^C([1-9]|[12][0-9]|3[0-8])$/;

// Mock de q(sql, params) respaldado por el modelo, con contador de escrituras.
function makeDb(model) {
  const state = { writes: 0 };
  const zoneByCode = (c) => model.zones.find(z => z.code === c);
  const zoneById = (id) => model.zones.find(z => z.id === id);
  const q = async (sql, params = []) => {
    if (!/^\s*SELECT/i.test(sql)) { state.writes++; return { rows: [{}] }; } // spy: cualquier escritura
    const rows = (arr) => ({ rows: arr });
    // farm_sites
    if (/COUNT\(\*\)::int c FROM farm_sites WHERE code/.test(sql)) return rows([{ c: model.farmSite.code === params[0] ? 1 : 0 }]);
    if (/SELECT id, code, name, boundary_geojson FROM farm_sites WHERE code/.test(sql)) return rows(model.farmSite.code === params[0] ? [{ id: model.farmSite.id, code: model.farmSite.code, name: model.farmSite.name, boundary_geojson: model.farmSite.boundary_geojson }] : []);
    if (/SELECT id, code, boundary_geojson FROM farm_sites WHERE code/.test(sql)) return rows([{ id: model.farmSite.id, code: model.farmSite.code, boundary_geojson: model.farmSite.boundary_geojson }]);
    // geo_zones counts
    if (/FROM geo_zones WHERE farm_site_id = \$1 AND polygon_geojson IS NULL/.test(sql)) return rows([{ c: model.zones.filter(z => z.polygon_geojson == null).length }]);
    if (/COUNT\(\*\)::int c FROM geo_zones WHERE farm_site_id/.test(sql)) return rows([{ c: model.zones.length }]);
    // aliases (orden de checks importa)
    if (/z\.code <> \('HB-' \|\| a\.alias\)/.test(sql)) {
      const c = model.aliases.filter(a => /^C[0-9]+$/.test(a.alias)).filter(a => { const z = zoneById(a.geo_zone_id); return !z || z.code !== 'HB-' + a.alias; }).length;
      return rows([{ c }]);
    }
    if (/source_context = 'general'/.test(sql)) return rows([{ c: model.aliases.filter(a => C1_38.test(a.alias) && a.source_context === 'general').length }]);
    if (/alias IN \('C39'/.test(sql)) return rows([{ c: model.aliases.filter(a => ['C39', 'C40', 'C41', 'C42'].includes(a.alias)).length }]);
    if (/a\.alias ~ '\^C\(/.test(sql)) return rows([{ c: model.aliases.filter(a => C1_38.test(a.alias)).length }]);
    // parentOf
    if (/LEFT JOIN geo_zones p ON p\.id = z\.parent_zone_id/.test(sql)) { const z = zoneByCode(params[1]); return rows(z ? [{ parent_code: z.parent_code ?? null }] : []); }
    // invernadero zone_type
    if (/SELECT zone_type FROM geo_zones WHERE farm_site_id = \$1 AND code = \$2/.test(sql)) { const z = zoneByCode(params[1]); return rows(z ? [{ zone_type: z.zone_type }] : []); }
    if (/WHERE parent_zone_id = id/.test(sql)) return rows([{ c: model.zones.filter(z => z.parent_zone_id === z.id).length }]);
    if (/z\.farm_site_id <> p\.farm_site_id/.test(sql)) return rows([{ c: 0 }]);
    if (/GROUP BY farm_site_id, code/.test(sql)) return rows([{ c: 0 }]);
    if (/GROUP BY geo_zone_id, alias/.test(sql)) return rows([{ c: 0 }]);
    // todas las zonas
    if (/SELECT id, code, name, zone_type, parent_zone_id, polygon_geojson FROM geo_zones WHERE farm_site_id/.test(sql))
      return rows(model.zones.map(z => ({ id: z.id, code: z.code, name: z.name, zone_type: z.zone_type, parent_zone_id: z.parent_zone_id, polygon_geojson: z.polygon_geojson })));
    // sqlSelectAlias
    if (/SELECT id FROM geo_zone_aliases WHERE geo_zone_id = \$1 AND alias = \$2/.test(sql)) {
      const [zid, alias, ctx] = params;
      const hit = model.aliases.find(a => a.geo_zone_id === zid && a.alias === alias && (a.source_context || '') === (ctx || ''));
      return rows(hit ? [{ id: 1 }] : []);
    }
    return rows([{}]);
  };
  return { q, state };
}

console.log('\n=========  TESTS: verificación canónica del estado inicial (2E.1B)  =========\n');

test('dataset canónico existente (1/58/38 exacto) → permitido', async () => {
  const { q } = makeDb(buildModel());
  await M.assertExistingIsCanonical(q, norm); // no lanza
});

test('1/58/38 con una GEOMETRÍA diferente → BLOCKED (antes de escritura)', async () => {
  const model = buildModel();
  model.zones[10].polygon_geojson.coordinates[0][0][0] += 0.001; // mueve un vértice
  const { q, state } = makeDb(model);
  await assert.rejects(() => M.assertExistingIsCanonical(q, norm), /PRODUCTION MAP IMPORT BLOCKED/);
  assert.strictEqual(state.writes, 0, 'no debe haber escrituras antes del bloqueo');
});

test('1/58/38 con un ALIAS diferente → BLOCKED', async () => {
  const model = buildModel();
  const a = model.aliases.find(x => x.alias === 'C7'); a.alias = 'C99'; // deja de mapear C7→HB-C7
  const { q, state } = makeDb(model);
  await assert.rejects(() => M.assertExistingIsCanonical(q, norm), /PRODUCTION MAP IMPORT BLOCKED/);
  assert.strictEqual(state.writes, 0);
});

test('1/58/38 con HIERARCHY diferente → BLOCKED', async () => {
  const model = buildModel();
  const z = model.zones.find(x => x.code === 'HB-C10'); // C5..C38 deben colgar de HB-CAMPO
  z.parent_code = 'HB-CAMPO-C1-C4'; z.parent_zone_id = model.zones.find(x => x.code === 'HB-CAMPO-C1-C4').id;
  const { q, state } = makeDb(model);
  await assert.rejects(() => M.assertExistingIsCanonical(q, norm), /PRODUCTION MAP IMPORT BLOCKED/);
  assert.strictEqual(state.writes, 0);
});

test('1/58/38 con review != 0 en el dataset propuesto → BLOCKED', async () => {
  const { q } = makeDb(buildModel());
  const badNorm = clone(norm); badNorm.zones[0].review = true;
  await assert.rejects(() => M.assertExistingIsCanonical(q, badNorm), /PRODUCTION MAP IMPORT BLOCKED/);
});

test('1/58/38 con C38 sustituida por C39 (conteo 58 pero falta zona esperada) → BLOCKED', async () => {
  const model = buildModel();
  const z = model.zones.find(x => x.code === 'HB-C38'); z.code = 'HB-C39'; // ya no existe HB-C38
  const { q, state } = makeDb(model);
  await assert.rejects(() => M.assertExistingIsCanonical(q, norm), /PRODUCTION MAP IMPORT BLOCKED/);
  assert.strictEqual(state.writes, 0);
});

// Gate de conteos (assertInitialStateCompatible)
const mkCount = (fs2, gz, ga) => async () => ({ rows: [{ fs: fs2, gz, ga }] });
test('0/0/0 → permitido (estado vacío)', async () => {
  const r = await M.assertInitialStateCompatible(mkCount(0, 0, 0));
  assert.ok(r.zero && !r.canonical);
});
test('parcial (1/57/38) → BLOCKED por conteos', async () => {
  await assert.rejects(() => M.assertInitialStateCompatible(mkCount(1, 57, 38)), /incompatible/);
});
test('1/58/38 → conteos OK (marca canonical, luego se verifica contenido)', async () => {
  const r = await M.assertInitialStateCompatible(mkCount(1, 58, 38));
  assert.ok(r.canonical);
});

runTests();
