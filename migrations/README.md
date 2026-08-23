# migrations/

Mecanismo de **migraciones versionadas** para HappyBuddha Farm OS.

Coexiste con el mecanismo actual de creación de esquema en el arranque (`initializeDatabase()`
en `server.js`). **No lo reemplaza todavía** — en esta fase es aditivo y seguro.

## Principios (innegociables)

- **Incrementales:** cada archivo es un paso numerado, se aplican en orden.
- **Idempotentes cuando es razonable:** usar `IF NOT EXISTS` / `ADD COLUMN` tolerante.
- **Solo aditivas (barrera activa):** el runner **bloquea** por defecto cualquier migración
  que contenga `DROP`, `TRUNCATE`, `DELETE FROM`, `UPDATE`, `ALTER TABLE ... DROP`,
  `ALTER TABLE ... RENAME`, `ALTER COLUMN` o `SET DATA TYPE`. Una migración normal solo puede
  **agregar** (CREATE TABLE IF NOT EXISTS, ADD COLUMN, CREATE INDEX IF NOT EXISTS).
- **Backfill / transformación de datos:** si en el futuro se necesita, deberá usar un
  mecanismo **separado** con autorización explícita. **No** está implementado todavía.
- **Compatibles hacia atrás:** no rompen la información ni el código actual en producción.

## Formato

Archivos `NNN_nombre.sql` (ej. `001_baseline.sql`). El número define el orden.
Se ejecutan con el runner `scripts/migrate.js`, que registra cada uno aplicado en la
tabla de control `schema_migrations`.

## Uso

```bash
# Ver qué se aplicaría, sin ejecutar nada (recomendado siempre primero)
node scripts/migrate.js --dry-run

# Aplicar migraciones pendientes (solo cuando lo autorices)
node scripts/migrate.js
```

El runner requiere `DATABASE_URL` (PostgreSQL de producción/staging). Sin esa variable,
no hace nada y lo informa (la base local usa el mecanismo del arranque).

## Regla de oro

Antes de aplicar cualquier migración importante: **generar backup** (ver
`docs/BACKUP_AND_RECOVERY.md`) y correr `scripts/database-integrity-check.js` antes y después.

## Estado actual

- `001_baseline.sql` — no-op documentado. Sólo deja constancia de que el mecanismo quedó
  instalado sobre el esquema existente. **No altera ninguna tabla ni dato.**
