#!/usr/bin/env node
/**
 * scripts/database-integrity-check.js
 *
 * Diagnóstico de integridad **READ-ONLY** de HappyBuddha Farm OS.
 * Puede correrse ANTES y DESPUÉS de una migración para comparar.
 *
 * GARANTÍA: este script SOLO ejecuta SELECT. No corrige, no borra, no altera nada.
 * (Barrera: se rechaza cualquier query que no empiece por SELECT.)
 *
 * Requiere DATABASE_URL (PostgreSQL). Sin ella, informa y sale.
 *
 * Uso:
 *   node scripts/database-integrity-check.js
 *   node scripts/database-integrity-check.js --json   # salida JSON
 */
'use strict';
require('dotenv').config();

const JSON_OUT = process.argv.includes('--json');
const TABLES = ['productos', 'lotes', 'movimientos', 'usuarios', 'conversiones', 'mediciones', 'cultivo_calendario', 'produccion'];

function out(label, value) { if (!JSON_OUT) console.log(label, value); }

async function main() {
  const report = { generado: new Date().toISOString(), tablas: {}, hallazgos: [] };

  if (!process.env.DATABASE_URL) {
    console.log('ℹ️  DATABASE_URL no está definida. Este chequeo corre contra PostgreSQL.');
    console.log('   Defínela (temporalmente, en tu shell) para diagnosticar la base real.');
    return;
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Barrera read-only: cualquier consulta debe ser SELECT.
  const q = async (sql, params = []) => {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('BLOQUEADO: solo se permiten SELECT en este script.');
    return pool.query(sql, params);
  };

  try {
    if (!JSON_OUT) console.log('\n==================  INTEGRITY CHECK (READ-ONLY)  ==================\n');

    // 1. Tablas existentes
    const existing = (await q(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    )).rows.map(r => r.table_name);
    report.tablas_existentes = existing;
    out('📚 Tablas en la base:', existing.join(', '));

    // 2. Conteo por tabla + columnas
    if (!JSON_OUT) console.log('\n-- Conteo de registros por tabla --');
    for (const t of TABLES) {
      if (!existing.includes(t)) { report.tablas[t] = { existe: false }; out(`  ⚠️  ${t}:`, 'NO EXISTE'); continue; }
      const count = parseInt((await q(`SELECT COUNT(*)::int AS c FROM ${t}`)).rows[0].c, 10);
      const cols = (await q(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]
      )).rows.map(r => r.column_name);
      report.tablas[t] = { existe: true, registros: count, columnas: cols };
      out(`  • ${t}:`, `${count} registros, ${cols.length} columnas`);
    }

    const add = (sev, msg, detalle) => report.hallazgos.push({ severidad: sev, mensaje: msg, detalle });

    // 3. Columnas críticas presentes
    const critical = {
      productos: ['id', 'codigo', 'stock', 'presentacion'],
      movimientos: ['id', 'producto_id', 'tipo'],
      produccion: ['id', 'tipo'],
      cultivo_calendario: ['lote'],
    };
    for (const [t, cols] of Object.entries(critical)) {
      if (!report.tablas[t]?.existe) continue;
      for (const c of cols) if (!report.tablas[t].columnas.includes(c)) add('ALTA', `Falta columna crítica ${t}.${c}`);
    }

    if (!JSON_OUT) console.log('\n-- Chequeos de integridad --');

    // 4. IDs duplicados (no debería con PK, pero se verifica)
    for (const t of TABLES) {
      if (!report.tablas[t]?.existe) continue;
      const dups = parseInt((await q(`SELECT COUNT(*)::int AS c FROM (SELECT id FROM ${t} GROUP BY id HAVING COUNT(*) > 1) x`)).rows[0].c, 10);
      if (dups > 0) add('ALTA', `IDs duplicados en ${t}`, dups);
    }

    // 5. Stocks negativos
    if (report.tablas.productos?.existe) {
      const neg = (await q(`SELECT id, codigo, stock FROM productos WHERE stock < 0 ORDER BY stock ASC`)).rows;
      report.stocks_negativos = neg;
      if (neg.length) add('MEDIA', `Productos con stock negativo`, neg.length);
    }

    // 6. Movimientos sin producto (huérfanos detectables)
    if (report.tablas.movimientos?.existe && report.tablas.productos?.existe) {
      const orf = parseInt((await q(
        `SELECT COUNT(*)::int AS c FROM movimientos m WHERE m.producto_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM productos p WHERE p.id = m.producto_id)`
      )).rows[0].c, 10);
      const nulls = parseInt((await q(`SELECT COUNT(*)::int AS c FROM movimientos WHERE producto_id IS NULL`)).rows[0].c, 10);
      report.movimientos_huerfanos = orf;
      report.movimientos_producto_null = nulls;
      if (orf > 0) add('MEDIA', `Movimientos con producto_id inexistente`, orf);
      if (nulls > 0) add('INFO', `Movimientos con producto_id NULL (esperable tras borrar productos, ON DELETE SET NULL)`, nulls);
    }

    // 7. Lotes huérfanos
    if (report.tablas.lotes?.existe && report.tablas.productos?.existe) {
      const orf = parseInt((await q(
        `SELECT COUNT(*)::int AS c FROM lotes l WHERE l.producto_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM productos p WHERE p.id = l.producto_id)`
      )).rows[0].c, 10);
      report.lotes_huerfanos = orf;
      if (orf > 0) add('MEDIA', `Lotes con producto_id inexistente`, orf);
    }

    // 8. Producción sin referencias detectables (cosecha sin lote, registros sin tipo)
    if (report.tablas.produccion?.existe) {
      const sinTipo = parseInt((await q(`SELECT COUNT(*)::int AS c FROM produccion WHERE tipo IS NULL OR tipo = ''`)).rows[0].c, 10);
      const cosSinLote = parseInt((await q(`SELECT COUNT(*)::int AS c FROM produccion WHERE tipo = 'cosecha' AND (lote IS NULL OR lote = '')`)).rows[0].c, 10);
      if (sinTipo > 0) add('MEDIA', `Registros de producción sin 'tipo'`, sinTipo);
      if (cosSinLote > 0) add('INFO', `Cosechas sin lote asignado`, cosSinLote);
    }

    // Resumen
    if (!JSON_OUT) {
      console.log('\n-- Hallazgos --');
      if (report.hallazgos.length === 0) console.log('  ✅ Sin hallazgos de integridad.');
      else report.hallazgos.forEach(h => console.log(`  [${h.severidad}] ${h.mensaje}${h.detalle !== undefined ? ' → ' + JSON.stringify(h.detalle) : ''}`));
      console.log('\n=================================================================\n');
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('❌ Error en integrity-check:', err.message); process.exit(1); });
