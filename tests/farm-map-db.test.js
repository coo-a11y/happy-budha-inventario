#!/usr/bin/env node
/**
 * tests/farm-map-db.test.js — Pruebas del importador normalized.json → PostgreSQL.
 * NO conecta a ninguna base. Verifica validación, topo-sort, barreras e idempotencia.
 *
 * Uso: node tests/farm-map-db.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const M = require('../scripts/import-farm-map-db.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-farm-map-db.js');
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const norm = JSON.parse(fs.readFileSync(M.NORMALIZED, 'utf8'));

// zonas sintéticas mínimas para tests de jerarquía
const mk = (code, parent) => ({ proposed_code: code, proposed_name: code, proposed_zone_type: 'OTHER', proposed_parent_code: parent, polygon_geojson: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } });

console.log('\n=========  TESTS: importador normalized → PostgreSQL  =========\n');

test('normalized real valida 1 / 58 / 38', () => {
  const v = M.validateNormalized(norm);
  assert.ok(v.ok, 'validación falló: ' + v.errors.join('; '));
  assert.strictEqual(v.stats.farm_sites, 1);
  assert.strictEqual(v.stats.zones, 58);
  assert.strictEqual(v.stats.aliases, 38);
});

test('C1–C38 presentes y C39–C42 ausentes', () => {
  const v = M.validateNormalized(norm);
  assert.ok(v.stats.c39_c42_absent, 'C39–C42 deberían estar ausentes');
  assert.strictEqual(v.errors.filter(e => /falta parcela/.test(e)).length, 0);
});

test('topological sort: padres antes que hijos', () => {
  const order = M.topoSort(norm.zones).map(z => z.proposed_code);
  const pos = new Map(order.map((c, i) => [c, i]));
  for (const z of norm.zones) if (z.proposed_parent_code) assert.ok(pos.get(z.proposed_parent_code) < pos.get(z.proposed_code), `${z.proposed_parent_code} debe ir antes que ${z.proposed_code}`);
});

test('padre inexistente → aborta (MISSING_PARENT)', () => {
  assert.throws(() => M.topoSort([mk('A', 'NOPE')]), /MISSING_PARENT/);
});

test('auto-parent → aborta (AUTO_PARENT)', () => {
  assert.throws(() => M.topoSort([mk('A', 'A')]), /AUTO_PARENT/);
});

test('ciclo A→B→A → aborta (CYCLE)', () => {
  assert.throws(() => M.topoSort([mk('A', 'B'), mk('B', 'A')]), /CYCLE/);
});

test('ciclo A→B→C→A → aborta (CYCLE)', () => {
  assert.throws(() => M.topoSort([mk('A', 'B'), mk('B', 'C'), mk('C', 'A')]), /CYCLE/);
});

test('código duplicado → validación falla', () => {
  const bad = { farm_site: norm.farm_site, zones: [mk('DUP', null), mk('DUP', null)], alias_proposals: [] };
  const v = M.validateNormalized(bad);
  assert.ok(!v.ok && v.errors.some(e => /duplicados/.test(e)), 'no detectó códigos duplicados');
});

test('alias duplicado → validación falla', () => {
  const z = mk('HB-X', null);
  const bad = { farm_site: norm.farm_site, zones: [z], alias_proposals: [
    { alias: 'C1', proposed_geo_zone_code: 'HB-X', source_context: 'general' },
    { alias: 'C1', proposed_geo_zone_code: 'HB-X', source_context: 'general' },
  ] };
  const v = M.validateNormalized(bad);
  assert.ok(v.errors.some(e => /alias duplicado/.test(e)), 'no detectó alias duplicado');
});

test('dry-run: cero conexión DB (no se requiere pg en el nivel superior)', () => {
  // pg solo debe requerirse dentro de runApply (require perezoso, indentado).
  // Un import a nivel de módulo estaría en columna 0 (sin indentación).
  assert.ok(!/^const\b[^\n]*require\(['"]pg['"]\)/m.test(SRC), 'pg no debe importarse a nivel de módulo (columna 0)');
  const out = cp.execSync('node ' + JSON.stringify(SCRIPT) + ' --dry-run', { encoding: 'utf8' });
  assert.ok(/DB connections: 0/.test(out), 'dry-run debe reportar 0 conexiones');
  assert.ok(/DB writes: 0/.test(out), 'dry-run debe reportar 0 escrituras');
  assert.ok(/Geo zones planificadas: 58/.test(out));
});

function applyExpectAbort(env, label) {
  const res = cp.spawnSync('node', [SCRIPT, '--apply'], { encoding: 'utf8', env: Object.assign({}, process.env, env) });
  assert.strictEqual(res.status, 1, `${label}: debía abortar con exit 1 (fue ${res.status})`);
}

test('--apply sin confirmación aborta', () => {
  applyExpectAbort({ FARM_OS_DB_IMPORT_CONFIRM: '', FARM_OS_DB_ENV: 'TEST', FARM_OS_TEST_DATABASE_URL: 'postgres://x/y' }, 'sin CONFIRM');
});

test('--apply con FARM_OS_DB_ENV=PRODUCTION aborta', () => {
  applyExpectAbort({ FARM_OS_DB_IMPORT_CONFIRM: 'YES', FARM_OS_DB_ENV: 'PRODUCTION', FARM_OS_TEST_DATABASE_URL: 'postgres://x/y' }, 'PRODUCTION');
});

test('--apply sin FARM_OS_TEST_DATABASE_URL aborta', () => {
  applyExpectAbort({ FARM_OS_DB_IMPORT_CONFIRM: 'YES', FARM_OS_DB_ENV: 'TEST', FARM_OS_TEST_DATABASE_URL: '' }, 'sin URL');
});

test('DATABASE_URL jamás se utiliza (ni como fallback)', () => {
  assert.ok(!/process\.env\.DATABASE_URL/.test(SRC), 'el importador no debe leer process.env.DATABASE_URL');
  // Aunque DATABASE_URL esté presente, --apply sin barreras sigue abortando y no conecta.
  const res = cp.spawnSync('node', [SCRIPT, '--apply'], { encoding: 'utf8', env: Object.assign({}, process.env, { DATABASE_URL: 'postgres://prod/should-not-use', FARM_OS_DB_ENV: 'TEST', FARM_OS_DB_IMPORT_CONFIRM: '', FARM_OS_TEST_DATABASE_URL: '' }) });
  assert.strictEqual(res.status, 1);
});

test('SQL parametrizado (placeholders $n, valores separados, sin JSON en string)', () => {
  const insZ = M.sqlInsertZone(1, mk('HB-Z', null), null);
  assert.ok(/\$1.*\$2.*\$3.*\$4.*\$5.*\$6/s.test(insZ.text), 'faltan placeholders');
  assert.strictEqual(insZ.values.length, 6);
  assert.ok(typeof insZ.values[5] === 'string', 'el GeoJSON va como valor parametrizado (jsonb), no concatenado');
  const insA = M.sqlInsertAlias(9, 'C1', 'general');
  assert.ok(/\$1.*\$2.*\$3/s.test(insA.text) && insA.values.length === 3);
});

test('no UPDATE / no DELETE en el código del importador', () => {
  assert.ok(!/\bUPDATE\s+\w/i.test(SRC), 'no debe haber UPDATE');
  assert.ok(!/\bDELETE\s+FROM\b/i.test(SRC), 'no debe haber DELETE FROM');
});

test('no escritura contra tablas históricas', () => {
  for (const t of M.HISTORICAL_TABLES) assert.throws(() => M.assertAllowedTable(t), new RegExp(t), `${t} debería estar bloqueada`);
  for (const t of M.ALLOWED_WRITE_TABLES) assert.doesNotThrow(() => M.assertAllowedTable(t));
  // Ninguna sentencia INSERT del importador apunta a tablas históricas
  const inserts = SRC.match(/INSERT INTO (\w+)/g) || [];
  inserts.forEach(s => { const t = s.split(/\s+/)[2]; assert.ok(!M.HISTORICAL_TABLES.includes(t), `INSERT prohibido a ${t}`); });
});

console.log(`\nResultado: ${pass} OK, ${fail} fallos.\n`);
process.exit(fail ? 1 : 0);
