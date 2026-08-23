#!/usr/bin/env node
/**
 * scripts/smoke-test.js — Prueba de regresión (smoke test) READ-ONLY.
 *
 * Verifica que las funciones críticas EXISTENTES siguen respondiendo:
 * arranque del servidor + endpoints de LECTURA (GET).
 *
 * SEGURIDAD:
 *  - Solo hace peticiones GET. No escribe, no borra.
 *  - Por defecto arranca una instancia LOCAL del servidor (LocalDB, sin DATABASE_URL),
 *    en un puerto de prueba: NO toca la base de producción.
 *  - Si defines SMOKE_BASE_URL, prueba contra esa URL (útil para validar producción de
 *    forma read-only), sin arrancar servidor local.
 *
 * Uso:
 *   node scripts/smoke-test.js
 *   SMOKE_BASE_URL=https://happy-budha-inventario-production.up.railway.app node scripts/smoke-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

// Cada endpoint declara la forma esperada de su respuesta, para que un 200 con un
// cuerpo incorrecto NO cuente como éxito. 'json' = objeto JSON; 'array' = arreglo JSON.
const GET_ENDPOINTS = [
  { path: '/health',          expect: 'json'  },
  { path: '/api/productos',   expect: 'array' },
  { path: '/api/movimientos', expect: 'array' },
  { path: '/api/produccion',  expect: 'array' },
  { path: '/api/mediciones',  expect: 'array' },
  { path: '/api/calendario',  expect: 'array' },
  { path: '/api/estadisticas', expect: 'json' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(base, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(base + '/health'); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

async function runChecks(base) {
  let pass = 0, fail = 0;
  for (const ep of GET_ENDPOINTS) {
    try {
      const r = await fetch(base + ep.path);
      const statusOk = r.status >= 200 && r.status < 400;
      const ctype = r.headers.get('content-type') || '';
      const isJsonCt = ctype.includes('application/json');

      let shapeOk = false, detalle = '';
      if (!statusOk) {
        detalle = 'status fuera de rango';
      } else if (!isJsonCt) {
        detalle = `content-type inesperado (${ctype || 'sin content-type'})`;
      } else {
        // Validar que el cuerpo parsea y tiene la forma esperada.
        let body;
        try { body = await r.json(); } catch (e) { body = undefined; detalle = 'cuerpo no es JSON válido'; }
        if (body !== undefined) {
          if (ep.expect === 'array') { shapeOk = Array.isArray(body); if (!shapeOk) detalle = 'se esperaba un arreglo JSON'; }
          else { shapeOk = body !== null && typeof body === 'object' && !Array.isArray(body); if (!shapeOk) detalle = 'se esperaba un objeto JSON'; }
        }
      }

      const ok = statusOk && isJsonCt && shapeOk;
      console.log(`  ${ok ? '✅' : '❌'} GET ${ep.path} → ${r.status} ${ctype ? '(' + ctype.split(';')[0] + ')' : ''} [${ep.expect}]${ok ? '' : ' — ' + detalle}`);
      ok ? pass++ : fail++;
    } catch (err) {
      console.log(`  ❌ GET ${ep.path} → error: ${err.message}`);
      fail++;
    }
  }
  return { pass, fail };
}

async function main() {
  console.log('\n==================  SMOKE TEST (READ-ONLY)  ==================\n');

  if (process.env.SMOKE_BASE_URL) {
    const base = process.env.SMOKE_BASE_URL.replace(/\/$/, '');
    console.log(`🌐 Probando contra: ${base} (solo GET)\n`);
    const up = await waitFor(base, 10000);
    if (!up) { console.log('❌ El servidor no respondió en /health.'); process.exit(1); }
    const { pass, fail } = await runChecks(base);
    console.log(`\nResultado: ${pass} OK, ${fail} fallos.`);
    process.exit(fail ? 1 : 0);
  }

  // Arrancar instancia local (LocalDB) en puerto de prueba.
  const PORT = process.env.SMOKE_PORT || 3599;
  const base = `http://localhost:${PORT}`;
  console.log(`🚀 Arrancando instancia local en ${base} (LocalDB, sin DATABASE_URL)...\n`);

  // DATABASE_URL='' (vacío) fuerza LocalDB: dotenv NO sobreescribe una var ya definida,
  // así que aunque server.js recargue .env, quedará vacía y no tocará producción.
  const env = { ...process.env, PORT: String(PORT), DATABASE_URL: '' };

  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let code = 0;
  try {
    const up = await waitFor(base, 25000);
    if (!up) { console.log('❌ El servidor local no arrancó a tiempo.'); code = 1; }
    else {
      const { pass, fail } = await runChecks(base);
      console.log(`\nResultado: ${pass} OK, ${fail} fallos.`);
      code = fail ? 1 : 0;
    }
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
  }
  console.log('\n=============================================================\n');
  process.exit(code);
}

main().catch(err => { console.error('❌ Error en smoke-test:', err.message); process.exit(1); });
