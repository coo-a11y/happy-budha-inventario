#!/usr/bin/env node
/**
 * scripts/verify-production-farm-map.js — Verificador CANÓNICO de PRODUCCIÓN, READ-ONLY.
 *
 * Comprueba que el mapa existente en la base coincide EXACTAMENTE con el dataset normalizado.
 * NO reutiliza las barreras TEST de verify-farm-map-db.js (ese sigue restringido a TEST).
 *
 * SEGURIDAD:
 *  - Estrictamente READ-ONLY: barrera SELECT-only (equivalente a la del production preflight)
 *    aplicada ANTES de cada query. No hay BEGIN de escritura, INSERT, UPSERT, UPDATE, DELETE ni DDL.
 *  - Exige EXACTAMENTE:
 *      FARM_OS_DB_ENV=PRODUCTION_MAP_VERIFY
 *      FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL=<url>
 *  - NUNCA lee DATABASE_URL, FARM_OS_PRODUCTION_IMPORT_DATABASE_URL ni FARM_OS_TEST_DATABASE_URL.
 *  - SSL host-aware compartido (local → sin SSL; remoto/Railway → con SSL).
 *
 * Uso:
 *   FARM_OS_DB_ENV=PRODUCTION_MAP_VERIFY \
 *   FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL=<url> \
 *     node scripts/verify-production-farm-map.js
 */
'use strict';
const fs = require('fs');
const { verifyImportedMap, assertExistingIsCanonical, NORMALIZED } = require('./import-farm-map-db.js');
const { assertSelectOnly } = require('./farm-os-production-preflight.js');
const { resolveHostAwareSsl } = require('./lib/db-ssl.js');

const FINCA = 'HB-FINCA-01';

function checkEnv(env) {
  const reasons = [];
  if (env.FARM_OS_DB_ENV !== 'PRODUCTION_MAP_VERIFY') reasons.push('FARM_OS_DB_ENV debe ser PRODUCTION_MAP_VERIFY');
  if (!env.FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL) reasons.push('falta FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL');
  return { ok: reasons.length === 0, reasons };
}

// Verificación canónica read-only. `q(sql, params) -> { rows }` debe ser SELECT-only.
// Devuelve { ok, checks:[{name, ok, detail}] }. No escribe nada.
async function runCanonicalVerification(q, norm) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
  const one = async (sql, p = []) => (await q(sql, p)).rows[0];

  // COUNTS exactos (globales)
  const fs1 = await one('SELECT COUNT(*)::int c FROM farm_sites');
  add('farm_sites = 1', fs1.c === 1, `c=${fs1.c}`);
  const gz = await one('SELECT COUNT(*)::int c FROM geo_zones');
  add('geo_zones = 58', gz.c === 58, `c=${gz.c}`);
  const ga = await one('SELECT COUNT(*)::int c FROM geo_zone_aliases');
  add('geo_zone_aliases = 38', ga.c === 38, `c=${ga.c}`);
  const wk = await one('SELECT COUNT(*)::int c FROM workers');
  add('workers = 0', wk.c === 0, `c=${wk.c}`);
  const wd = await one('SELECT COUNT(*)::int c FROM worker_devices');
  add('worker_devices = 0', wd.c === 0, `c=${wd.c}`);

  // INVARIANTES ESTRUCTURALES (jerarquía, aliases exactos, source_context, C39–C42 ausentes,
  // self-parent=0, cross-farm=0, duplicados=0, tipos). Reutiliza verifyImportedMap (read-only).
  const v = await verifyImportedMap(q, FINCA);
  v.checks.forEach(c => add(c.name, c.ok, c.detail));

  // CONTENIDO CANÓNICO EXACTO: geometrías (canonical JSONB), nombres, tipos, jerarquía, boundary,
  // aliases y review=0. Reutiliza assertExistingIsCanonical (solo SELECT; lanza si difiere).
  let contentOk = true, contentMsg = '';
  try { await assertExistingIsCanonical(q, norm); } catch (e) { contentOk = false; contentMsg = e.message; }
  add('canonical content exact (geometrías/nombres/tipos/jerarquía/boundary/aliases/review)', contentOk, contentMsg);

  return { ok: checks.every(c => c.ok), checks };
}

async function main() {
  const env = process.env;
  const gate = checkEnv(env);
  if (!gate.ok) {
    console.error('⛔ PRODUCTION MAP VERIFY BLOCKED:');
    gate.reasons.forEach(r => console.error('   - ' + r));
    process.exit(1);
  }

  const url = env.FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: resolveHostAwareSsl(url) });
  // Barrera SELECT-only: cada query se valida antes de ejecutarse.
  const q = async (sql, params = []) => { assertSelectOnly(sql); return pool.query(sql, params); };

  try {
    const norm = JSON.parse(fs.readFileSync(NORMALIZED, 'utf8'));
    const { ok, checks } = await runCanonicalVerification(q, norm);

    console.log('\nPRODUCTION MAP VERIFY (READ-ONLY)\n');
    checks.forEach(c => console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.ok ? '' : ' — ' + c.detail}`));
    console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}\n`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { checkEnv, runCanonicalVerification, assertSelectOnly };
