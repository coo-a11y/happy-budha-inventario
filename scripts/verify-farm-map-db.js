#!/usr/bin/env node
/**
 * scripts/verify-farm-map-db.js — Verificador READ-ONLY del mapa importado.
 *
 * SEGURIDAD:
 *  - Solo ejecuta SELECT (barrera: rechaza cualquier query que no empiece por SELECT).
 *  - Usa EXCLUSIVAMENTE FARM_OS_TEST_DATABASE_URL. Nunca DATABASE_URL (jamás se lee).
 *  - No escribe nada. Resultado final: PASS o FAIL.
 *
 * Uso:
 *   FARM_OS_TEST_DATABASE_URL=<url_test> node scripts/verify-farm-map-db.js
 */
'use strict';

const FINCA = 'HB-FINCA-01';

async function main() {
  const url = process.env.FARM_OS_TEST_DATABASE_URL;
  if (!url) {
    console.error('⛔ Falta FARM_OS_TEST_DATABASE_URL. Este verificador NO usa DATABASE_URL.');
    process.exit(1);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const q = async (sql, params = []) => {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('BLOQUEADO: solo SELECT permitido en el verificador.');
    return pool.query(sql, params);
  };

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
  const one = async (sql, params) => (await q(sql, params)).rows[0];

  try {
    // Finca única + boundary presente
    const finca = await one('SELECT COUNT(*)::int c FROM farm_sites WHERE code = $1', [FINCA]);
    check('HB-FINCA-01 existe exactamente 1 vez', finca.c === 1, `count=${finca.c}`);
    const fid = (await one('SELECT id, boundary_geojson FROM farm_sites WHERE code = $1', [FINCA])) || {};
    check('boundary_geojson IS NOT NULL', fid.boundary_geojson != null);

    const farmId = fid.id;
    // 58 zonas de esa finca
    const zc = await one('SELECT COUNT(*)::int c FROM geo_zones WHERE farm_site_id = $1', [farmId]);
    check('exactamente 58 zonas de la finca', zc.c === 58, `count=${zc.c}`);

    // 38 aliases C1–C38
    const ac = await one(`SELECT COUNT(*)::int c FROM geo_zone_aliases a
      JOIN geo_zones z ON z.id = a.geo_zone_id
      WHERE z.farm_site_id = $1 AND a.alias ~ '^C([1-9]|[12][0-9]|3[0-8])$'`, [farmId]);
    check('exactamente 38 aliases C1–C38', ac.c === 38, `count=${ac.c}`);

    // Todas las zonas con polygon_geojson
    const np = await one('SELECT COUNT(*)::int c FROM geo_zones WHERE farm_site_id = $1 AND polygon_geojson IS NULL', [farmId]);
    check('todas las zonas tienen polygon_geojson', np.c === 0, `sin polígono=${np.c}`);

    // Relaciones de jerarquía (por code)
    const parentOf = async (code) => {
      const r = await one(`SELECT p.code AS parent_code FROM geo_zones z
        LEFT JOIN geo_zones p ON p.id = z.parent_zone_id
        WHERE z.farm_site_id = $1 AND z.code = $2`, [farmId, code]);
      return r ? r.parent_code : undefined;
    };
    check('HB-NURSERY.parent = HB-PLANTA', (await parentOf('HB-NURSERY')) === 'HB-PLANTA');
    for (const n of [1, 2, 3, 4]) check(`HB-C${n}.parent = HB-CAMPO-C1-C4`, (await parentOf('HB-C' + n)) === 'HB-CAMPO-C1-C4');
    let c5_38 = true;
    for (let n = 5; n <= 38; n++) if ((await parentOf('HB-C' + n)) !== 'HB-CAMPO') { c5_38 = false; break; }
    check('HB-C5..C38.parent = HB-CAMPO', c5_38);
    check('HB-ZONA-EXPERIMENTAL.parent = HB-CAMPO', (await parentOf('HB-ZONA-EXPERIMENTAL')) === 'HB-CAMPO');
    const inv = await one('SELECT zone_type FROM geo_zones WHERE farm_site_id = $1 AND code = $2', [farmId, 'HB-INVERNADERO']);
    check('HB-INVERNADERO.zone_type = POSTHARVEST_PLANT', inv && inv.zone_type === 'POSTHARVEST_PLANT');

    // Sin auto-parent
    const sp = await one('SELECT COUNT(*)::int c FROM geo_zones WHERE parent_zone_id = id');
    check('ningún auto-parent', sp.c === 0, `count=${sp.c}`);

    // Sin parent de otra finca
    const xf = await one(`SELECT COUNT(*)::int c FROM geo_zones z JOIN geo_zones p ON p.id = z.parent_zone_id
      WHERE z.farm_site_id <> p.farm_site_id`);
    check('ningún parent de otra finca', xf.c === 0, `count=${xf.c}`);

    // Códigos duplicados por finca
    const dupC = await one(`SELECT COUNT(*)::int c FROM (
      SELECT farm_site_id, code FROM geo_zones GROUP BY farm_site_id, code HAVING COUNT(*) > 1) x`);
    check('códigos duplicados = 0', dupC.c === 0, `count=${dupC.c}`);

    // Aliases duplicados (misma zona+alias+contexto)
    const dupA = await one(`SELECT COUNT(*)::int c FROM (
      SELECT geo_zone_id, alias, COALESCE(source_context,'') sc FROM geo_zone_aliases
      GROUP BY geo_zone_id, alias, COALESCE(source_context,'') HAVING COUNT(*) > 1) x`);
    check('aliases duplicados = 0', dupA.c === 0, `count=${dupA.c}`);

    // Resultado
    const failed = checks.filter(c => !c.ok);
    console.log('\n=========  VERIFY farm map (READ-ONLY)  =========\n');
    checks.forEach(c => console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`));
    console.log(`\nRESULTADO: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length})\n`);
    process.exit(failed.length === 0 ? 0 : 1);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('❌ Error en verify:', err.message); process.exit(1); });
