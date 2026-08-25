# FARM OS 2C.2 — Runbook de prueba en PostgreSQL local temporal

> **Por qué este runbook:** el entorno donde corre el asistente **no** tiene Docker ni
> PostgreSQL, así que la prueba física de 2C.2 debe ejecutarse en **tu Mac**. Aquí están los
> comandos exactos. Todo ocurre **solo** en la base temporal `hb_farm_os_test_20260825`.
> **Nunca** se usa Railway/producción ni `DATABASE_URL` productivo.

## 0. Requisitos

Docker Desktop en tu Mac (recomendado). Alternativa: un PostgreSQL 16 local.

## 1. Levantar PostgreSQL 16 temporal (Docker, solo localhost)

```bash
docker run -d --name hb-farm-os-test-pg \
  -e POSTGRES_PASSWORD=hbtestpw \
  -e POSTGRES_DB=hb_farm_os_test_20260825 \
  -p 127.0.0.1:55432:5432 \
  postgres:16
# esperar unos segundos a que arranque
docker exec hb-farm-os-test-pg pg_isready -U postgres
```

Contenedor identificable, expuesto **solo** en `127.0.0.1:55432`. No reutiliza nada real.

## 2. Variables de entorno (solo para esta sesión de terminal)

```bash
cd ~/Desktop/happybudha-inventario\ 5

export FARM_OS_TEST_DATABASE_URL='postgres://postgres:hbtestpw@127.0.0.1:55432/hb_farm_os_test_20260825'
export FARM_OS_DB_ENV=TEST
export FARM_OS_DB_IMPORT_CONFIRM=YES
export FARM_OS_TEST_DB_NAME=hb_farm_os_test_20260825
export FARM_OS_TEST_DB_SSL=DISABLE     # Postgres local no expone SSL
```

> El gate de SSL solo acepta `DISABLE` con `ENV=TEST`, host local y DB `hb_farm_os_test*`.

## 3. Preflight de identidad (read-only)

```bash
psql "$FARM_OS_TEST_DATABASE_URL" -c "SELECT current_database();"   # debe ser hb_farm_os_test_20260825
psql "$FARM_OS_TEST_DATABASE_URL" -c "SELECT current_user; SELECT version();"
```

Si `current_database()` no es exactamente `hb_farm_os_test_20260825` → **abortar**.

## 4. Migraciones 001 y 002 (solo contra la DB temporal)

`migrate.js` usa `DATABASE_URL`; se lo pasamos **inline apuntando al local** (nunca hereda producción).
Con host local, el runner desactiva SSL automáticamente.

```bash
# Dry-run primero
DATABASE_URL="$FARM_OS_TEST_DATABASE_URL" node scripts/migrate.js --dry-run
# Aplicar
DATABASE_URL="$FARM_OS_TEST_DATABASE_URL" node scripts/migrate.js
```

Confirmar migraciones + tablas:

```bash
psql "$FARM_OS_TEST_DATABASE_URL" -c "SELECT name FROM schema_migrations ORDER BY name;"
psql "$FARM_OS_TEST_DATABASE_URL" -c "\dt"
```

## 5. Validar el esquema de 002 (read-only)

```bash
psql "$FARM_OS_TEST_DATABASE_URL" -f scripts/sql/farm-os-schema-checks.sql
```

## 6. Primera importación (esperado: 1 / 58 / 38 insertados)

```bash
node scripts/import-farm-map-db.js --apply
```

## 7. Verificador read-only (esperado: PASS)

```bash
node scripts/verify-farm-map-db.js
```

## 8. Segunda importación — idempotencia (esperado: 0 insertados / 1·58·38 matched)

```bash
node scripts/import-farm-map-db.js --apply
node scripts/verify-farm-map-db.js     # sigue PASS; conteos 1/58/38
```

## 9. Probar constraints (todo en transacción con ROLLBACK)

```bash
psql "$FARM_OS_TEST_DATABASE_URL" -v ON_ERROR_STOP=0 -f scripts/sql/farm-os-constraint-probes.sql
```

Cada bloque "DEBE FALLAR" tiene que imprimir un ERROR; el bloque "DEBE PERMITIR" (NULLs) no.
Al final, conteos reales: `farm_sites=1, geo_zones=58, geo_zone_aliases=38, workers=0, worker_devices=0`.

## 10. Suites de tests

```bash
# STATIC / UNIT (sin base de datos)
node tests/kml-import.test.js
node tests/farm-map-db.test.js
node scripts/migrate.js --dry-run

# INTEGRACIÓN PostgreSQL real (con las env vars de arriba)
node scripts/import-farm-map-db.js --apply    # 2a corrida: idempotente
node scripts/verify-farm-map-db.js            # PASS
psql "$FARM_OS_TEST_DATABASE_URL" -f scripts/sql/farm-os-constraint-probes.sql
```

## 11. Al terminar (NO destruir todavía)

```bash
docker stop hb-farm-os-test-pg      # OK detener
# NO ejecutar: docker rm  /  DROP DATABASE  (conservar para revisión)
```

## Reglas de seguridad

- No usar `DATABASE_URL` de producción en ninguno de estos comandos.
- Si cualquier variable apunta a un host que no sea `127.0.0.1/localhost`, **abortar**.
- No hacer merge a `main` en esta fase.
