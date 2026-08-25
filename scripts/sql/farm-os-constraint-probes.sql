-- farm-os-constraint-probes.sql
-- Prueba física de los constraints de 002 en la DB TEMPORAL de prueba.
-- Todo ocurre dentro de UNA transacción que termina en ROLLBACK: no deja datos.
-- Requisito: el mapa ya importado (1 finca / 58 zonas / 38 aliases).
--
-- Ejecutar SOLO contra hb_farm_os_test_20260825:
--   psql "$FARM_OS_TEST_DATABASE_URL" -v ON_ERROR_STOP=0 -f scripts/sql/farm-os-constraint-probes.sql
--
-- Cada bloque marcado "debe fallar" TIENE que imprimir un ERROR de PostgreSQL.
-- Los bloques "debe permitir" NO deben dar error.

\set ON_ERROR_ROLLBACK on
\echo '################  PROBES DE CONSTRAINTS (todo se revierte)  ################'
BEGIN;

\echo ''
\echo '=== 1. farm_sites.boundary_geojson type=Point -> DEBE FALLAR (CHECK) ==='
INSERT INTO farm_sites(code,name,boundary_geojson)
VALUES('TMP-CHK','tmp','{"type":"Point","coordinates":[0,0]}'::jsonb);

\echo ''
\echo '=== 2. geo_zones.polygon_geojson type=Point -> DEBE FALLAR (CHECK) ==='
INSERT INTO geo_zones(farm_site_id,code,name,zone_type,polygon_geojson)
VALUES((SELECT id FROM farm_sites WHERE code='HB-FINCA-01'),'TMP-Z','tmp','OTHER',
       '{"type":"Point","coordinates":[0,0]}'::jsonb);

\echo ''
\echo '=== 3. zona padre de si misma -> DEBE FALLAR (CHECK no_self_parent) ==='
INSERT INTO geo_zones(farm_site_id,code,name,zone_type,polygon_geojson)
VALUES((SELECT id FROM farm_sites WHERE code='HB-FINCA-01'),'TMP-SELF','tmp','OTHER',
       '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[0,0]]]}'::jsonb);
UPDATE geo_zones SET parent_zone_id = id WHERE code='TMP-SELF';   -- <- debe fallar

\echo ''
\echo '=== 4. parent de OTRA finca -> DEBE FALLAR (FK compuesta misma finca) ==='
INSERT INTO farm_sites(code,name) VALUES('TMP-FARM2','f2');
INSERT INTO geo_zones(farm_site_id,code,name,zone_type,polygon_geojson)
VALUES((SELECT id FROM farm_sites WHERE code='TMP-FARM2'),'TZ2','z2','OTHER',
       '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[0,0]]]}'::jsonb);
INSERT INTO geo_zones(farm_site_id,code,name,zone_type,parent_zone_id,polygon_geojson)
VALUES((SELECT id FROM farm_sites WHERE code='HB-FINCA-01'),'TZ-XFARM','x','OTHER',
       (SELECT id FROM geo_zones WHERE code='TZ2'),
       '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[0,0]]]}'::jsonb);  -- <- debe fallar

\echo ''
\echo '=== 5. alias EXACTAMENTE duplicado (C1/HB-C1/general ya existe) -> DEBE FALLAR ==='
INSERT INTO geo_zone_aliases(geo_zone_id,alias,source_context)
VALUES((SELECT id FROM geo_zones WHERE code='HB-C1'),'C1','general');   -- <- debe fallar

\echo ''
\echo '=== 6. employee_code no-null duplicado -> DEBE FALLAR (unique parcial) ==='
INSERT INTO workers(employee_code,full_name) VALUES('E100','A');
INSERT INTO workers(employee_code,full_name) VALUES('E100','B');        -- <- debe fallar

\echo ''
\echo '=== 7. device_uuid duplicado -> DEBE FALLAR (UNIQUE) ==='
INSERT INTO workers(full_name) VALUES('DEV-W');
INSERT INTO worker_devices(worker_id,device_uuid)
VALUES((SELECT id FROM workers WHERE full_name='DEV-W' ORDER BY id DESC LIMIT 1),'UUID-DUP');
INSERT INTO worker_devices(worker_id,device_uuid)
VALUES((SELECT id FROM workers WHERE full_name='DEV-W' ORDER BY id DESC LIMIT 1),'UUID-DUP');  -- <- debe fallar

\echo ''
\echo '=== 8. multiples employee_code NULL -> DEBE PERMITIR (sin error) ==='
INSERT INTO workers(full_name) VALUES('N1');   -- employee_code NULL
INSERT INTO workers(full_name) VALUES('N2');   -- employee_code NULL  (ok)

\echo ''
\echo '=== Conteos DENTRO de la tx (antes del rollback; algunos temporales existen aqui) ==='
SELECT
  (SELECT count(*) FROM farm_sites WHERE code='HB-FINCA-01') AS finca_hb,
  (SELECT count(*) FROM geo_zones z JOIN farm_sites f ON f.id=z.farm_site_id WHERE f.code='HB-FINCA-01') AS zonas_hb;

ROLLBACK;
\echo ''
\echo '################  ESTADO REAL TRAS ROLLBACK (debe ser 1/58/38/0/0)  ################'
SELECT count(*) AS farm_sites     FROM farm_sites;
SELECT count(*) AS geo_zones      FROM geo_zones;
SELECT count(*) AS geo_zone_aliases FROM geo_zone_aliases;
SELECT count(*) AS workers        FROM workers;
SELECT count(*) AS worker_devices FROM worker_devices;
