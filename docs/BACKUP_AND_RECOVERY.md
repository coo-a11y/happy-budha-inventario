# BACKUP_AND_RECOVERY.md — Respaldo y recuperación (PostgreSQL / Railway)

Procedimiento seguro para respaldar la base **antes de cualquier migración importante** y
para recuperar si algo sale mal. HappyBuddha Farm OS usa PostgreSQL en Railway.

> **Regla:** durante la fase de blindaje, **nunca** restaurar sobre producción. La
> restauración y validación se hacen siempre en una **base separada**.

## 0. Nunca pongas credenciales en el repo

`DATABASE_URL` (usuario, contraseña, host) **no** debe escribirse en ningún archivo del
repositorio. Se toma de una variable de entorno temporal en tu terminal:

```bash
# macOS / Linux — pégala solo en tu shell, no la guardes en un archivo del repo
export DATABASE_URL='postgresql://USUARIO:PASSWORD@HOST:PUERTO/BASE'
```

Puedes copiar el valor real desde **Railway → tu servicio Postgres → Variables →
`DATABASE_URL`** (o el botón "Connect"). Ciérrala/olvídala al terminar.

## 1. Generar un backup

Requiere las herramientas de cliente de PostgreSQL (`pg_dump`). En macOS:
`brew install libpq` (o `postgresql@16`) y añade `pg_dump` al PATH.

```bash
# Dump completo, comprimido, con marca de tiempo
STAMP=$(date +%Y%m%d_%H%M%S)
pg_dump "$DATABASE_URL" -Fc -f "backup_happybudha_$STAMP.dump"
```

- `-Fc` = formato *custom* (comprimido, restaurable con `pg_restore`).
- Guarda el archivo **fuera del repo** (por ejemplo en `~/backups-happybudha/`).

Alternativa en texto plano (más grande, legible):

```bash
pg_dump "$DATABASE_URL" -f "backup_happybudha_$STAMP.sql"
```

## 2. Comprobar que el backup existe y tiene contenido

```bash
ls -lh backup_happybudha_*.dump          # debe pesar > 0 bytes
pg_restore --list backup_happybudha_$STAMP.dump | head -40   # lista objetos incluidos
```

Si `--list` muestra las tablas (`productos`, `movimientos`, `produccion`, …), el backup es válido.

## 3. Restaurar en una base SEPARADA (nunca en producción)

Crea una base vacía distinta (local o un segundo servicio Railway de staging):

```bash
# Ejemplo local
createdb happybudha_restore_test
pg_restore --no-owner --dbname="postgresql://localhost/happybudha_restore_test" \
  backup_happybudha_$STAMP.dump
```

Con Railway staging, usa el `DATABASE_URL` de **esa** base, no el de producción.

## 4. Validar que el backup contiene información

Contra la base restaurada (separada):

```bash
DATABASE_URL='postgresql://localhost/happybudha_restore_test' \
  node scripts/database-integrity-check.js
```

Compara los conteos por tabla con los de producción (corre el mismo script apuntando a
producción **en modo lectura**). Deben coincidir con el momento del backup.

## 5. Volver atrás si una migración falla

El runner `scripts/migrate.js` aplica cada migración dentro de una transacción
(`BEGIN/COMMIT`) y hace `ROLLBACK` automático si esa migración falla — así una migración
rota no queda a medias.

Si el problema se detecta **después** (datos afectados por una migración ya confirmada):

1. **Detén** despliegues nuevos.
2. Restaura el último backup en una **base separada** (paso 3) y valida (paso 4).
3. Compara y decide con calma. Solo tras verificar, y con tu autorización explícita, se
   promueve la base restaurada. **No** se sobrescribe producción de forma automática.

## 6. Flujo recomendado alrededor de cada migración

```
integrity-check (antes)  →  backup  →  verificar backup  →  migrate --dry-run
   →  migrate  →  integrity-check (después)  →  comparar
```

Si cualquier paso genera dudas: **detente** y revisa antes de continuar.

## Notas

- La base local de desarrollo (`data.json` / `inventario.db`) no necesita `pg_dump`;
  basta con copiar esos archivos. Pero **no** son la fuente de verdad de producción.
- Railway también ofrece backups/snapshots gestionados en su panel; úsalos como capa extra,
  no como reemplazo de un `pg_dump` verificable que tú controlas.
