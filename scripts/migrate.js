#!/usr/bin/env node
/**
 * scripts/migrate.js — Runner de migraciones versionadas de HappyBuddha Farm OS.
 *
 * SEGURIDAD:
 *  - Solo aplica archivos de migrations/ que aún no estén registrados en schema_migrations.
 *  - NO ejecuta DROP TABLE, TRUNCATE ni borrados masivos: rechaza cualquier migración
 *    que contenga esos comandos (barrera de seguridad).
 *  - --dry-run muestra lo que se aplicaría sin ejecutar nada.
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
const FORBIDDEN = /\b(DROP\s+TABLE|TRUNCATE|DROP\s+DATABASE|DELETE\s+FROM)\b/i;

function log(msg) { console.log(msg); }

async function main() {
  if (!process.env.DATABASE_URL) {
    log('ℹ️  DATABASE_URL no está definida. Nada que migrar (la base local usa el');
    log('   mecanismo de arranque en server.js). Saliendo sin cambios.');
    return;
  }

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // Tabla de control (aditiva, idempotente). No toca datos existentes.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const applied = new Set(
      (await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
    );

    const files = fs.existsSync(MIGRATIONS_DIR)
      ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
      : [];

    const pending = files.filter(f => !applied.has(f));

    log(`📋 Migraciones encontradas: ${files.length} | ya aplicadas: ${applied.size} | pendientes: ${pending.length}`);
    if (pending.length === 0) { log('✅ Base al día. No hay migraciones pendientes.'); return; }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      // Barrera de seguridad: ninguna migración destructiva pasa.
      if (FORBIDDEN.test(sql)) {
        log(`⛔ ABORTADO: ${file} contiene un comando destructivo (DROP/TRUNCATE/DELETE).`);
        log('   Las migraciones destructivas están prohibidas por política. Revísala.');
        process.exitCode = 1;
        return;
      }

      if (DRY_RUN) {
        log(`🔎 [dry-run] Se aplicaría: ${file}`);
        continue;
      }

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

    if (DRY_RUN) log('🔎 dry-run terminado. No se ejecutó ningún cambio.');
    else log('✅ Migraciones pendientes aplicadas correctamente.');
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('❌ Error fatal en migrate.js:', err.message); process.exit(1); });
