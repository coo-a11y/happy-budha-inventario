# CURRENT_DATABASE_SCHEMA.md — Esquema actual de HappyBuddha Farm OS

> Documento de auditoría **read-only**. Describe la estructura **tal como existe hoy** en
> `server.js` (rama base). No inventa columnas. Generado en la fase PARTE 1 (Blindaje y Cimientos).
> Ninguna estructura ni dato fue modificado para producir este documento.

## Contexto técnico

- **Stack:** Node.js + Express, PostgreSQL (Railway) en producción, con un emulador local
  tipo-JSON (`LocalDB`) como fallback de desarrollo.
- **Selector de motor:** `const usePostgres = !!process.env.DATABASE_URL;` (`server.js:430`).
  - Si `DATABASE_URL` existe → PostgreSQL (`pg.Pool`).
  - Si no → base local de archivo (`data.json` / `inventario.db`).
- **Creación de esquema:** hoy ocurre en el arranque, dentro de `initializeDatabase()`
  (`server.js` ~línea 560–964), con `CREATE TABLE IF NOT EXISTS` + bloques `ALTER TABLE ... ADD COLUMN`
  envueltos en `try/catch` (solo PostgreSQL). Es un patrón aditivo e idempotente.
- **Helpers de acceso:** `executeQuery` / `executeModify` / `normalizeQuery` (traducen `?` ↔ `$n`).

---

## Tablas (8)

Tipos entre PostgreSQL y SQLite/local son equivalentes; se anota cuando difieren.
`PK` = clave primaria. En PostgreSQL las PK son `SERIAL`; en local, `INTEGER AUTOINCREMENT`.

### 1. `productos`  (`server.js:576` PG / `597` local)

| Columna | Tipo | Notas |
|---|---|---|
| id | SERIAL / INTEGER | **PK** |
| codigo | TEXT | **UNIQUE** |
| nombre | TEXT | nombre comercial |
| nombre_referencia | TEXT | añadido por ALTER (PG) |
| categoria | TEXT | |
| presentacion | TEXT | define la unidad base del stock |
| stock | REAL | |
| stock_minimo | REAL | |
| precio | REAL | precio por presentación |
| fecha_caducidad | TEXT | formato YYYY-MM-DD |
| bodega | TEXT | solo en CREATE de PG; en local se agrega vía uso |
| zona | TEXT | |
| proveedor | TEXT | añadido por ALTER (PG) |
| foto | TEXT | base64 / dato de imagen |
| contifico_id | TEXT | |
| tipo_producto | TEXT | |
| created_at | TIMESTAMP / DATETIME | default now |
| updated_at | TIMESTAMP / DATETIME | default now |

### 2. `lotes`  (`server.js:621` PG / `633` local)

| Columna | Tipo | Notas |
|---|---|---|
| id | SERIAL / INTEGER | **PK** |
| producto_id | INTEGER | **FK → productos(id) ON DELETE SET NULL** (NOT NULL en PG CREATE original) |
| cantidad | REAL | en unidad base |
| fecha_caducidad | DATE | |
| fecha_ingreso | DATE | |
| operario | TEXT | |
| descripcion | TEXT | |
| created_at | TIMESTAMP / DATETIME | |

### 3. `movimientos`  (`server.js:649` PG / `672` local)

| Columna | Tipo | Notas |
|---|---|---|
| id | SERIAL / INTEGER | **PK** |
| producto_id | INTEGER | **FK → productos(id) ON DELETE SET NULL** |
| tipo | TEXT | `entrada` / `salida` |
| cantidad_presentacion | REAL | |
| cantidad_salida | REAL | |
| unidad_salida | TEXT | |
| zona_origen | TEXT | |
| zona_destino | TEXT | |
| operario | TEXT | |
| costo_unitario | REAL | |
| costo_total | REAL | |
| descripcion | TEXT | |
| contifico_kardex_id | TEXT | |
| fecha_caducidad | TEXT | añadido por ALTER (PG) |
| fecha_movimiento | TEXT | añadido por ALTER (PG) |
| litros_agua | REAL | mezcla; añadido por ALTER (PG) |
| ph_agua | REAL | mezcla; añadido por ALTER (PG) |
| mezcla_id | TEXT | agrupa productos de una misma mezcla; ALTER (PG) |
| created_at | TIMESTAMP / DATETIME | |

> Nota: en el arranque se ejecuta un ajuste de FK (`server.js:698–708`, solo PG):
> `producto_id` se hace nullable y el constraint se recrea como `ON DELETE SET NULL`.
> Esto evita perder movimientos históricos cuando se elimina un producto.

### 4. `usuarios`  (`server.js:712` PG / `721` local)

| Columna | Tipo | Notas |
|---|---|---|
| id | SERIAL / INTEGER | **PK** |
| nombre | TEXT | |
| email | TEXT | **UNIQUE** |
| rol | TEXT | admin / gerente / operario |
| activo | INTEGER | default 1 |
| created_at | TIMESTAMP / DATETIME | |

### 5. `conversiones`  (`server.js:734` PG / `743` local)

| Columna | Tipo | Notas |
|---|---|---|
| id | SERIAL / INTEGER | **PK** |
| producto_id | INTEGER | **FK → productos(id) ON DELETE SET NULL** |
| unidad_presentacion | TEXT | |
| unidad_salida | TEXT | |
| factor | REAL | |

### 6. `mediciones`  (`server.js:756` PG / `768` local)

| Columna | Tipo | Notas |
|---|---|---|
| id | SERIAL / INTEGER | **PK** |
| fecha_hora | TEXT | |
| zona | TEXT | |
| linea | TEXT | añadido por ALTER (PG) |
| cantidad_plantas | INTEGER | |
| promedio | REAL | promedio auto de alturas |
| lineas | TEXT | JSON con las mediciones por planta |
| operario | TEXT | |
| created_at | TIMESTAMP / DATETIME | |

### 7. `cultivo_calendario`  (`server.js:784` PG / `794` local)

| Columna | Tipo | Notas |
|---|---|---|
| id | SERIAL / INTEGER | **PK** |
| lote | TEXT | **UNIQUE** (C1–C42) |
| fecha_inicio | TEXT | inicio de germinación |
| duraciones | TEXT | JSON con duración por etapa; ALTER (PG) |
| nota | TEXT | ALTER (PG) |
| registrado_por | TEXT | ALTER (PG) |
| updated_at | TIMESTAMP / DATETIME | |

### 8. `produccion`  (`server.js:808` PG / `829` local)

| Columna | Tipo | Notas |
|---|---|---|
| id | SERIAL / INTEGER | **PK** |
| tipo | TEXT | `germinacion` / `transplante` / `cosecha` |
| lote | TEXT | |
| fecha | TEXT | |
| personas | REAL | |
| semillas | REAL | |
| plantulas | REAL | |
| transplantadas | REAL | |
| hectareas | REAL | |
| kg_verde_biomasa | REAL | |
| kg_flor_verde | REAL | |
| kg_seco_biomasa | REAL | |
| kg_seco_flor | REAL | |
| tipo_empaque | TEXT | Saco / Big bag / Bolsa de aluminio multicapa |
| nota | TEXT | |
| registrado_por | TEXT | |
| salidas_json | TEXT | JSON de productos secos que entraron a inventario; ALTER (PG) |
| created_at | TIMESTAMP / DATETIME | |

---

## Relaciones (FK)

Todas las claves foráneas apuntan a `productos(id)` con `ON DELETE SET NULL`:

- `lotes.producto_id` → `productos.id`
- `movimientos.producto_id` → `productos.id`
- `conversiones.producto_id` → `productos.id`

`cultivo_calendario.lote`, `produccion.lote` y `movimientos.zona_*` referencian lotes/zonas
**por texto** (C1–C42), sin FK formal.

## Índices

- PK implícita en cada tabla (`id`).
- `UNIQUE` en `productos.codigo`, `usuarios.email`, `cultivo_calendario.lote`.
- No hay índices secundarios explícitos definidos en el código.

## Lugares donde el código crea/altera esquema

- `initializeDatabase()` — `server.js` ~560–964: todos los `CREATE TABLE IF NOT EXISTS`.
- Bloque `ALTER TABLE ... ADD COLUMN` (solo PG) — `server.js:855–909`: agrega columnas nuevas
  de forma aditiva e idempotente (try/catch por si ya existen).
- Ajuste de FK de `movimientos` — `server.js:698–708`.
- Migración inicial `data.json → productos` **solo si la tabla está vacía** — `server.js:913–943`.

## Endpoints que ESCRIBEN datos

| Método | Ruta | Efecto |
|---|---|---|
| POST | `/api/productos` | upsert de producto |
| POST | `/api/movimientos/entrada` | crea lote + movimiento, **suma** stock |
| POST | `/api/movimientos/salida` | crea movimiento, **descuenta** stock |
| DELETE | `/api/movimientos/:id` | borra 1 movimiento y revierte su efecto en stock |
| DELETE | `/api/productos/:id` | borra producto + sus movimientos asociados |
| POST | `/api/importar/excel` | inserta/actualiza productos desde Excel |
| GET | `/api/normalizar-fechas` | normaliza formato de fechas (update masivo controlado) |
| POST | `/api/mediciones` | inserta medición |
| DELETE | `/api/mediciones/:id` | borra 1 medición |
| POST | `/api/calendario` | upsert de registro de lote |
| POST | `/api/produccion` | inserta producción; si es cosecha con `salidas`, crea/actualiza productos y movimientos de inventario |
| DELETE | `/api/produccion/:id` | borra 1 registro de producción (solo admin) |
| POST | `/api/respaldar` | dispara respaldo a Google Sheets (no altera BD) |

### Operaciones `DELETE FROM` presentes en el código

- `DELETE FROM movimientos WHERE id = ?` (`server.js:1522`)
- `DELETE FROM movimientos WHERE producto_id = ?` (`server.js:1565`, dentro de borrar producto)
- `DELETE FROM productos WHERE id = ?` (`server.js:1584`)
- `DELETE FROM mediciones WHERE id = ?` (`server.js:1847`)
- `DELETE FROM produccion WHERE id = ?` (`server.js:2007`)

**No existe** ningún `DROP TABLE`, `TRUNCATE`, ni borrado masivo no acotado en el código.
Todos los `DELETE` están acotados por `id` o por `producto_id` de un borrado explícito del usuario.

## Dependencias entre módulos

- **Inventario ← Cosecha:** `POST /api/produccion` (tipo `cosecha`) crea/actualiza `productos`
  (por lote+subtipo) y registra `movimientos` de entrada. Es el único punto donde Producción
  escribe en Inventario.
- **Stock ↔ movimientos ↔ lotes:** el stock se mantiene sumando entradas y restando salidas;
  la tabla `lotes` guarda el detalle por ingreso. El stock **no** se recalcula desde `lotes`
  (decisión de diseño para no perder ajustes por Excel/edición manual).
- **Calendario:** independiente; se relaciona con lotes por texto (C1–C42).
- **Mediciones:** independiente; se relaciona con zonas/lotes por texto.
