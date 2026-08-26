# FARM OS — Runbook de despliegue en producción

> Estado: **solo sección PRE-DEPLOY**. Esta fase (2D) **no** ejecuta migraciones ni escribe en
> producción. El despliegue real (aplicar `002`) se hará en una fase posterior, con tu
> autorización explícita. **No** colocar contraseñas, URLs ni secretos en este documento.

## PRE-DEPLOY (obligatorio antes de aplicar cualquier migración)

Ningún paso de despliegue puede iniciar hasta completar y registrar TODO lo siguiente.

### 1. Backup completo de producción (`pg_dump`)

Con la `DATABASE_URL` de producción **solo en tu terminal** (nunca en el repo):

```bash
STAMP=$(date +%Y%m%d_%H%M%S)
pg_dump "$PROD_URL" -Fc -f "backup_prod_farmos_$STAMP.dump"
```

Registrar en la bitácora de despliegue (fuera del repo):

2. **Fecha/hora del backup** (`$STAMP`).
3. **Tamaño del archivo**:

```bash
ls -lh "backup_prod_farmos_$STAMP.dump"
```

4. **SHA-256 del backup** (integridad):

```bash
shasum -a 256 "backup_prod_farmos_$STAMP.dump"
```

**Validación mínima de que el archive puede leerse** (no restaura nada):

```bash
pg_restore --list "backup_prod_farmos_$STAMP.dump" | head -40
```

Debe listar los objetos del backup (tablas históricas incluidas). Si `--list` falla, el
backup NO es válido → detenerse.

### 5. Snapshot de preflight EXITOSO (read-only)

```bash
FARM_OS_DB_ENV=PRODUCTION_PREFLIGHT \
FARM_OS_PRODUCTION_DATABASE_URL="$PROD_URL" \
  node scripts/farm-os-production-preflight.js
```

Debe terminar sin conflictos (`new_tables_conflict = OK`) y con `002 aditiva = YES`.
Genera `reports/production-preflight-snapshot.json` (estructura + conteos, sin datos sensibles).

### 6. Confirmación de las 8 tablas históricas

Del snapshot, anotar `COUNT(*)` de: `productos, lotes, movimientos, usuarios, conversiones,
mediciones, cultivo_calendario, produccion`. Estos números son la **línea base**: tras el
despliegue deberán ser **idénticos** (comparación before/after).

### 7. Copia del resultado fuera del repositorio

Guardar el `.dump`, su SHA-256 y una copia del snapshot en un almacenamiento seguro **fuera
de Git** (no versionar backups ni snapshots con datos).

## Flujo exacto de despliegue (orden obligatorio)

```
1. preflight ................ node scripts/farm-os-production-preflight.js  → READY_FOR_DEPLOY_REVIEW
2. backup validado .......... pg_dump + tamaño + SHA-256 + pg_restore --list
3. restore rehearsal ........ restaurar el backup en una base SEPARADA y verificar conteos
4. production guard ......... el write guard de migrate.js exige autorización explícita
5. explicit deploy auth ..... exportar las DOS variables de producción (abajo)
6. migration ................ node scripts/migrate.js  (aplica 001 + 002)
7. post-deploy verification .. re-ejecutar preflight y comparar before/after (8 tablas iguales)
```

### Detalle de cada paso

**1. Preflight (read-only).**
```bash
FARM_OS_DB_ENV=PRODUCTION_PREFLIGHT FARM_OS_PRODUCTION_DATABASE_URL="$PROD_URL" \
  node scripts/farm-os-production-preflight.js     # debe imprimir READY_FOR_DEPLOY_REVIEW
```

**2. Backup validado.** `pg_dump -Fc`, registrar tamaño, `shasum -a 256`, y `pg_restore --list` (ver arriba).

**3. Restore rehearsal.** Restaurar el `.dump` en una base **separada** y confirmar que los
conteos de las 8 tablas históricas coinciden con la línea base del snapshot. (Ya realizado.)

**4. Production guard.** `scripts/migrate.js` ahora bloquea toda migración REAL contra un host
remoto salvo que estén presentes las dos variables del paso 5. Sin ellas:
`PRODUCTION MIGRATION BLOCKED` (aborta antes de conectar y antes de escribir). `--dry-run`
sigue permitido contra producción sin variables, con cero escrituras.

**5. Autorización explícita de despliegue.** Solo cuando decidas desplegar, en tu terminal:
```bash
export DATABASE_URL="$PROD_URL"                 # solo para este comando
export FARM_OS_DB_ENV=PRODUCTION_DEPLOY
export FARM_OS_PRODUCTION_MIGRATION_CONFIRM=APPLY_FARM_OS_MIGRATIONS
```

**6. Migración.**
```bash
node scripts/migrate.js --dry-run     # confirmación final (sin escrituras)
node scripts/migrate.js               # aplica 001 + 002 (con el guard autorizado)
```

**7. Verificación post-deploy.** Re-ejecutar el preflight (read-only) y comparar `before` vs
`after`: las **8 tablas históricas** deben mantener **exactamente** los mismos `COUNT(*)`; las
5 tablas nuevas pasan a existir (vacías); `schema_migrations` incluye `001` y `002`.

## Criterios para autorizar el despliegue

- Backup verificado (existe, pesa > 0, SHA-256 registrado).
- Preflight sin `CONFLICT_REQUIRES_REVIEW` (ninguna de las 5 tablas nuevas existe aún).
- `002` confirmada aditiva por el análisis estático.
- Línea base de las 8 tablas históricas registrada.

## Seguridad de credenciales (recordatorio)

- No versionar `DATABASE_URL`, `.env`, backups ni snapshots con datos.
- Cualquier credencial que haya quedado **históricamente expuesta en Git** (ver
  `docs/SECURITY_AUDIT.md`, p. ej. el `DATABASE_URL` que estuvo en `.enves`) **debe rotarse**
  antes o durante la preparación del despliegue. No se rota nada automáticamente.

## Importación del mapa a producción (fase 2E — NO ejecutar aún)

Solo **después** de que `002` esté aplicada y verificada en producción. El importador tiene un
**Production Map Import Guard** host-based: bloquea todo apply REAL contra host remoto salvo que
estén presentes las dos variables de autorización. `--dry-run` remoto está permitido sin ellas y
con cero escrituras.

Flujo exacto:

```
1. map preflight / dry-run ... node scripts/import-farm-map-db.js --dry-run   (1/58/38, 0 writes)
2. explicit authorization .... exportar las DOS variables de import (abajo)
3. import transaction ........ node scripts/import-farm-map-db.js --apply
                               (guard → estado inicial 0/0/0 → BEGIN → inserts en orden
                                topológico → verificación pre-COMMIT → COMMIT; ROLLBACK ante fallo)
4. exact verify .............. farm_sites=1, geo_zones=58, geo_zone_aliases=38, jerarquía OK,
                               cycles=0, missing parents=0, review=0, C39–C42 ausentes,
                               aliases exactos, geometrías canónicas
5. application smoke test .... node scripts/smoke-test.js (o SMOKE_BASE_URL=<prod> solo GET)
6. retain backup ............. conservar el backup pre-deploy validado
```

**Autorización explícita (paso 2)** — solo cuando decidas importar:

```bash
export FARM_OS_DB_ENV=PRODUCTION_IMPORT
export FARM_OS_PRODUCTION_IMPORT_CONFIRM=IMPORT_VERIFIED_FARM_MAP
export FARM_OS_PRODUCTION_IMPORT_DATABASE_URL="$PROD_URL"   # solo para este comando
```

Sin las dos variables exactas contra un host remoto: `PRODUCTION MAP IMPORT BLOCKED`
(aborta antes de conectar y antes de cualquier escritura).

**Estado inicial aceptado.** El importador solo procede si producción está en `0/0/0`
(farm_sites/geo_zones/geo_zone_aliases) o **exactamente** en el dataset canónico ya importado
(`1/58/38`) para una re-ejecución idempotente. Cualquier estado parcial/inesperado →
`PRODUCTION MAP IMPORT BLOCKED` + ROLLBACK. Nunca se mezclan datasets.

**Nota GIS.** El perímetro dibujado (~46.68 ha) es geometría del mapa; **no** representa el área
cultivada/legal actual.

### Cierre del despliegue del mapa (post-import)

```
1. post-import counts ........ farm_sites=1, geo_zones=58, geo_zone_aliases=38, workers=0, worker_devices=0
2. production canonical verify (READ-ONLY):
     FARM_OS_DB_ENV=PRODUCTION_MAP_VERIFY \
     FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL="$PROD_URL" \
       node scripts/verify-production-farm-map.js        # RESULT: PASS
3. application smoke test ..... SMOKE_BASE_URL="$PROD_URL" node scripts/smoke-test.js   (solo GET)
4. retain backup ............. conservar el backup pre-map validado (no borrar)
5. close map deployment ...... registrar PASS + conteos; fin del despliegue del mapa
```

El verificador de producción es **estrictamente READ-ONLY** (barrera SELECT-only), usa
**exclusivamente** `FARM_OS_PRODUCTION_MAP_VERIFY_DATABASE_URL` (nunca `DATABASE_URL`,
`FARM_OS_PRODUCTION_IMPORT_DATABASE_URL` ni `FARM_OS_TEST_DATABASE_URL`), y compara producción
contra el dataset normalizado (conteos + geometrías/aliases/jerarquía canónicos, C39–C42
ausentes, review=0). Si algo difiere: `RESULT: FAIL` y exit ≠ 0, sin modificar nada.

## POST-DEPLOY (solo diseño en esta fase — NO ejecutar aún)

Tras aplicar `002` (fase futura), volver a correr el preflight y comparar `before` vs `after`:

- Las **8 tablas históricas** deben mantener **exactamente** los mismos `COUNT(*)`.
- Las **5 tablas nuevas** pasan a existir (vacías hasta la importación del mapa).
- `schema_migrations` incluye `001` y `002`.

La comparación se hará contra `reports/production-preflight-snapshot.json` (before) y un
snapshot nuevo (after). Cualquier diferencia en los conteos históricos = **alto y revisión**.
