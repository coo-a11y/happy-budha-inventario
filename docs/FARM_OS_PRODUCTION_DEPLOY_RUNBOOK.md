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

## POST-DEPLOY (solo diseño en esta fase — NO ejecutar aún)

Tras aplicar `002` (fase futura), volver a correr el preflight y comparar `before` vs `after`:

- Las **8 tablas históricas** deben mantener **exactamente** los mismos `COUNT(*)`.
- Las **5 tablas nuevas** pasan a existir (vacías hasta la importación del mapa).
- `schema_migrations` incluye `001` y `002`.

La comparación se hará contra `reports/production-preflight-snapshot.json` (before) y un
snapshot nuevo (after). Cualquier diferencia en los conteos históricos = **alto y revisión**.
