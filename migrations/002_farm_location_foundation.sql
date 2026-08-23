-- 002_farm_location_foundation.sql
-- HappyBuddha Farm OS — PARTE 2A: Modelo maestro de finca, zonas y trabajadores.
--
-- 100% ADITIVA. Solo crea tablas e índices NUEVOS. No toca ninguna tabla ni dato
-- existente (productos, lotes, movimientos, usuarios, conversiones, mediciones,
-- cultivo_calendario, produccion). Sin DROP / TRUNCATE / DELETE / UPDATE / ALTER.
--
-- Debe pasar la barrera aditiva de scripts/migrate.js.
-- NO ejecutar contra producción sin autorización explícita.
--
-- GeoJSON: polygon_geojson usa JSONB (sin PostGIS todavía). Coordenadas esperadas en
-- WGS84 / EPSG:4326, orden [longitude, latitude].

-- ------------------------------------------------------------------
-- 1. Finca / sede (permite múltiples fincas en el futuro)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm_sites (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------
-- 2. Zonas físicas (jerárquicas). zone_type es TEXT (sin ENUM rígido).
--    parent_zone_id permite jerarquía (auto-referencia).
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_zones (
  id              SERIAL PRIMARY KEY,
  farm_site_id    INTEGER NOT NULL REFERENCES farm_sites(id),
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  zone_type       TEXT NOT NULL,
  parent_zone_id  INTEGER,
  polygon_geojson JSONB,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Códigos únicos por finca
  CONSTRAINT geo_zones_site_code_uniq UNIQUE (farm_site_id, code),
  -- Clave única compuesta que sirve de destino a la FK compuesta de jerarquía
  CONSTRAINT geo_zones_id_site_uniq UNIQUE (id, farm_site_id),
  -- Jerarquía dentro de la MISMA finca: la zona padre debe pertenecer al mismo
  -- farm_site que la hija. Con MATCH SIMPLE (por defecto), si parent_zone_id es NULL
  -- (zona raíz) la FK no se evalúa; si tiene valor, exige que exista una zona con
  -- ese id Y el mismo farm_site_id. Así se garantiza en el esquema (sin triggers).
  CONSTRAINT geo_zones_parent_same_site_fk
    FOREIGN KEY (parent_zone_id, farm_site_id)
    REFERENCES geo_zones (id, farm_site_id),
  -- GeoJSON opcional; si tiene contenido, debe ser un objeto JSONB cuyo 'type' sea
  -- Polygon o MultiPolygon. No se validan aún las coordenadas (WGS84/EPSG:4326,
  -- [longitude, latitude]) ni se usa PostGIS.
  CONSTRAINT geo_zones_geojson_type_chk CHECK (
    polygon_geojson IS NULL OR (
      jsonb_typeof(polygon_geojson) = 'object'
      AND polygon_geojson->>'type' IN ('Polygon', 'MultiPolygon')
    )
  )
);

-- ------------------------------------------------------------------
-- 3. Alias de zonas: relaciona textos históricos (C1..C42) con una zona,
--    SIN modificar los textos originales en las tablas existentes.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_zone_aliases (
  id             SERIAL PRIMARY KEY,
  geo_zone_id    INTEGER NOT NULL REFERENCES geo_zones(id),
  alias          TEXT NOT NULL,
  source_context TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------
-- 4. Trabajadores (independiente de usuarios; sin datos sensibles todavía)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workers (
  id            SERIAL PRIMARY KEY,
  employee_code TEXT,
  full_name     TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------
-- 5. Dispositivos de trabajadores. device_uuid UNIQUE. Sin IMEI ni
--    identificadores invasivos del teléfono.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_devices (
  id            SERIAL PRIMARY KEY,
  worker_id     INTEGER NOT NULL REFERENCES workers(id),
  device_uuid   TEXT NOT NULL UNIQUE,
  platform      TEXT,
  device_model  TEXT,
  app_version   TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMP,
  last_seen_at  TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------
-- 6. Índices razonables (sin sobreindexar)
-- ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_geo_zones_farm_site   ON geo_zones (farm_site_id);
CREATE INDEX IF NOT EXISTS idx_geo_zones_parent       ON geo_zones (parent_zone_id);
CREATE INDEX IF NOT EXISTS idx_geo_zones_zone_type    ON geo_zones (zone_type);
CREATE INDEX IF NOT EXISTS idx_geo_zone_aliases_alias ON geo_zone_aliases (alias);
CREATE INDEX IF NOT EXISTS idx_geo_zone_aliases_zone  ON geo_zone_aliases (geo_zone_id);
CREATE INDEX IF NOT EXISTS idx_workers_active         ON workers (active);
CREATE INDEX IF NOT EXISTS idx_worker_devices_worker  ON worker_devices (worker_id);

-- Índice ÚNICO PARCIAL: impide employee_code duplicado solo cuando tiene valor
-- (los NULL no compiten entre sí).
CREATE UNIQUE INDEX IF NOT EXISTS uq_workers_employee_code
  ON workers (employee_code) WHERE employee_code IS NOT NULL;
