# FARM_OS_LOCATION_MODEL_V1.md — Modelo de ubicación física (PARTE 2A)

Cimientos de **ubicación física** para HappyBuddha Farm OS. Es **solo el modelo de datos base**.
Todo es **aditivo**: no toca ninguna tabla ni dato existente. En esta fase **no** hay GPS,
tracking, geofencing, app Android, endpoints ni interfaz.

## 1. Jerarquía física

```
HappyBuddha (farm_sites)
 └── Zona (geo_zones, jerárquica por parent_zone_id)
      ├── Campo
      │    └── C3 (parcela / lote productivo)
      ├── Planta (postcosecha)
      │    └── Área de secado
      ├── Vivero (nursery)
      ├── Bodegas (warehouse)
      └── Infraestructura (agua, taller, oficina, vías, etc.)
```

Una `geo_zones` puede contener otras `geo_zones` mediante `parent_zone_id`, así que la
jerarquía puede tener la profundidad que se necesite.

## 2. Propósito de cada tabla

- **`farm_sites`** — la finca/sede. Permite que HappyBuddha tenga **más de una finca** en el
  futuro. Campos: `id, code, name, description?, active, created_at, updated_at`.
- **`geo_zones`** — cualquier área física (campo, parcela, vivero, planta, área de secado,
  bodega, infraestructura…). Jerárquica (`parent_zone_id`). Guarda su polígono en
  `polygon_geojson` (JSONB). `zone_type` es **TEXT** (sin ENUM rígido) para conservar
  flexibilidad. `UNIQUE(farm_site_id, code)` evita códigos duplicados dentro de una misma finca.
  Reglas de integridad en el esquema:
  - `name` y `zone_type` son **NOT NULL** (toda zona tiene nombre y tipo).
  - **Jerarquía en la misma finca:** la zona padre debe pertenecer al mismo `farm_site` que la
    hija. Se garantiza con una **FK compuesta** `(parent_zone_id, farm_site_id) → (id,
    farm_site_id)` apoyada en la única compuesta `UNIQUE(id, farm_site_id)`. Con `MATCH SIMPLE`
    (por defecto), una zona raíz (`parent_zone_id IS NULL`) no evalúa la FK; una zona con padre
    exige que el padre exista **con el mismo farm_site_id**. Sin triggers, PostgreSQL estándar.
  - **CHECK de GeoJSON:** `polygon_geojson` es nullable (una zona puede no estar mapeada aún);
    si tiene contenido debe ser un objeto JSONB con `type` = `Polygon` o `MultiPolygon`. No se
    validan coordenadas todavía ni se usa PostGIS.
- **`geo_zone_aliases`** — puentes entre los **textos históricos** (C1..C42, etc.) y una zona,
  **sin** modificar esos textos en las tablas actuales. Campos: `id, geo_zone_id, alias,
  source_context?, active, created_at`.
- **`workers`** — trabajadores, **independiente** de `usuarios` (que representa cuentas del
  sistema y cuya autenticación aún debe endurecerse). Sin salario ni costo/hora todavía.
- **`worker_devices`** — dispositivos de cada trabajador. `device_uuid` es **UNIQUE**. Un
  trabajador puede tener varios dispositivos históricamente. **No** se guarda IMEI ni
  identificadores invasivos del teléfono.

### Valores documentados de `zone_type` (TEXT, no ENUM)

`PRODUCTIVE_FIELD`, `NURSERY`, `POSTHARVEST_PLANT`, `WAREHOUSE`, `WATER_INFRASTRUCTURE`,
`WORKSHOP_MAINTENANCE`, `OFFICE`, `COMMON_AREA`, `INTERNAL_ROAD`,
`CONSTRUCTION_INFRASTRUCTURE`, `NON_OPERATIONAL`, `OTHER`.

Se mantienen como texto acordado por convención; se pueden ampliar sin migración de tipo.

## 3. Ejemplos conceptuales

- Finca: `farm_sites(code='HB', name='HappyBuddha')`.
- Zona campo: `geo_zones(code='CAMPO', zone_type='PRODUCTIVE_FIELD', parent=NULL)`.
- Parcela C3: `geo_zones(code='C3', zone_type='PRODUCTIVE_FIELD', parent=CAMPO)`.
- Área de secado: `geo_zones(code='SECADO-1', zone_type='POSTHARVEST_PLANT', parent=PLANTA)`.
- Alias histórico: `geo_zone_aliases(geo_zone_id=<C3>, alias='C3', source_context='produccion')`.

> **Nada de esto se inserta todavía.** Son ejemplos de cómo se usará el modelo.

## 4. Coexistencia con C1–C42 (datos históricos)

Hoy el sistema usa textos como `C1`, `C2`, `C3` en `cultivo_calendario.lote`,
`produccion.lote`, `movimientos.zona_origen`, `movimientos.zona_destino` y `mediciones.zona`.

Esos registros **no se modifican**. La relación se hará **por fuera**, vía `geo_zone_aliases`:
un alias `'C3'` apuntará a `geo_zones.id = X`. Así, más adelante, una consulta podrá resolver
`C3 → zona`, mientras el texto histórico permanece intacto. `source_context` (ej. `produccion`,
`calendario`, `movimientos`, `mediciones`, `general`) permite distinguir de qué módulo proviene
el alias si el mismo texto significara cosas distintas.

## 5. Por qué no se modifican datos históricos

La información actual es un activo real de HappyBuddha. El principio del proyecto es
**proteger → extender → relacionar → automatizar**, nunca *borrar → reconstruir*. Por eso el
enlace zona↔texto se resuelve con una tabla puente (`geo_zone_aliases`) y no reescribiendo
`lote`/`zona` en las tablas existentes. Esto evita cualquier riesgo de pérdida o corrupción y
mantiene la compatibilidad total con el sistema en producción.

## 6. Cómo se conectará después al GPS

Este modelo es la **base de ubicación**. En fases posteriores (no ahora) se añadirán, como
tablas nuevas y aditivas, piezas como sesiones de trabajo, puntos GPS y eventos de geocerca.
El flujo previsto: un `worker_device` emitirá posiciones; cada posición se comparará contra los
`polygon_geojson` de `geo_zones` para inferir **en qué zona física** estuvo la persona. Por eso
las zonas guardan polígonos GeoJSON desde ya. La evaluación de **PostGIS** se hará cuando exista
el mapa real y se conozcan las necesidades de consulta espacial; por ahora `JSONB` es suficiente
y no añade dependencias.

### GeoJSON / coordenadas

- Formato: **GeoJSON** estándar en `polygon_geojson JSONB`.
- Sistema de referencia: **WGS84 / EPSG:4326**.
- Orden de coordenadas: **[longitude, latitude]** (convención GeoJSON).

## 7. Zona física ≠ labor realizada

La zona representa **solo ubicación/contexto físico**, no el trabajo hecho. Un trabajador en la
parcela C3 podría estar **cultivando** o **reparando una tubería**. El modelo, deliberadamente,
no infiere la labor a partir de la zona.

## 8. Los trabajadores no declararán su labor en la futura app

El diseño asume que, cuando exista la app, los trabajadores **no** tendrán que indicar qué labor
hicieron. La ubicación se capturará de forma pasiva (vía dispositivo/GPS) y la interpretación de
la labor, si alguna vez se necesita, se resolverá con otras fuentes/reglas — nunca pidiéndole al
trabajador que clasifique su trabajo. Este documento deja constancia de esa decisión de producto.

## Fuera de alcance en esta fase (no creado)

`work_sessions`, `gps_points`, `attendance`, `labor_catalog`, `productivity`,
`work_assignments`, `geofence_events`, `location_events`, app Android, endpoints API, interfaz web.
