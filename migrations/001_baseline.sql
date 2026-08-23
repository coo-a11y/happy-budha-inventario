-- 001_baseline.sql
-- Migración BASELINE (línea base) de HappyBuddha Farm OS.
--
-- Propósito: dejar constancia de que el mecanismo de migraciones versionadas quedó
-- instalado SOBRE el esquema ya existente en producción.
--
-- Esta migración es INTENCIONALMENTE un no-op estructural: NO crea, altera, renombra
-- ni borra ninguna tabla o dato existente. El esquema actual (productos, lotes,
-- movimientos, usuarios, conversiones, mediciones, cultivo_calendario, produccion)
-- sigue siendo gestionado por initializeDatabase() en server.js durante esta fase.
--
-- A partir de la migración 002 en adelante, los cambios de esquema deberán escribirse
-- aquí como pasos aditivos y no destructivos (CREATE TABLE IF NOT EXISTS,
-- ADD COLUMN, CREATE INDEX IF NOT EXISTS), nunca DROP/TRUNCATE.

SELECT 1;
