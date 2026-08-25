'use strict';
/**
 * scripts/lib/db-ssl.js — Resolución de SSL para conexiones PostgreSQL.
 *
 * Regla: SSL se mantiene para cualquier host NO local. Solo se permite deshabilitarlo
 * para PostgreSQL LOCAL de prueba, y bajo condiciones estrictas.
 */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch (_) { return ''; }
}
function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * SSL para el importador/verificador (usan FARM_OS_TEST_DATABASE_URL).
 * FARM_OS_TEST_DB_SSL=DISABLE solo se acepta si TODO se cumple:
 *   - FARM_OS_DB_ENV === 'TEST'
 *   - el host de FARM_OS_TEST_DATABASE_URL es local (localhost/127.0.0.1/::1)
 *   - FARM_OS_TEST_DB_NAME empieza por 'hb_farm_os_test'
 * Si se pide DISABLE sin cumplirse, se LANZA error (rechazado). En cualquier otro caso,
 * SSL activado (rejectUnauthorized:false).
 */
function resolveTestSsl(env) {
  if (env.FARM_OS_TEST_DB_SSL === 'DISABLE') {
    const host = hostOf(env.FARM_OS_TEST_DATABASE_URL || '');
    const ok = env.FARM_OS_DB_ENV === 'TEST'
      && isLocalHost(host)
      && /^hb_farm_os_test/.test(env.FARM_OS_TEST_DB_NAME || '');
    if (!ok) {
      throw new Error('SSL_DISABLE_RECHAZADO: FARM_OS_TEST_DB_SSL=DISABLE solo se permite con FARM_OS_DB_ENV=TEST, host local y FARM_OS_TEST_DB_NAME que empiece por hb_farm_os_test.');
    }
    return false; // sin SSL, solo para Postgres local de prueba
  }
  return { rejectUnauthorized: false };
}

/**
 * SSL para el migration runner (usa DATABASE_URL). Regla simple y segura: si el host es
 * local, no requiere SSL; si es remoto, SSL activado. (Un Postgres local no expone SSL por
 * defecto; uno remoto/Railway sí.)
 */
function resolveMigrateSsl(databaseUrl) {
  return isLocalHost(hostOf(databaseUrl || '')) ? false : { rejectUnauthorized: false };
}

module.exports = { hostOf, isLocalHost, resolveTestSsl, resolveMigrateSsl };
