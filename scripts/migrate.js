#!/usr/bin/env node
/**
 * scripts/migrate.js — Runner de migraciones versionadas de HappyBuddha Farm OS.
 *
 * SEGURIDAD:
 *  - Las migraciones normales deben ser ADITIVAS. Se rechaza por defecto cualquier SQL que
 *    contenga acciones destructivas o de modificación de datos existentes (ver BARRERA).
 *  - --dry-run realiza CERO escrituras: no CREATE, no INSERT, no ALTER, no UPDATE, no DELETE.
 *    Solo consulta information_schema / schema_migrations (si ya existe). Si schema_migrations
 *    no existe todavía, lo reporta y trata TODAS las migraciones como pendientes, sin crearla.
 *  - Solo aplica archivos de migrations/ que aún no estén registrados en schema_migrations.
 *  - Requiere DATABASE_URL (PostgreSQL). Sin ella no hace nada (la base local usa el
 *    mecanismo del arranque en server.js).
 *
 * Uso:
 *   node scripts/migrate.js --dry-run
 *   node scripts/migrate.js
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// BARRERA DE SEGURIDAD — migraciones normales = solo aditivas.
// Se bloquea cualquier migración que contenga estas acciones destructivas o de
// modificación de datos existentes. Un backfill/transformación necesitará un
// mecanismo separado con autorización explícita (aún NO implementado).
const BARRERA = [
  { re: /\bDROP\b/i,                          motivo: 'DROP (tabla/columna/objeto)' },
  { re: /\bTRUNCATE\b/i,                      motivo: 'TRUNCATE' },
  { re: /\bDELETE\s+FROM\b/i,                 motivo: 'DELETE FROM (borrado de datos)' },
  { re: /\bUPDATE\s+\w/i,                     motivo: 'UPDATE (modificación de datos)' },
  { re: /\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i,  motivo: 'ALTER TABLE ... DROP' },
  { re: /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i, motivo: 'ALTER TABLE ... RENAME' },
  { re: /\bALTER\s+COLUMN\b/i,                motivo: 'ALTER COLUMN (cambio de tipo/compatibilidad)' },
  { re: /\bSET\s+DATA\s+TYPE\b/i,             motivo: 'SET DATA TYPE (cambio de tipo)' },
];

function log(msg) { console.log(msg); }

// Quita comentarios SQL (línea -- ... y bloque /* ... */) para que la barrera analice
// solo el SQL ejecutable, no el texto de los comentarios.
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // bloque
    .replace(/--[^\n]*/g, ' ');           // línea
}

// Devuelve el motivo si el SQL (sin comentarios) viola la barrera; null si es seguro (aditivo).
function violaBarrera(sql) {
  const limpio = stripSqlComments(sql);
  for (const b of BARRERA) if (b.re.test(limpio)) return b.motivo;
  return null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    log('ℹ️  DATABASE_URL no está definida. Nada que migrar (la base local usa el');
    log('   mecanismo de arranque en server.js). Saliendo sin cambios.');
    return;
  }

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    : [];

  // Validación estática de la barrera (no requiere BD; aplica también en dry-run).
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const motivo = violaBarrera(sql);
    if (motivo) {
      log(`⛔ ABORTADO: ${file} viola la barrera aditiva → ${motivo}.`);
      log('   Las migraciones normales solo pueden ser aditivas. Un backfill/transformación');
      log('   requiere un mecanismo separado con autorización explícita (no implementado).');
      process.exitCode = 1;
      return;
    }
  }

  // PRODUCTION MIGRATION WRITE GUARD — evaluado ANTES de conectar / CREATE / BEGIN / DDL / INSERT.
  // Bloquea una migración REAL contra un host remoto sin autorización explícita de producción.
  // No afecta a --dry-run (cero escrituras) ni a hosts locales.
  const { evaluateMigrationGuard } = require('./lib/migration-guard.js');
  const guard = evaluateMigrationGuard(process.env, process.env.DATABASE_URL, DRY_RUN);
  if (guard.blocked) {
    log('⛔ PRODUCTION MIGRATION BLOCKED');
    log('   Migración REAL contra un host remoto sin autorización explícita de producción.');
    log('   Para aplicar en producción se exigen EXACTAMENTE ambas variables:');
    guard.missing.forEach(m => log('   - ' + m));
    log('   (Se abortó ANTES de conectar y ANTES de cualquier escritura.)');
    process.exitCode = 1;
    return;
  }

  const { Pool } = require('pg');
  const { resolveMigrateSsl } = require('./lib/db-ssl.js');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveMigrateSsl(process.env.DATABASE_URL),
  });

  try {
    // ¿Existe ya la tabla de control? (solo lectura de information_schema)
    const existeControl = (await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
    )).rowCount > 0;

    // Conjunto de migraciones ya aplicadas (solo lectura; vacío si la tabla no existe).
    let applied = new Set();
    if (existeControl) {
      applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    }

    const pending = files.filter(f => !applied.has(f));
    log(`📋 Migraciones: ${files.length} totales | ${applied.size} aplicadas | ${pending.length} pendientes` +
        (existeControl ? '' : ' (schema_migrations aún NO existe)'));

    // ---------- DRY RUN: cero escrituras ----------
    if (DRY_RUN) {
      if (!existeControl) {
        log('🔎 [dry-run] La tabla schema_migrations no existe. NO se crea en dry-run.');
        log('             En una ejecución real se crearía antes de aplicar migraciones.');
      }
      if (pending.length === 0) log('🔎 [dry-run] No hay migraciones pendientes.');
      else pending.forEach(f => log(`🔎 [dry-run] Se aplicaría: ${f}`));
      log('🔎 dry-run terminado. CERO escrituras realizadas (ni CREATE, ni INSERT, ni ALTER).');
      return;
    }

    // ---------- EJECUCIÓN REAL ----------
    if (pending.length === 0) { log('✅ Base al día. No hay migraciones pendientes.'); return; }

    // Recién ahora (fuera de dry-run) se crea la tabla de control si falta.
    if (!existeControl) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id SERIAL PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      log('🧱 Tabla schema_migrations creada.');
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      log(`➡️  Aplicando: ${file}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`   ✅ ${file} aplicada y registrada.`);
      } catch (err) {
        await client.query('ROLLBACK');
        log(`   ❌ Error en ${file}: ${err.message}. Se hizo ROLLBACK, no se registró.`);
        process.exitCode = 1;
        return;
      } finally {
        client.release();
      }
    }
    log('✅ Migraciones pendientes aplicadas correctamente.');
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('❌ Error fatal en migrate.js:', err.message); process.exit(1); });
