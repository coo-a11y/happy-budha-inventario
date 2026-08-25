#!/usr/bin/env node
/**
 * scripts/verify-farm-map-db.js — Verificador READ-ONLY del mapa importado.
 *
 * SEGURIDAD:
 *  - Solo ejecuta SELECT (barrera: rechaza cualquier query que no empiece por SELECT).
 *  - Usa EXCLUSIVAMENTE FARM_OS_TEST_DATABASE_URL. Nunca DATABASE_URL (jamás se lee).
 *  - Exige FARM_OS_TEST_DB_NAME y confirma current_database() antes de verificar.
 *  - No escribe nada. Resultado final: PASS o FAIL.
 *
 * Uso:
 *   FARM_OS_TEST_DATABASE_URL=<url> FARM_OS_TEST_DB_NAME=hb_farm_os_test node scripts/verify-farm-map-db.js
 */
'use strict';
const { verifyImportedMap, assertTestDatabaseIdentity } = require('./import-farm-map-db.js');

const FINCA = 'HB-FINCA-01';

async function main() {
  const url = process.env.FARM_OS_TEST_DATABASE_URL;
  if (!url) { console.error('⛔ Falta FARM_OS_TEST_DATABASE_URL. Este verificador NO usa DATABASE_URL.'); process.exit(1); }
  if (!process.env.FARM_OS_TEST_DB_NAME) { console.error('⛔ Falta FARM_OS_TEST_DB_NAME.'); process.exit(1); }

  const { Pool } = require('pg');
  const { resolveTestSsl } = require('./lib/db-ssl.js');
  const pool = new Pool({ connectionString: url, ssl: resolveTestSsl(process.env) });

  // Barrera read-only: cualquier consulta debe ser SELECT.
  const q = async (sql, params = []) => {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('BLOQUEADO: solo SELECT permitido en el verificador.');
    return pool.query(sql, params);
  };

  try {
    // Identidad de la base TEST (solo lectura) antes de verificar.
    const dbName = await assertTestDatabaseIdentity(q, process.env.FARM_OS_TEST_DB_NAME);
    console.log(`\n=========  VERIFY farm map (READ-ONLY) — db: ${dbName}  =========\n`);

    const { ok, checks } = await verifyImportedMap(q, FINCA);
    checks.forEach(c => console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`));
    const failed = checks.filter(c => !c.ok).length;
    console.log(`\nRESULTADO: ${ok ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})\n`);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('❌ Error en verify:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
