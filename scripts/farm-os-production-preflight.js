#!/usr/bin/env node
/**
 * scripts/farm-os-production-preflight.js — PREFLIGHT de producción, ESTRICTAMENTE READ-ONLY.
 *
 * Comprueba (solo lectura) si la base productiva está lista para recibir la migración 002,
 * y genera una FOTO de integridad (estructura + conteos) para comparar antes/después.
 *
 * SEGURIDAD:
 *  - Solo ejecuta SELECT (barrera: rechaza cualquier otra sentencia).
 *  - Este archivo NO contiene INSERT/UPDATE/DELETE/ALTER/CREATE/DROP/TRUNCATE.
 *  - Exige FARM_OS_DB_ENV=PRODUCTION_PREFLIGHT y FARM_OS_PRODUCTION_DATABASE_URL.
 *  - NUNCA usa DATABASE_URL.
 *  - No imprime secretos (solo el hostname, nunca la contraseña ni la URL completa).
 *
 * Uso (cuando se autorice):
 *   FARM_OS_DB_ENV=PRODUCTION_PREFLIGHT FARM_OS_PRODUCTION_DATABASE_URL=<url> \
 *     node scripts/farm-os-production-preflight.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { lintAdditive } = require('./lib/migration-lint.js');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT_OUT = path.join(ROOT, 'reports', 'production-preflight-snapshot.json');
const MIGRATION_002 = path.join(ROOT, 'migrations', '002_farm_location_foundation.sql');

// Las 8 tablas históricas/productivas que NO se deben tocar.
const HISTORICAL_TABLES = ['productos', 'lotes', 'movimientos', 'usuarios', 'conversiones', 'mediciones', 'cultivo_calendario', 'produccion'];
// Las 5 tablas que 002 crearía; ninguna debería existir aún en producción.
const NEW_TABLES = ['farm_sites', 'geo_zones', 'geo_zone_aliases', 'workers', 'worker_devices'];

// Devuelve solo el hostname (sin usuario/contraseña) para no exponer secretos.
function safeHost(url) {
  try { return new URL(url).hostname; } catch (_) { return '(host no parseable)'; }
}

// Barrera: solo SELECT.
function assertSelectOnly(sql) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('BLOQUEADO: el preflight solo permite SELECT.');
}

function checkPreflightEnv(env) {
  const reasons = [];
  if (env.FARM_OS_DB_ENV !== 'PRODUCTION_PREFLIGHT') reasons.push('FARM_OS_DB_ENV debe ser PRODUCTION_PREFLIGHT');
  if (!env.FARM_OS_PRODUCTION_DATABASE_URL) reasons.push('falta FARM_OS_PRODUCTION_DATABASE_URL');
  return { ok: reasons.length === 0, reasons };
}

// Estructura + conteo de una tabla histórica (solo lectura). El nombre proviene de una
// lista blanca fija (no de entrada externa), por lo que interpolarlo en el COUNT es seguro.
async function snapshotTable(q, table) {
  const existsRow = (await q(`SELECT to_regclass('public.${table}') IS NOT NULL AS exists`, [])).rows[0];
  const exists = !!existsRow.exists;
  if (!exists) return { table, exists: false };
  const count = (await q(`SELECT COUNT(*)::bigint AS c FROM ${table}`, [])).rows[0].c;
  const columns = (await q(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
  const pk = (await q(
    `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
     WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`, [table])).rows.map(r => r.column_name);
  const fks = (await q(
    `SELECT tc.constraint_name FROM information_schema.table_constraints tc
     WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='FOREIGN KEY'`, [table])).rows.map(r => r.constraint_name);
  const indexes = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`, [table])).rows.map(r => r.indexname);
  return { table, exists: true, count: String(count), columns, primary_key: pk, foreign_keys: fks, indexes };
}

async function buildSnapshot(q) {
  const out = [];
  for (const t of HISTORICAL_TABLES) out.push(await snapshotTable(q, t));
  return out;
}

async function checkConflicts(q) {
  const conflicts = [];
  for (const t of NEW_TABLES) {
    const r = (await q(`SELECT to_regclass('public.${t}') IS NOT NULL AS exists`, [])).rows[0];
    if (r.exists) conflicts.push(t);
  }
  return conflicts;
}

// Análisis estático de 002 (no ejecuta nada).
function analyzeMigration002() {
  const sql = fs.readFileSync(MIGRATION_002, 'utf8');
  return lintAdditive(sql, HISTORICAL_TABLES);
}

async function main() {
  const env = process.env;
  const gate = checkPreflightEnv(env);
  if (!gate.ok) {
    console.error('⛔ ABORTADO: no se cumplen las condiciones del preflight:');
    gate.reasons.forEach(r => console.error('   - ' + r));
    process.exit(1);
  }

  const url = env.FARM_OS_PRODUCTION_DATABASE_URL;
  const { Pool } = require('pg'); // require perezoso
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const q = async (sql, params = []) => { assertSelectOnly(sql); return pool.query(sql, params); };

  try {
    // Identidad (informativa, read-only). No se asume ningún nombre de DB.
    const ident = (await q('SELECT current_database() AS db, current_user AS usr, version() AS ver', [])).rows[0];
    const smRow = (await q(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`, [])).rows[0];

    const snapshot = await buildSnapshot(q);
    const conflicts = await checkConflicts(q);
    const lint = analyzeMigration002();

    const report = {
      generated_at: new Date().toISOString(),
      identity: { current_database: ident.db, current_user: ident.usr, version: ident.ver, host: safeHost(url), schema_migrations_exists: !!smRow.exists },
      historical_tables: snapshot,
      new_tables_conflict: { any: conflicts.length > 0, present: conflicts, status: conflicts.length ? 'CONFLICT_REQUIRES_REVIEW' : 'OK' },
      migration_002_lint: lint,
    };

    fs.mkdirSync(path.dirname(SNAPSHOT_OUT), { recursive: true });
    fs.writeFileSync(SNAPSHOT_OUT, JSON.stringify(report, null, 2));

    console.log('\n=========  PRODUCTION PREFLIGHT (READ-ONLY)  =========\n');
    console.log(`DB: ${ident.db} | user: ${ident.usr} | host: ${safeHost(url)}`);
    console.log(`schema_migrations existe: ${!!smRow.exists}`);
    console.log('Tablas históricas (conteos):');
    snapshot.forEach(t => console.log(`  - ${t.table}: ${t.exists ? t.count + ' filas' : 'NO EXISTE'}`));
    console.log(`Conflicto tablas nuevas: ${report.new_tables_conflict.status}${conflicts.length ? ' → ' + conflicts.join(', ') : ''}`);
    console.log(`002 aditiva: ${lint.ok ? 'YES' : 'NO — ' + lint.findings.join('; ')}`);
    console.log(`\nSnapshot guardado en: ${path.relative(ROOT, SNAPSHOT_OUT)}`);
    console.log('(Solo lectura: no se escribió nada en la base productiva.)\n');
    process.exit(conflicts.length ? 2 : 0);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = {
  checkPreflightEnv, assertSelectOnly, safeHost, snapshotTable, buildSnapshot,
  checkConflicts, analyzeMigration002, HISTORICAL_TABLES, NEW_TABLES, SNAPSHOT_OUT,
};
