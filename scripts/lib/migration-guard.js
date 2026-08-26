'use strict';
/**
 * scripts/lib/migration-guard.js — Production Migration Write Guard.
 *
 * Impide migraciones REALES accidentales contra una base remota/productiva.
 * No confía en el nombre de la base (Railway suele llamarse "railway"): decide por el HOST.
 *
 * Reglas:
 *  - --dry-run: SIEMPRE permitido (cero escrituras), también contra remoto, sin variables.
 *  - Apply real contra host LOCAL (localhost/127.0.0.1/::1): permitido como siempre.
 *  - Apply real contra host REMOTO: exige EXACTAMENTE ambas variables:
 *      FARM_OS_DB_ENV=PRODUCTION_DEPLOY
 *      FARM_OS_PRODUCTION_MIGRATION_CONFIRM=APPLY_FARM_OS_MIGRATIONS
 *    Si falta o difiere cualquiera → bloqueado (antes de conectar/CREATE/BEGIN/DDL/INSERT).
 */
const { hostOf, isLocalHost } = require('./db-ssl.js');

const REQUIRED_ENV = 'PRODUCTION_DEPLOY';
const REQUIRED_CONFIRM = 'APPLY_FARM_OS_MIGRATIONS';

/**
 * @param {object} env  process.env
 * @param {string} databaseUrl  connection string
 * @param {boolean} dryRun
 * @returns {{allowed:boolean, blocked:boolean, isRemote:boolean, reason:string, missing:string[]}}
 */
function evaluateMigrationGuard(env, databaseUrl, dryRun) {
  const isRemote = !isLocalHost(hostOf(databaseUrl || ''));

  // Dry-run nunca escribe: permitido en cualquier host, sin variables de deploy.
  if (dryRun) return { allowed: true, blocked: false, isRemote, reason: 'dry-run (cero escrituras)', missing: [] };

  // Apply local: sin guard (desarrollo / base de prueba local).
  if (!isRemote) return { allowed: true, blocked: false, isRemote: false, reason: 'host local', missing: [] };

  // Apply real contra remoto: exige ambas variables EXACTAS.
  const okEnv = env.FARM_OS_DB_ENV === REQUIRED_ENV;
  const okConfirm = env.FARM_OS_PRODUCTION_MIGRATION_CONFIRM === REQUIRED_CONFIRM;
  if (okEnv && okConfirm) return { allowed: true, blocked: false, isRemote: true, reason: 'guard autorizado', missing: [] };

  const missing = [];
  if (!okEnv) missing.push(`FARM_OS_DB_ENV=${REQUIRED_ENV}`);
  if (!okConfirm) missing.push(`FARM_OS_PRODUCTION_MIGRATION_CONFIRM=${REQUIRED_CONFIRM}`);
  return { allowed: false, blocked: true, isRemote: true, reason: 'PRODUCTION MIGRATION BLOCKED', missing };
}

module.exports = { evaluateMigrationGuard, REQUIRED_ENV, REQUIRED_CONFIRM };
