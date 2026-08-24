# Preview de importación del mapa maestro (KML → Farm OS)

> Generado: 2026-08-24T11:50:13.311Z. Modo **dry-run**: no se escribió nada en PostgreSQL.
> CRS: WGS84 / EPSG:4326 · orden [longitude, latitude] · source: `KML_MAP_V1`

## Totales

- Placemarks: **59** · Polígonos: **59**
- Finca: **HB-FINCA-01 — HappyBuddha**
- Zonas propuestas: **58** · Aliases propuestos: **38**
- Campos C detectados: **38** (C1..C38) · C39–C42 ausentes: **sí**

## Tipos de zona

- PRODUCTIVE_FIELD: 41
- NURSERY: 1
- POSTHARVEST_PLANT: 6
- WAREHOUSE: 4
- COMMON_AREA: 2
- WATER_INFRASTRUCTURE: 3
- OFFICE: 1

## Jerarquía propuesta (padre → hijos)

- **HB-CAMPO**: HB-CAMPO-C1-C4, HB-C5, HB-C6, HB-C7, HB-C8, HB-C9, HB-C10, HB-C11, HB-C12, HB-C13, HB-C14, HB-C15, HB-C16, HB-C17, HB-C18, HB-C19, HB-C20, HB-C21, HB-C22, HB-C23, HB-C24, HB-C25, HB-C26, HB-C27, HB-C28, HB-C29, HB-C30, HB-C31, HB-C32, HB-C33, HB-C34, HB-C35, HB-C36, HB-C37, HB-C38, HB-ZONA-EXPERIMENTAL
- **(raíz)**: HB-CAMPO, HB-INVERNADERO, HB-RESERVORIO-1, HB-CUARTO-BOMBAS, HB-RESERVORIO-2, HB-PLANTA
- **HB-PLANTA**: HB-NURSERY, HB-BODEGA-H1, HB-CUARTO-INVENTARIO, HB-CUARTO-TRABAJADORES, HB-BODEGA-BIOFERT, HB-BANOS, HB-OFICINA, HB-CUARTO-CONGELACION, HB-RECEPCION-CBD, HB-TRIMMING, HB-CUARTOS-SECADO, HB-BODEGA-BIOMASA
- **HB-CAMPO-C1-C4**: HB-C2, HB-C1, HB-C4, HB-C3

## Padres inferidos por contención geométrica

- HB-BODEGA-H1 → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-CUARTO-INVENTARIO → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-CUARTO-TRABAJADORES → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-BODEGA-BIOFERT → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-BANOS → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-OFICINA → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-CUARTO-CONGELACION → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-RECEPCION-CBD → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-TRIMMING → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-CUARTOS-SECADO → dentro de HB-PLANTA (vértices dentro: 100%)
- HB-BODEGA-BIOMASA → dentro de HB-PLANTA (vértices dentro: 100%)

## Zonas que REQUIEREN REVISIÓN

- (ninguna)

## Geometrías no soportadas (MultiPolygon/MultiGeometry)

- (ninguna — todos los Placemark son Polygon simples)

## Superposiciones entre zonas del mismo nivel (solo reporte)

Estimación por muestreo. Advertencias para revisión futura por el dibujo manual del KML; **no** son errores de importación y **no** se corrige ninguna geometría. Total: 29 · MEANINGFUL_OVERLAP: 2 · TOUCH_OR_MINOR_OVERLAP: 27.

- [TOUCH_OR_MINOR_OVERLAP] HB-C6 ↔ HB-C7 (bajo HB-CAMPO) · ≈21 m² (0.2% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C10 ↔ HB-C11 (bajo HB-CAMPO) · ≈0 m² (0.0% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C10 ↔ HB-C14 (bajo HB-CAMPO) · ≈1 m² (0.0% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C11 ↔ HB-C14 (bajo HB-CAMPO) · ≈8 m² (0.1% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C13 ↔ HB-C14 (bajo HB-CAMPO) · ≈27 m² (0.3% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C15 ↔ HB-C16 (bajo HB-CAMPO) · ≈58 m² (0.6% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C16 ↔ HB-C17 (bajo HB-CAMPO) · ≈7 m² (0.1% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C17 ↔ HB-C18 (bajo HB-CAMPO) · ≈18 m² (0.2% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C18 ↔ HB-C19 (bajo HB-CAMPO) · ≈194 m² (1.9% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C20 ↔ HB-C21 (bajo HB-CAMPO) · ≈49 m² (0.5% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C21 ↔ HB-C22 (bajo HB-CAMPO) · ≈145 m² (1.4% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C23 ↔ HB-C24 (bajo HB-CAMPO) · ≈19 m² (0.2% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C26 ↔ HB-C27 (bajo HB-CAMPO) · ≈193 m² (1.9% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C30 ↔ HB-C31 (bajo HB-CAMPO) · ≈47 m² (0.4% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C31 ↔ HB-C32 (bajo HB-CAMPO) · ≈3 m² (0.0% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-NURSERY ↔ HB-BODEGA-BIOFERT (bajo HB-PLANTA) · ≈0 m² (0.9% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-NURSERY ↔ HB-OFICINA (bajo HB-PLANTA) · ≈0 m² (0.1% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-CUARTO-INVENTARIO ↔ HB-BANOS (bajo HB-PLANTA) · ≈0 m² (0.3% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-CUARTO-TRABAJADORES ↔ HB-BODEGA-BIOFERT (bajo HB-PLANTA) · ≈0 m² (1.1% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-CUARTO-TRABAJADORES ↔ HB-RECEPCION-CBD (bajo HB-PLANTA) · ≈0 m² (0.2% de la menor)
- [MEANINGFUL_OVERLAP] HB-BODEGA-BIOFERT ↔ HB-RECEPCION-CBD (bajo HB-PLANTA) · ≈1 m² (2.6% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-RECEPCION-CBD ↔ HB-CUARTOS-SECADO (bajo HB-PLANTA) · ≈0 m² (0.2% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-TRIMMING ↔ HB-CUARTOS-SECADO (bajo HB-PLANTA) · ≈0 m² (0.0% de la menor)
- [MEANINGFUL_OVERLAP] HB-TRIMMING ↔ HB-BODEGA-BIOMASA (bajo HB-PLANTA) · ≈4 m² (2.3% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-CUARTOS-SECADO ↔ HB-BODEGA-BIOMASA (bajo HB-PLANTA) · ≈1 m² (0.4% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C2 ↔ HB-C1 (bajo HB-CAMPO-C1-C4) · ≈89 m² (0.5% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C2 ↔ HB-C3 (bajo HB-CAMPO-C1-C4) · ≈0 m² (0.0% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C1 ↔ HB-C3 (bajo HB-CAMPO-C1-C4) · ≈5 m² (0.0% de la menor)
- [TOUCH_OR_MINOR_OVERLAP] HB-C4 ↔ HB-C3 (bajo HB-CAMPO-C1-C4) · ≈5 m² (0.0% de la menor)

## Zonas contenidas dentro de otras

- HB-BODEGA-H1 dentro de HB-PLANTA
- HB-CUARTO-INVENTARIO dentro de HB-PLANTA
- HB-CUARTO-TRABAJADORES dentro de HB-PLANTA
- HB-BODEGA-BIOFERT dentro de HB-PLANTA
- HB-BANOS dentro de HB-PLANTA
- HB-OFICINA dentro de HB-PLANTA
- HB-CUARTO-CONGELACION dentro de HB-PLANTA
- HB-RECEPCION-CBD dentro de HB-PLANTA
- HB-TRIMMING dentro de HB-PLANTA
- HB-CUARTOS-SECADO dentro de HB-PLANTA
- HB-BODEGA-BIOMASA dentro de HB-PLANTA
- HB-C2 dentro de HB-CAMPO-C1-C4
- HB-C1 dentro de HB-CAMPO-C1-C4
- HB-C5 dentro de HB-CAMPO
- HB-C6 dentro de HB-CAMPO
- HB-C7 dentro de HB-CAMPO
- HB-C8 dentro de HB-CAMPO
- HB-C9 dentro de HB-CAMPO
- HB-C10 dentro de HB-CAMPO
- HB-C11 dentro de HB-CAMPO
- HB-C12 dentro de HB-CAMPO
- HB-C13 dentro de HB-CAMPO
- HB-C14 dentro de HB-CAMPO
- HB-C15 dentro de HB-CAMPO
- HB-C16 dentro de HB-CAMPO
- HB-C17 dentro de HB-CAMPO
- HB-C18 dentro de HB-CAMPO
- HB-C19 dentro de HB-CAMPO
- HB-C20 dentro de HB-CAMPO
- HB-C21 dentro de HB-CAMPO
- HB-C22 dentro de HB-CAMPO
- HB-C23 dentro de HB-CAMPO
- HB-C24 dentro de HB-CAMPO
- HB-C25 dentro de HB-CAMPO
- HB-C26 dentro de HB-CAMPO
- HB-C27 dentro de HB-CAMPO
- HB-C28 dentro de HB-CAMPO
- HB-C29 dentro de HB-CAMPO
- HB-C30 dentro de HB-CAMPO
- HB-C31 dentro de HB-CAMPO
- HB-C32 dentro de HB-CAMPO
- HB-C33 dentro de HB-CAMPO
- HB-C34 dentro de HB-CAMPO
- HB-C35 dentro de HB-CAMPO
- HB-C36 dentro de HB-CAMPO
- HB-C37 dentro de HB-CAMPO

## Warnings

- [WARN] Se detectaron 29 superposición(es) entre zonas del mismo nivel: 2 MEANINGFUL_OVERLAP y 27 TOUCH_OR_MINOR_OVERLAP. Son advertencias para revisión futura (dibujo manual del KML), NO errores de importación. No se corrige ninguna geometría.

---
_No se ejecutó ninguna escritura en base de datos ni se modificó información histórica._
