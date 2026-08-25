-- farm-os-schema-checks.sql — Validación READ-ONLY del esquema de 002 en PostgreSQL real.
-- Solo SELECT sobre catálogos del sistema. No modifica nada.
--   psql "$FARM_OS_TEST_DATABASE_URL" -f scripts/sql/farm-os-schema-checks.sql

\echo '=== Tablas nuevas presentes (esperadas 5) ==='
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN
  ('farm_sites','geo_zones','geo_zone_aliases','workers','worker_devices')
ORDER BY table_name;

\echo ''
\echo '=== Tipos de columnas fecha/hora: deben ser timestamptz ==='
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('farm_sites','geo_zones','geo_zone_aliases','workers','worker_devices')
  AND (column_name LIKE '%_at')
ORDER BY table_name, column_name;

\echo ''
\echo '=== farm_sites.boundary_geojson y geo_zones.polygon_geojson: jsonb ==='
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND ((table_name='farm_sites' AND column_name='boundary_geojson')
    OR (table_name='geo_zones' AND column_name='polygon_geojson'));

\echo ''
\echo '=== geo_zones: name y zone_type NOT NULL ==='
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_schema='public' AND table_name='geo_zones' AND column_name IN ('name','zone_type');

\echo ''
\echo '=== Constraints de geo_zones (UNIQUE, FK compuesta, CHECKs) ==='
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.geo_zones'::regclass
ORDER BY contype, conname;

\echo ''
\echo '=== FKs nuevas: NINGUNA debe usar ON DELETE CASCADE ==='
SELECT conrelid::regclass AS tabla, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype='f'
  AND conrelid::regclass::text IN ('geo_zones','geo_zone_aliases','worker_devices')
ORDER BY tabla, conname;

\echo ''
\echo '=== Índices esperados (unique alias, unique parcial employee_code, device_uuid) ==='
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public'
  AND (indexname IN ('uq_geo_zone_aliases_zone_alias_ctx','uq_workers_employee_code')
    OR indexdef ILIKE '%device_uuid%')
ORDER BY indexname;
