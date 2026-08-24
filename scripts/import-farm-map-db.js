#!/usr/bin/env node
/**
 * scripts/import-farm-map-db.js — Importador normalized.json → PostgreSQL.
 * Explícito, transaccional, idempotente, verificable y protegido contra ejecución accidental.
 *
 * MODOS:
 *   --dry-run  (por defecto en esta fase) → valida + planifica. CERO conexión, CERO escritura.
 *   --apply    → existe en código pero está bloqueado tras barreras de entorno (ver abajo).
 *
 * BARRERA ABSOLUTA CONTRA PRODUCCIÓN (para --apply deben existir TODAS):
 *   FARM_OS_DB_IMPORT_CONFIRM=YES
 *   FARM_OS_DB_ENV=TEST
 *   FARM_OS_TEST_DATABASE_URL=<url de base temporal>
 * - El ÚNICO connection string permitido es FARM_OS_TEST_DATABASE_URL.
 * - DATABASE_URL se IGNORA por completo (nunca se lee ni como fallback).
 *
 * TABLAS: solo puede escribir en farm_sites, geo_zones, geo_zone_aliases.
 *         Nunca en tablas históricas (productos, lotes, movimientos, usuarios, conversiones,
 *         mediciones, cultivo_calendario, produccion).
 *
 * Uso:
 *   node scripts/import-farm-map-db.js --dry-run
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NORMALIZED = path.join(ROOT, 'data', 'maps', 'happybudha-farm-map.normalized.json');

const ALLOWED_WRITE_TABLES = ['farm_sites', 'geo_zones', 'geo_zone_aliases'];
const HISTORICAL_TABLES = ['productos', 'lotes', 'movimientos', 'usuarios', 'conversiones', 'mediciones', 'cultivo_calendario', 'produccion'];

const EXPECTED = { farm_sites: 1, zones: 58, aliases: 38 };

// ------------------------------------------------------------ Validación GeoJSON
function isValidGeoJsonPolygon(g) {
  return !!g && typeof g === 'object' && !Array.isArray(g) && (g.type === 'Polygon' || g.type === 'MultiPolygon');
}

// ------------------------------------------------------------ Validación normalized
function validateNormalized(norm) {
  const errors = [];
  const fs1 = norm.farm_site ? 1 : 0;
  const zones = Array.isArray(norm.zones) ? norm.zones : [];
  const aliases = Array.isArray(norm.alias_proposals) ? norm.alias_proposals : [];

  if (fs1 !== EXPECTED.farm_sites) errors.push(`farm_sites esperado ${EXPECTED.farm_sites}, hay ${fs1}`);
  if (zones.length !== EXPECTED.zones) errors.push(`zones esperado ${EXPECTED.zones}, hay ${zones.length}`);
  if (aliases.length !== EXPECTED.aliases) errors.push(`aliases esperado ${EXPECTED.aliases}, hay ${aliases.length}`);

  // Códigos únicos
  const codes = zones.map(z => z.proposed_code);
  const codeSet = new Set(codes);
  if (codeSet.size !== codes.length) errors.push('códigos de zona duplicados');

  // C1–C38 presentes, C39–C42 ausentes (por source_name)
  const srcNames = new Set(zones.map(z => z.source_name));
  for (let i = 1; i <= 38; i++) if (!srcNames.has('C' + i)) errors.push(`falta parcela C${i}`);
  for (const n of ['C39', 'C40', 'C41', 'C42']) if (srcNames.has(n)) errors.push(`no debería existir ${n}`);

  // boundary_geojson de la finca válido
  if (fs1 && !isValidGeoJsonPolygon(norm.farm_site.boundary_geojson)) errors.push('farm_site.boundary_geojson inválido');

  // Todos los polygon_geojson válidos
  for (const z of zones) if (!isValidGeoJsonPolygon(z.polygon_geojson)) errors.push(`polygon_geojson inválido en ${z.proposed_code}`);

  // Padres existentes, sin auto-padre
  for (const z of zones) {
    if (z.proposed_parent_code == null) continue;
    if (z.proposed_parent_code === z.proposed_code) errors.push(`auto-padre en ${z.proposed_code}`);
    if (!codeSet.has(z.proposed_parent_code)) errors.push(`padre inexistente: ${z.proposed_code} → ${z.proposed_parent_code}`);
  }

  // Aliases coherentes (apuntan a una zona existente)
  for (const a of aliases) if (!codeSet.has(a.proposed_geo_zone_code)) errors.push(`alias ${a.alias} apunta a zona inexistente ${a.proposed_geo_zone_code}`);

  // Aliases exactamente duplicados (misma zona + alias + source_context)
  const aliasKeys = new Set();
  for (const a of aliases) {
    const k = `${a.proposed_geo_zone_code}||${a.alias}||${a.source_context || ''}`;
    if (aliasKeys.has(k)) errors.push(`alias duplicado: ${a.alias} en ${a.proposed_geo_zone_code}`);
    aliasKeys.add(k);
  }

  // Detección de ciclos (usa topoSort)
  let cycles = 0;
  try { topoSort(zones); } catch (e) { cycles = 1; errors.push(e.message); }

  const cAbsent = ['C39', 'C40', 'C41', 'C42'].every(n => !srcNames.has(n));
  return { ok: errors.length === 0, errors, stats: { farm_sites: fs1, zones: zones.length, aliases: aliases.length, c39_c42_absent: cAbsent, cycles } };
}

// ------------------------------------------------------------ Orden topológico
// Devuelve las zonas ordenadas de forma que cada padre aparece ANTES que sus hijos.
// Lanza error ante: padre inexistente, auto-padre, o ciclo (A→B→A, A→B→C→A, etc.).
function topoSort(zones) {
  const byCode = new Map(zones.map(z => [z.proposed_code, z]));
  // Validaciones puntuales
  for (const z of zones) {
    const p = z.proposed_parent_code;
    if (p == null) continue;
    if (p === z.proposed_code) throw new Error(`AUTO_PARENT: ${z.proposed_code}`);
    if (!byCode.has(p)) throw new Error(`MISSING_PARENT: ${z.proposed_code} → ${p}`);
  }
  const state = new Map(); // code → 0 sin visitar, 1 en pila, 2 terminado
  const order = [];
  function visit(code, stack) {
    const st = state.get(code) || 0;
    if (st === 2) return;
    if (st === 1) throw new Error(`CYCLE: ${[...stack, code].join(' → ')}`);
    state.set(code, 1);
    const z = byCode.get(code);
    const p = z.proposed_parent_code;
    if (p != null) visit(p, [...stack, code]);
    state.set(code, 2);
    order.push(z);
  }
  for (const z of zones) visit(z.proposed_code, []);
  return order; // padres antes que hijos
}

// ------------------------------------------------------------ SQL parametrizado
// Todas las funciones devuelven { text, values }. NUNCA se concatena JSON en el SQL.
function assertAllowedTable(table) {
  if (HISTORICAL_TABLES.includes(table)) throw new Error(`BLOQUEADO: escritura prohibida a tabla histórica "${table}"`);
  if (!ALLOWED_WRITE_TABLES.includes(table)) throw new Error(`BLOQUEADO: tabla no autorizada para escritura "${table}"`);
}
function sqlSelectFarmSite(code) {
  return { text: 'SELECT id, code, name, boundary_geojson FROM farm_sites WHERE code = $1', values: [code] };
}
function sqlInsertFarmSite(fs2) {
  assertAllowedTable('farm_sites');
  return {
    text: `INSERT INTO farm_sites (code, name, boundary_geojson) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    values: [fs2.code, fs2.name, JSON.stringify(fs2.boundary_geojson)],
  };
}
function sqlSelectZone(farmSiteId, code) {
  return { text: 'SELECT id, code, name, zone_type, parent_zone_id, polygon_geojson FROM geo_zones WHERE farm_site_id = $1 AND code = $2', values: [farmSiteId, code] };
}
function sqlInsertZone(farmSiteId, z, parentZoneId) {
  assertAllowedTable('geo_zones');
  return {
    text: `INSERT INTO geo_zones (farm_site_id, code, name, zone_type, parent_zone_id, polygon_geojson)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    values: [farmSiteId, z.proposed_code, z.proposed_name, z.proposed_zone_type, parentZoneId, JSON.stringify(z.polygon_geojson)],
  };
}
function sqlSelectAlias(geoZoneId, alias, sourceContext) {
  return {
    text: `SELECT id FROM geo_zone_aliases WHERE geo_zone_id = $1 AND alias = $2 AND COALESCE(source_context,'') = COALESCE($3,'')`,
    values: [geoZoneId, alias, sourceContext ?? null],
  };
}
function sqlInsertAlias(geoZoneId, alias, sourceContext) {
  assertAllowedTable('geo_zone_aliases');
  return {
    text: `INSERT INTO geo_zone_aliases (geo_zone_id, alias, source_context) VALUES ($1, $2, $3) RETURNING id`,
    values: [geoZoneId, alias, sourceContext ?? null],
  };
}

// Comparación de idempotencia (¿coincide lo existente con lo propuesto?)
function farmSiteMatches(dbRow, proposed) {
  return dbRow.name === proposed.name && deepEqual(dbRow.boundary_geojson, proposed.boundary_geojson);
}
function zoneMatches(dbRow, proposed, resolvedParentId) {
  return dbRow.name === proposed.proposed_name
    && dbRow.zone_type === proposed.proposed_zone_type
    && (dbRow.parent_zone_id ?? null) === (resolvedParentId ?? null)
    && deepEqual(dbRow.polygon_geojson, proposed.polygon_geojson);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) {} }
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) {} }
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------ Plan (dry-run)
function buildPlan(norm) {
  const v = validateNormalized(norm);
  let order = [];
  let hierarchyValid = true;
  try { order = topoSort(norm.zones || []); } catch (e) { hierarchyValid = false; }
  return {
    farm_sites: v.stats.farm_sites,
    zones: v.stats.zones,
    aliases: v.stats.aliases,
    hierarchyValid: hierarchyValid && v.stats.cycles === 0,
    cycles: v.stats.cycles,
    missingParents: v.errors.filter(e => e.startsWith('padre inexistente') || e.startsWith('MISSING_PARENT')).length,
    c39_c42_absent: v.stats.c39_c42_absent,
    validation: v,
    topoOrder: order.map(z => z.proposed_code),
  };
}

// ------------------------------------------------------------ Barreras de entorno
function checkApplyBarriers(env) {
  const reasons = [];
  if (env.FARM_OS_DB_IMPORT_CONFIRM !== 'YES') reasons.push('falta FARM_OS_DB_IMPORT_CONFIRM=YES');
  if (env.FARM_OS_DB_ENV !== 'TEST') reasons.push(`FARM_OS_DB_ENV debe ser TEST (actual: ${env.FARM_OS_DB_ENV || 'no definido'})`);
  if (!env.FARM_OS_TEST_DATABASE_URL) reasons.push('falta FARM_OS_TEST_DATABASE_URL');
  return { ok: reasons.length === 0, reasons };
}

// ------------------------------------------------------------ Ejecución
function runDryRun(norm) {
  const plan = buildPlan(norm);
  console.log('\n=========  IMPORT normalized.json → PostgreSQL (DRY-RUN)  =========\n');
  console.log(`Farm sites planificados: ${plan.farm_sites}`);
  console.log(`Geo zones planificadas: ${plan.zones}`);
  console.log(`Aliases planificados: ${plan.aliases}`);
  console.log(`Jerarquía válida: ${plan.hierarchyValid ? 'YES' : 'NO'}`);
  console.log(`Ciclos: ${plan.cycles}`);
  console.log(`Padres inexistentes: ${plan.missingParents}`);
  console.log(`C39-C42 ausentes: ${plan.c39_c42_absent ? 'YES' : 'NO'}`);
  console.log(`DB connections: 0`);
  console.log(`DB writes: 0`);
  if (!plan.validation.ok) {
    console.log('\n⚠️  VALIDACIÓN CON ERRORES (se abortaría --apply):');
    plan.validation.errors.forEach(e => console.log('   - ' + e));
  } else {
    console.log('\n✅ Validación OK. Orden topológico resuelto (padres antes que hijos).');
  }
  console.log('\n(Modo dry-run: no se abrió PostgreSQL ni se escribió nada.)\n');
  return plan;
}

async function runApply(norm, env) {
  // IGNORA DATABASE_URL por completo. Solo FARM_OS_TEST_DATABASE_URL.
  const barrier = checkApplyBarriers(env);
  console.log(`TARGET ENVIRONMENT: ${env.FARM_OS_DB_ENV || '(no definido)'}`);
  if (env.FARM_OS_DB_ENV && env.FARM_OS_DB_ENV !== 'TEST') {
    console.error('⛔ ABORTADO: FARM_OS_DB_ENV distinto de TEST. No existe modo PRODUCTION en este importador.');
    process.exit(1);
  }
  if (!barrier.ok) {
    console.error('⛔ ABORTADO: no se cumplen las barreras para --apply:');
    barrier.reasons.forEach(r => console.error('   - ' + r));
    process.exit(1);
  }
  const plan = buildPlan(norm);
  if (!plan.validation.ok) {
    console.error('⛔ ABORTADO: normalized inválido. Revisa los errores (dry-run).');
    process.exit(1);
  }

  const { Pool } = require('pg'); // require perezoso: dry-run no necesita pg
  const pool = new Pool({ connectionString: env.FARM_OS_TEST_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // farm_site (idempotente por code)
    const fsProp = norm.farm_site;
    let farmSiteId;
    const fsSel = sqlSelectFarmSite(fsProp.code);
    const fsRes = await client.query(fsSel.text, fsSel.values);
    if (fsRes.rows.length) {
      if (!farmSiteMatches(fsRes.rows[0], fsProp)) throw new Error(`CONFLICT_REQUIRES_REVIEW: farm_site ${fsProp.code} difiere de lo existente`);
      farmSiteId = fsRes.rows[0].id; // ALREADY_EXISTS_MATCH
    } else {
      const ins = sqlInsertFarmSite(fsProp);
      farmSiteId = (await client.query(ins.text, ins.values)).rows[0].id;
    }

    // geo_zones en orden topológico (padres primero), idempotente por (farm_site_id, code)
    const codeToId = new Map();
    for (const z of topoSort(norm.zones)) {
      const parentId = z.proposed_parent_code != null ? codeToId.get(z.proposed_parent_code) : null;
      const sel = sqlSelectZone(farmSiteId, z.proposed_code);
      const r = await client.query(sel.text, sel.values);
      if (r.rows.length) {
        if (!zoneMatches(r.rows[0], z, parentId)) throw new Error(`CONFLICT_REQUIRES_REVIEW: zona ${z.proposed_code} difiere de lo existente`);
        codeToId.set(z.proposed_code, r.rows[0].id); // ALREADY_EXISTS_MATCH
      } else {
        const ins = sqlInsertZone(farmSiteId, z, parentId);
        codeToId.set(z.proposed_code, (await client.query(ins.text, ins.values)).rows[0].id);
      }
    }

    // aliases idempotentes por (geo_zone_id, alias, COALESCE(source_context,''))
    for (const a of norm.alias_proposals) {
      const geoZoneId = codeToId.get(a.proposed_geo_zone_code);
      const sel = sqlSelectAlias(geoZoneId, a.alias, a.source_context);
      const r = await client.query(sel.text, sel.values);
      if (!r.rows.length) {
        const ins = sqlInsertAlias(geoZoneId, a.alias, a.source_context);
        await client.query(ins.text, ins.values);
      }
    }

    await client.query('COMMIT');
    console.log('✅ Importación aplicada en TEST (transacción COMMIT).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('⛔ ROLLBACK — no se dejó ninguna importación parcial:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

function main() {
  const apply = process.argv.includes('--apply');
  const norm = JSON.parse(fs.readFileSync(NORMALIZED, 'utf8'));
  if (apply) return runApply(norm, process.env);
  runDryRun(norm); // por defecto
}

if (require.main === module) main();

module.exports = {
  validateNormalized, topoSort, buildPlan, checkApplyBarriers,
  sqlInsertFarmSite, sqlInsertZone, sqlInsertAlias, sqlSelectAlias, assertAllowedTable,
  isValidGeoJsonPolygon, deepEqual, farmSiteMatches, zoneMatches,
  ALLOWED_WRITE_TABLES, HISTORICAL_TABLES, EXPECTED, NORMALIZED,
};
