'use strict';
/**
 * scripts/lib/import-guard.js — Production Map Import Write Guard.
 *
 * Equivalente conceptual al migration guard, pero para el importador del mapa.
 * Decide por el HOST (no por el nombre de la base; Railway suele llamarse "railway").
 *
 * Reglas:
 *  - dry-run: SIEMPRE permitido (cero escrituras), también contra remoto, sin variables.
 *  - Apply real contra host LOCAL (localhost/127.0.0.1/::1): permitido (pruebas), sin guard.
 *  - Apply real contra host REMOTO: exige EXACTAMENTE ambas variables:
 *      FARM_OS_DB_ENV=PRODUCTION_IMPORT
 *      FARM_OS_PRODUCTION_IMPORT_CONFIRM=IMPORT_VERIFIED_FARM_MAP
 *    Si falta o difiere cualquiera → bloqueado (antes de conectar / BEGIN / INSERT / DDL).
 */
const { hostOf, isLocalHost } = require('./db-ssl.js');

const REQUIRED_ENV = 'PRODUCTION_IMPORT';
const REQUIRED_CONFIRM = 'IMPORT_VERIFIED_FARM_MAP';

function evaluateImportGuard(env, databaseUrl, dryRun) {
  const isRemote = !isLocalHost(hostOf(databaseUrl || ''));

  if (dryRun) return { allowed: true, blocked: false, isRemote, reason: 'dry-run (cero escrituras)', missing: [] };
  if (!isRemote) return { allowed: true, blocked: false, isRemote: false, reason: 'host local', missing: [] };

  const okEnv = env.FARM_OS_DB_ENV === REQUIRED_ENV;
  const okConfirm = env.FARM_OS_PRODUCTION_IMPORT_CONFIRM === REQUIRED_CONFIRM;
  if (okEnv && okConfirm) return { allowed: true, blocked: false, isRemote: true, reason: 'guard autorizado', missing: [] };

  const missing = [];
  if (!okEnv) missing.push(`FARM_OS_DB_ENV=${REQUIRED_ENV}`);
  if (!okConfirm) missing.push(`FARM_OS_PRODUCTION_IMPORT_CONFIRM=${REQUIRED_CONFIRM}`);
  return { allowed: false, blocked: true, isRemote: true, reason: 'PRODUCTION MAP IMPORT BLOCKED', missing };
}

module.exports = { evaluateImportGuard, REQUIRED_ENV, REQUIRED_CONFIRM };
