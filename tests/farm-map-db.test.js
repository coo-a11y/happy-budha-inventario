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

// ---------- 2C.1B: igualdad canónica de JSONB ----------
test('JSONB canonical: {a:1,b:2} = {b:2,a:1}', () => {
  assert.ok(M.canonicalEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
});
test('JSONB canonical: arrays con distinto orden NO son iguales', () => {
  assert.ok(!M.canonicalEqual([1, 2, 3], [3, 2, 1]));
});
test('JSONB canonical: dos Polygon con mismas coords y props en distinto orden = iguales', () => {
  const p1 = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] };
  const p2 = { coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]], type: 'Polygon' };
  assert.ok(M.canonicalEqual(p1, p2));
  // pero si cambia el ORDEN de coordenadas, NO son iguales
  const p3 = { type: 'Polygon', coordinates: [[[0, 1], [0, 0], [1, 1], [0, 0]]] };
  assert.ok(!M.canonicalEqual(p1, p3));
});
test('JSONB canonical: acepta valores string JSON (como los devuelve jsonb)', () => {
  assert.ok(M.canonicalEqual('{"type":"Polygon","coordinates":[]}', { coordinates: [], type: 'Polygon' }));
});

// ---------- 2C.1B: validación exacta de aliases y review ----------
function cloneNorm() { return JSON.parse(JSON.stringify(norm)); }

test('alias C7 → HB-C8 (desalineado) hace fallar la validación', () => {
  const n = cloneNorm();
  n.alias_proposals.find(a => a.alias === 'C7').proposed_geo_zone_code = 'HB-C8';
  assert.ok(!M.validateNormalized(n).ok);
});
test('falta C20 hace fallar la validación', () => {
  const n = cloneNorm();
  n.alias_proposals = n.alias_proposals.filter(a => a.alias !== 'C20');
  assert.ok(!M.validateNormalized(n).ok);
});
test('alias extra (fuera de C1–C38) hace fallar la validación', () => {
  const n = cloneNorm();
  n.alias_proposals.push({ alias: 'C99', proposed_geo_zone_code: 'HB-C1', source_context: 'general' });
  assert.ok(!M.validateNormalized(n).ok);
});
test('source_context distinto de general hace fallar', () => {
  const n = cloneNorm();
  n.alias_proposals.find(a => a.alias === 'C1').source_context = 'produccion';
  assert.ok(!M.validateNormalized(n).ok);
});
test('una zona con review:true hace fallar (REQUIERE_REVISION = 0 obligatorio)', () => {
  const n = cloneNorm();
  n.zones[0].review = true;
  const v = M.validateNormalized(n);
  assert.ok(!v.ok && v.errors.some(e => /REQUIERE_REVISION/.test(e)));
});
test('normalized real NO tiene zonas en review', () => {
  assert.strictEqual(norm.zones.filter(z => z.review === true).length, 0);
});

// ---------- 2C.1B: identidad de la base TEST ----------
const mockQ = (dbName) => async (sql) => {
  if (/current_database\(\)/.test(sql)) return { rows: [{ db_name: dbName }] };
  return { rows: [] };
};
test('assertTestDatabaseIdentity: nombre coincidente y con prefijo → OK', async () => {
  const name = await M.assertTestDatabaseIdentity(mockQ('hb_farm_os_test_20260824'), 'hb_farm_os_test_20260824');
  assert.strictEqual(name, 'hb_farm_os_test_20260824');
});
test('assertTestDatabaseIdentity: current_database ≠ esperado → aborta', async () => {
  await assert.rejects(() => M.assertTestDatabaseIdentity(mockQ('otra_db'), 'hb_farm_os_test'), /IDENTIDAD_DB/);
});
test('assertTestDatabaseIdentity: nombre sin prefijo hb_farm_os_test → aborta (aunque coincida)', async () => {
  await assert.rejects(() => M.assertTestDatabaseIdentity(mockQ('railway'), 'railway'), /hb_farm_os_test/);
  await assert.rejects(() => M.assertTestDatabaseIdentity(mockQ('production'), 'production'), /hb_farm_os_test/);
  await assert.rejects(() => M.assertTestDatabaseIdentity(mockQ('happybudha'), 'happybudha'), /hb_farm_os_test/);
});
test('assertTestDatabaseIdentity: sin FARM_OS_TEST_DB_NAME → aborta', async () => {
  await assert.rejects(() => M.assertTestDatabaseIdentity(mockQ('hb_farm_os_test'), ''), /FARM_OS_TEST_DB_NAME/);
});
test('checkApplyBarriers exige FARM_OS_TEST_DB_NAME con prefijo correcto', () => {
  assert.ok(!M.checkApplyBarriers({ FARM_OS_DB_IMPORT_CONFIRM: 'YES', FARM_OS_DB_ENV: 'TEST', FARM_OS_TEST_DATABASE_URL: 'x' }).ok, 'falta DB_NAME debe fallar');
  assert.ok(!M.checkApplyBarriers({ FARM_OS_DB_IMPORT_CONFIRM: 'YES', FARM_OS_DB_ENV: 'TEST', FARM_OS_TEST_DATABASE_URL: 'x', FARM_OS_TEST_DB_NAME: 'railway' }).ok, 'prefijo malo debe fallar');
  assert.ok(M.checkApplyBarriers({ FARM_OS_DB_IMPORT_CONFIRM: 'YES', FARM_OS_DB_ENV: 'TEST', FARM_OS_TEST_DATABASE_URL: 'x', FARM_OS_TEST_DB_NAME: 'hb_farm_os_test' }).ok, 'combinación válida debe pasar');
});
test('--apply sin FARM_OS_TEST_DB_NAME aborta', () => {
  applyExpectAbort({ FARM_OS_DB_IMPORT_CONFIRM: 'YES', FARM_OS_DB_ENV: 'TEST', FARM_OS_TEST_DATABASE_URL: 'postgres://x/y', FARM_OS_TEST_DB_NAME: '' }, 'sin DB_NAME');
});

// ---------- 2C.1B: verificación pre-COMMIT ----------
// Mock de consulta que simula una BASE correcta; permite forzar un fallo puntual.
function makeDbMock(overrides = {}) {
  const parents = { 'HB-NURSERY': 'HB-PLANTA', 'HB-ZONA-EXPERIMENTAL': 'HB-CAMPO' };
  for (const n of [1, 2, 3, 4]) parents['HB-C' + n] = 'HB-CAMPO-C1-C4';
  for (let n = 5; n <= 38; n++) parents['HB-C' + n] = 'HB-CAMPO';
  const cfg = Object.assign({ fincaCount: 1, boundary: { type: 'Polygon' }, zones: 58, nullPoly: 0, aliases38: 38, mismatch: 0, c39: 0, invType: 'POSTHARVEST_PLANT', selfParent: 0, crossFarm: 0, dupCodes: 0, dupAliases: 0 }, overrides);
  return async (sql, params = []) => {
    const r = (o) => ({ rows: [o] });
    if (/COUNT\(\*\)::int c FROM farm_sites WHERE code/.test(sql)) return r({ c: cfg.fincaCount });
    if (/SELECT id, code, boundary_geojson FROM farm_sites/.test(sql)) return r({ id: 1, code: 'HB-FINCA-01', boundary_geojson: cfg.boundary });
    if (/COUNT\(\*\)::int c FROM geo_zones WHERE farm_site_id = \$1 AND polygon_geojson IS NULL/.test(sql)) return r({ c: cfg.nullPoly });
    if (/COUNT\(\*\)::int c FROM geo_zones WHERE farm_site_id/.test(sql)) return r({ c: cfg.zones });
    if (/JOIN geo_zones z[\s\S]*alias ~ '\^C\(/.test(sql)) return r({ c: cfg.aliases38 });
    if (/z\.code <> \('HB-' \|\| a\.alias\)/.test(sql)) return r({ c: cfg.mismatch });
    if (/alias IN \('C39'/.test(sql)) return r({ c: cfg.c39 });
    if (/LEFT JOIN geo_zones p ON p\.id = z\.parent_zone_id/.test(sql)) return r({ parent_code: parents[params[1]] });
    if (/SELECT zone_type FROM geo_zones/.test(sql)) return r({ zone_type: cfg.invType });
    if (/WHERE parent_zone_id = id/.test(sql)) return r({ c: cfg.selfParent });
    if (/z\.farm_site_id <> p\.farm_site_id/.test(sql)) return r({ c: cfg.crossFarm });
    if (/GROUP BY farm_site_id, code/.test(sql)) return r({ c: cfg.dupCodes });
    if (/GROUP BY geo_zone_id, alias/.test(sql)) return r({ c: cfg.dupAliases });
    return { rows: [{}] };
  };
}
test('verifyImportedMap: base correcta → ok', async () => {
  const res = await M.verifyImportedMap(makeDbMock(), 'HB-FINCA-01');
  assert.ok(res.ok, 'debería pasar: ' + res.checks.filter(c => !c.ok).map(c => c.name));
});
test('verifyImportedMap: si faltan zonas (57) → NO ok (bloquearía COMMIT)', async () => {
  const res = await M.verifyImportedMap(makeDbMock({ zones: 57 }), 'HB-FINCA-01');
  assert.ok(!res.ok);
});
test('verifyImportedMap: si Invernadero no es POSTHARVEST_PLANT → NO ok', async () => {
  const res = await M.verifyImportedMap(makeDbMock({ invType: 'NURSERY' }), 'HB-FINCA-01');
  assert.ok(!res.ok);
});

// ---------- 2C.1B: estructura de runApply (verificación antes de COMMIT) ----------
test('runApply verifica ANTES de COMMIT (orden en el código) y hace ROLLBACK si falla', () => {
  const iVer = SRC.indexOf('await verifyImportedMap(cq');
  const iCommit = SRC.indexOf("client.query('COMMIT')");
  assert.ok(iVer > -1, 'debe llamar verifyImportedMap antes de COMMIT');
  assert.ok(iVer < iCommit, 'la verificación debe ocurrir ANTES de COMMIT');
  assert.ok(/VERIFICACION_PRECOMMIT_FALLIDA/.test(SRC), 'debe lanzar error si la verificación falla');
  assert.ok(/ROLLBACK/.test(SRC), 'debe existir ROLLBACK');
});
test('runApply chequea identidad de DB antes de BEGIN', () => {
  const iId = SRC.indexOf('assertTestDatabaseIdentity(cq');
  const iBegin = SRC.indexOf("client.query('BEGIN')");
  assert.ok(iId > -1 && iId < iBegin, 'la identidad de DB debe verificarse antes de BEGIN');
});

console.log(`\nResultado: ${pass} OK, ${fail} fallos.\n`);
process.exit(fail ? 1 : 0);
