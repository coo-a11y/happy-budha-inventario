#!/usr/bin/env node
/**
 * scripts/import-kml-map.js — Importador SEGURO del mapa maestro KML (PARTE 2B).
 *
 * FLUJO: KML → leer → validar → normalizar → clasificar → PREVIEW.
 *
 * PROTECCIÓN ABSOLUTA:
 *  - Solo funciona en modo --dry-run. NO abre conexión a PostgreSQL. NO ejecuta INSERT.
 *  - No modifica el KML ni ningún dato histórico. Solo LEE el KML y ESCRIBE archivos de
 *    salida (normalized.json + reportes) en el propio repo.
 *  - Sin dependencias externas: parser XML/KML y geometría implementados aquí (ligeros),
 *    para no añadir frameworks geoespaciales ni depender del registro npm.
 *
 * Uso:
 *   node scripts/import-kml-map.js --dry-run
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KML_PATH = path.join(ROOT, 'data', 'maps', 'happybudha-farm-map.kml');
const MAPPING_PATH = path.join(ROOT, 'config', 'map-zone-mapping.json');
const NORMALIZED_OUT = path.join(ROOT, 'data', 'maps', 'happybudha-farm-map.normalized.json');
const REPORT_JSON = path.join(ROOT, 'reports', 'map-import-preview.json');
const REPORT_MD = path.join(ROOT, 'reports', 'map-import-preview.md');
const SOURCE_TAG = 'KML_MAP_V1';

// ------------------------------------------------------------------ Utilidades
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

// Extrae Placemarks del KML con su <name> y el primer bloque <coordinates> del <Polygon>.
function parseKml(xml) {
  const placemarks = [];
  const re = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const nameM = body.match(/<name>([\s\S]*?)<\/name>/);
    const name = nameM ? decodeEntities(nameM[1]).trim() : '(sin nombre)';
    const isPolygon = /<Polygon\b/.test(body);

    // Detección de geometría NO soportada: MultiGeometry / gx:MultiGeometry, o más de un
    // <Polygon> en el mismo Placemark (MultiPolygon de facto). No se interpretan parcialmente.
    const polyCount = (body.match(/<Polygon\b/g) || []).length;
    const hasMultiGeometry = /<(gx:)?MultiGeometry\b/i.test(body);
    const unsupported = hasMultiGeometry || polyCount > 1;
    const geometry_kind = unsupported ? 'MULTIPOLYGON_OR_MULTIGEOMETRY'
      : (isPolygon ? 'POLYGON' : 'NON_POLYGON');

    // Un Polygon puede tener outerBoundaryIs + innerBoundaryIs (huecos). Tomamos todos los rings.
    const rings = [];
    const outer = body.match(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/outerBoundaryIs>/);
    if (outer) rings.push({ kind: 'outer', coords: parseCoordString(outer[1]) });
    const innerRe = /<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/innerBoundaryIs>/g;
    let im;
    while ((im = innerRe.exec(body)) !== null) rings.push({ kind: 'inner', coords: parseCoordString(im[1]) });
    // Fallback: si no hubo outerBoundaryIs pero sí un <coordinates> suelto dentro de Polygon.
    if (rings.length === 0) {
      const c = body.match(/<Polygon\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/);
      if (c) rings.push({ kind: 'outer', coords: parseCoordString(c[1]) });
    }
    placemarks.push({ name, isPolygon, rings, unsupported, geometry_kind });
  }
  return placemarks;
}

// "lon,lat,alt lon,lat,alt ..." → [[lon,lat], ...]  (conserva WGS84/EPSG:4326, [lon,lat])
function parseCoordString(s) {
  return s.trim().split(/\s+/).filter(Boolean).map(tok => {
    const parts = tok.split(',').map(Number);
    return [parts[0], parts[1]]; // ignora altitud
  }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

function ringIsClosed(ring) {
  if (ring.length < 2) return false;
  const a = ring[0], b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

// Área planar aproximada en m² usando proyección equirectangular local (suficiente para
// tolerancias y comparaciones relativas; NO PostGIS). ring en [lon,lat].
function ringAreaM2(ring) {
  if (ring.length < 4) return 0;
  const R = 6378137; // radio terrestre (m)
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const cos0 = Math.cos(lat0 * Math.PI / 180);
  const xy = ring.map(([lon, lat]) => [R * (lon * Math.PI / 180) * cos0, R * (lat * Math.PI / 180)]);
  let a = 0;
  for (let i = 0; i < xy.length - 1; i++) a += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
  return Math.abs(a) / 2;
}

function centroid(ring) {
  // centroide simple (promedio de vértices únicos); suficiente para contención aproximada
  const pts = ring.slice(0, ring.length - (ringIsClosed(ring) ? 1 : 0));
  const n = pts.length || 1;
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}

function bbox(ring) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ring) { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; }
  return { minx, miny, maxx, maxy };
}
function bboxOverlap(a, b) { return !(a.maxx < b.minx || b.maxx < a.minx || a.maxy < b.miny || b.maxy < a.miny); }

// Punto en polígono (ray casting). ring en [lon,lat].
function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-15) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ¿ring A está (mayormente) contenido en ring B? Usa centroide + fracción de vértices dentro.
function containment(ringA, ringB) {
  if (!bboxOverlap(bbox(ringA), bbox(ringB))) return { inside: false, frac: 0 };
  const verts = ringA.slice(0, ringA.length - (ringIsClosed(ringA) ? 1 : 0));
  let inCount = 0;
  for (const v of verts) if (pointInRing(v, ringB)) inCount++;
  const frac = verts.length ? inCount / verts.length : 0;
  const cIn = pointInRing(centroid(ringA), ringB);
  return { inside: cIn && frac >= 0.6, frac };
}

// Solape aproximado entre dos polígonos (mismo nivel): algún vértice de uno dentro del otro.
function polygonsOverlap(ringA, ringB) {
  if (!bboxOverlap(bbox(ringA), bbox(ringB))) return false;
  for (const v of ringA) if (pointInRing(v, ringB)) return true;
  for (const v of ringB) if (pointInRing(v, ringA)) return true;
  return false;
}

// Área de intersección aproximada (m²) por muestreo de una grilla sobre el bbox común.
// Sin librerías: cuenta puntos que caen dentro de AMBOS polígonos. Es una ESTIMACIÓN,
// suficiente para distinguir un roce/borde de un solape con área real.
function approxIntersectionAreaM2(ringA, ringB, grid = 120) {
  const ba = bbox(ringA), bb = bbox(ringB);
  if (!bboxOverlap(ba, bb)) return 0;
  const minx = Math.max(ba.minx, bb.minx), maxx = Math.min(ba.maxx, bb.maxx);
  const miny = Math.max(ba.miny, bb.miny), maxy = Math.min(ba.maxy, bb.maxy);
  if (maxx <= minx || maxy <= miny) return 0;
  // Área del rectángulo de intersección en m² (equirectangular local)
  const rectM2 = ringAreaM2([[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]);
  let inBoth = 0, total = 0;
  for (let i = 0; i < grid; i++) {
    const x = minx + (i + 0.5) * (maxx - minx) / grid;
    for (let j = 0; j < grid; j++) {
      const y = miny + (j + 0.5) * (maxy - miny) / grid;
      total++;
      if (pointInRing([x, y], ringA) && pointInRing([x, y], ringB)) inBoth++;
    }
  }
  return total ? rectM2 * (inBoth / total) : 0;
}

function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ------------------------------------------------------------------ Principal
function main() {
  if (!process.argv.includes('--dry-run')) {
    console.log('⛔ Esta herramienta SOLO corre en modo preview. Ejecuta:');
    console.log('   node scripts/import-kml-map.js --dry-run');
    console.log('   (No se conecta a PostgreSQL ni inserta nada.)');
    process.exit(1);
  }

  const xml = fs.readFileSync(KML_PATH, 'utf8');
  const mapping = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
  const placemarks = parseKml(xml);

  const warnings = [];
  const requiereRevision = [];
  const w = (level, msg, zone) => warnings.push({ level, zone: zone || null, msg });

  // Nombres duplicados
  const nameCounts = {};
  placemarks.forEach(p => { nameCounts[p.name] = (nameCounts[p.name] || 0) + 1; });
  Object.entries(nameCounts).filter(([, c]) => c > 1).forEach(([n, c]) => w('ERROR', `Nombre duplicado en KML: "${n}" (${c} veces)`, n));

  const farmSiteCfg = mapping.farm_site;
  const zonesCfg = mapping.zones || {};

  // Separar farm_site del resto y construir zonas normalizadas
  let farmSite = null;
  const zones = [];       // zonas geo normalizadas (sin la finca)
  const geomByCode = {};  // code → outer ring (para contención/solape)
  const geomByName = {};

  for (const pm of placemarks) {
    const outer = (pm.rings.find(r => r.kind === 'outer') || pm.rings[0]);
    const ring = outer ? outer.coords : [];
    geomByName[pm.name] = ring;

    // Geometría NO soportada (MultiPolygon/MultiGeometry): se marca como ERROR y NO se
    // interpreta parcialmente. La zona queda sin polígono y para revisión.
    if (pm.unsupported) {
      w('ERROR', `UNSUPPORTED_GEOMETRY en "${pm.name}": ${pm.geometry_kind}. No se interpreta parcialmente.`, pm.name);
      const cfgU = zonesCfg[pm.name];
      zones.push({
        source_name: pm.name,
        proposed_code: cfgU ? cfgU.code : 'HB-' + slug(pm.name),
        proposed_name: pm.name,
        proposed_zone_type: cfgU ? cfgU.zone_type : 'OTHER',
        proposed_parent_code: (cfgU && cfgU.parent_code) || null,
        _parent_explicit: !!(cfgU && cfgU.parent_code),
        polygon_geojson: null,
        geometry_kind: pm.geometry_kind,
        source: SOURCE_TAG,
        review: true,
        review_reason: 'UNSUPPORTED_GEOMETRY: MultiPolygon/MultiGeometry no soportado; requiere manejo manual.',
      });
      continue;
    }

    // Validaciones geométricas por placemark
    if (!pm.isPolygon) w('ERROR', `Placemark sin Polygon: "${pm.name}"`, pm.name);
    if (ring.length === 0) w('ERROR', `Geometría vacía: "${pm.name}"`, pm.name);
    else {
      if (!ringIsClosed(ring)) w('ERROR', `Anillo NO cerrado: "${pm.name}" (primer vértice ≠ último)`, pm.name);
      const distinct = ring.length - (ringIsClosed(ring) ? 1 : 0);
      if (distinct < 3) w('ERROR', `Menos de 3 vértices distintos: "${pm.name}"`, pm.name);
    }

    // GeoJSON Polygon (rings: outer + inner). Cerramos si hace falta para el GeoJSON.
    const geojsonRings = pm.rings.map(r => {
      const rr = r.coords.slice();
      if (rr.length && !ringIsClosed(rr)) rr.push(rr[0]);
      return rr;
    });
    const polygon_geojson = geojsonRings.length
      ? { type: 'Polygon', coordinates: geojsonRings }
      : null;

    // ¿Es la finca?
    if (farmSiteCfg && pm.name === farmSiteCfg.source_name) {
      farmSite = {
        source_name: pm.name,
        code: farmSiteCfg.code,
        name: farmSiteCfg.name,
        polygon_geojson,
        source: SOURCE_TAG,
      };
      geomByCode[farmSiteCfg.code] = ring;
      continue;
    }

    // Clasificación desde config; si no está, OTHER + REQUIERE_REVISION
    const cfg = zonesCfg[pm.name];
    let proposed_code, zone_type, parent_code, review = false, review_reason = null;
    if (cfg) {
      proposed_code = cfg.code;
      zone_type = cfg.zone_type;
      parent_code = cfg.parent_code || null;
      review = !!cfg.review;
      review_reason = cfg.review_reason || null;
    } else {
      proposed_code = 'HB-' + slug(pm.name);
      zone_type = 'OTHER';
      parent_code = null;
      review = true;
      review_reason = 'Nombre no reconocido por las reglas de clasificación; clasificar manualmente.';
    }

    zones.push({
      source_name: pm.name,
      proposed_code,
      proposed_name: pm.name,
      proposed_zone_type: zone_type,
      proposed_parent_code: parent_code,       // puede completarse por contención abajo
      _parent_explicit: parent_code !== null,
      polygon_geojson,
      source: SOURCE_TAG,
      review,
      review_reason,
    });
    geomByCode[proposed_code] = ring;
  }

  // Inferencia de padre por contención geométrica (solo si no hay padre explícito).
  const containerCode = mapping.infer_parent_by_containment_into; // p.ej. HB-PLANTA
  const containerRing = containerCode ? geomByCode[containerCode] : null;
  const containmentReport = [];
  if (containerRing) {
    for (const z of zones) {
      if (z.proposed_code === containerCode) continue;
      const ring = geomByCode[z.proposed_code];
      if (!ring || ring.length === 0) continue;
      const c = containment(ring, containerRing);
      if (c.inside) {
        containmentReport.push({ zone: z.proposed_code, contained_in: containerCode, vertex_fraction: +c.frac.toFixed(2) });
        if (!z._parent_explicit) z.proposed_parent_code = containerCode;
      }
    }
  }

  // Validación: zonas dentro / fuera del perímetro de finca
  const perimeterRing = farmSite ? geomByCode[farmSite.code] : null;
  if (perimeterRing) {
    for (const z of zones) {
      const ring = geomByCode[z.proposed_code];
      if (!ring || ring.length === 0) continue;
      const c = containment(ring, perimeterRing);
      if (c.frac === 0) w('WARN', `Zona fuera del perímetro de finca: ${z.proposed_code} (${z.source_name})`, z.proposed_code);
      else if (c.frac < 1) w('INFO', `Zona parcialmente fuera del perímetro: ${z.proposed_code} (vértices dentro ${(c.frac * 100).toFixed(0)}%)`, z.proposed_code);
    }
  } else {
    w('WARN', 'No se encontró el polígono de perímetro de finca en el KML.');
  }

  // Zonas pequeñas sospechosas (área < 3 m²) — tolerancia razonable
  for (const z of zones) {
    const ring = geomByCode[z.proposed_code];
    const area = ring ? ringAreaM2(ring) : 0;
    z._area_m2 = Math.round(area);
    if (area > 0 && area < 3) w('WARN', `Zona muy pequeña (${area.toFixed(1)} m²), revisar: ${z.proposed_code}`, z.proposed_code);
  }

  // Superposiciones entre zonas del MISMO nivel (mismo parent). Solo se reportan.
  // Se clasifica cada solape por SEVERIDAD usando un área de intersección aproximada:
  //  - TOUCH_OR_MINOR_OVERLAP: intersección < 2% del área de la zona más pequeña (probable
  //    borde compartido o pequeño desajuste del dibujo manual).
  //  - MEANINGFUL_OVERLAP: intersección >= 2% (área real solapada que merece revisión).
  // NOTA: es una ESTIMACIÓN por muestreo; no corrige ni recorta geometrías.
  const OVERLAP_MINOR_RATIO = 0.02;
  const overlaps = [];
  const byParent = {};
  zones.forEach(z => { const k = z.proposed_parent_code || '__ROOT__'; (byParent[k] = byParent[k] || []).push(z); });
  for (const [parent, list] of Object.entries(byParent)) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const ra = geomByCode[a.proposed_code], rb = geomByCode[b.proposed_code];
      if (ra && rb && polygonsOverlap(ra, rb)) {
        const interM2 = approxIntersectionAreaM2(ra, rb);
        const minArea = Math.max(1, Math.min(ringAreaM2(ra), ringAreaM2(rb)));
        const ratio = interM2 / minArea;
        const severity = ratio >= OVERLAP_MINOR_RATIO ? 'MEANINGFUL_OVERLAP' : 'TOUCH_OR_MINOR_OVERLAP';
        overlaps.push({
          level_parent: parent === '__ROOT__' ? null : parent,
          a: a.proposed_code, b: b.proposed_code,
          severity,
          approx_intersection_m2: Math.round(interM2),
          ratio_of_smaller: +ratio.toFixed(3),
        });
      }
    }
  }
  const nMeaningful = overlaps.filter(o => o.severity === 'MEANINGFUL_OVERLAP').length;
  const nMinor = overlaps.length - nMeaningful;
  if (overlaps.length) w('WARN', `Se detectaron ${overlaps.length} superposición(es) entre zonas del mismo nivel: ${nMeaningful} MEANINGFUL_OVERLAP y ${nMinor} TOUCH_OR_MINOR_OVERLAP. Son advertencias para revisión futura (dibujo manual del KML), NO errores de importación. No se corrige ninguna geometría.`);

  // Zonas contenidas dentro de otras (informativo, cualquier par)
  const containedIn = [];
  for (const a of zones) {
    for (const b of zones) {
      if (a === b) continue;
      const ra = geomByCode[a.proposed_code], rb = geomByCode[b.proposed_code];
      if (!ra || !rb) continue;
      if (ringAreaM2(ra) <= ringAreaM2(rb) && containment(ra, rb).inside) {
        containedIn.push({ inner: a.proposed_code, outer: b.proposed_code });
      }
    }
  }

  // Recolectar REQUIERE_REVISION
  zones.filter(z => z.review).forEach(z => requiereRevision.push({ zone: z.proposed_code, source_name: z.source_name, reason: z.review_reason }));

  // Aliases C1–C38 (propuesta, NO se inserta)
  const aliases = [];
  for (let i = 1; i <= 38; i++) {
    const src = 'C' + i;
    const z = zones.find(zz => zz.source_name === src);
    if (z) aliases.push({ alias: src, proposed_geo_zone_code: z.proposed_code, source_context: 'general' });
  }

  // Limpiar campos internos antes de escribir
  const zonesOut = zones.map(z => ({
    source_name: z.source_name,
    proposed_code: z.proposed_code,
    proposed_name: z.proposed_name,
    proposed_zone_type: z.proposed_zone_type,
    proposed_parent_code: z.proposed_parent_code,
    polygon_geojson: z.polygon_geojson,
    geometry_kind: z.geometry_kind || 'POLYGON',
    source: z.source,
    review: z.review,
    review_reason: z.review_reason,
    approx_area_m2: z._area_m2,
  }));

  const cFields = zones.filter(z => /^C\d+$/.test(z.source_name)).map(z => z.source_name);
  const cNums = cFields.map(n => +n.slice(1)).sort((a, b) => a - b);

  const normalized = {
    source: SOURCE_TAG,
    generated_at: new Date().toISOString(),
    crs: 'WGS84 / EPSG:4326',
    coordinate_order: '[longitude, latitude]',
    note: 'Propuesta de importación. NO se ha escrito nada en PostgreSQL. IDs de BD se asignarán al importar en una fase futura autorizada.',
    farm_site: farmSite,
    zones: zonesOut,
    alias_proposals: aliases,
  };

  const preview = {
    generated_at: normalized.generated_at,
    kml_file: path.relative(ROOT, KML_PATH),
    totals: {
      placemarks: placemarks.length,
      polygons: placemarks.filter(p => p.isPolygon).length,
      farm_site: farmSite ? 1 : 0,
      zones: zonesOut.length,
      alias_proposals: aliases.length,
      c_fields_detected: cNums.length,
      c_fields_range: cNums.length ? `C${cNums[0]}..C${cNums[cNums.length - 1]}` : null,
    },
    c39_c42_absent: [39, 40, 41, 42].every(n => !cNums.includes(n)),
    unsupported_geometry: zonesOut.filter(z => z.geometry_kind && z.geometry_kind !== 'POLYGON').map(z => ({ zone: z.proposed_code, kind: z.geometry_kind })),
    zone_types_summary: zonesOut.reduce((acc, z) => { acc[z.proposed_zone_type] = (acc[z.proposed_zone_type] || 0) + 1; return acc; }, {}),
    hierarchy_parents: zonesOut.reduce((acc, z) => { const k = z.proposed_parent_code || '(raíz)'; (acc[k] = acc[k] || []).push(z.proposed_code); return acc; }, {}),
    containment_inferred_parents: containmentReport,
    zones_contained_in_others: containedIn,
    overlaps_same_level: overlaps,
    overlaps_summary: {
      total: overlaps.length,
      MEANINGFUL_OVERLAP: overlaps.filter(o => o.severity === 'MEANINGFUL_OVERLAP').length,
      TOUCH_OR_MINOR_OVERLAP: overlaps.filter(o => o.severity === 'TOUCH_OR_MINOR_OVERLAP').length,
      nota: 'Estimación por muestreo. Advertencias para revisión futura (dibujo manual del KML), no errores de importación. No se corrige ninguna geometría.',
    },
    requiere_revision: requiereRevision,
    warnings,
  };

  fs.mkdirSync(path.dirname(NORMALIZED_OUT), { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
  fs.writeFileSync(NORMALIZED_OUT, JSON.stringify(normalized, null, 2));
  fs.writeFileSync(REPORT_JSON, JSON.stringify(preview, null, 2));
  fs.writeFileSync(REPORT_MD, buildMd(preview, normalized));

  // Resumen en consola
  console.log('\n=========  KML IMPORT — PREVIEW (dry-run, sin escrituras en BD)  =========\n');
  console.log(`Placemarks: ${preview.totals.placemarks} | Polígonos: ${preview.totals.polygons} | Zonas: ${preview.totals.zones} | Aliases: ${preview.totals.alias_proposals}`);
  console.log(`Finca: ${farmSite ? farmSite.code + ' (' + farmSite.name + ')' : 'NO DETECTADA'}`);
  console.log(`Campos C detectados: ${preview.totals.c_fields_detected} (${preview.totals.c_fields_range}) | C39–C42 ausentes: ${preview.c39_c42_absent ? 'sí ✅' : 'NO ❌'}`);
  console.log(`Tipos:`, preview.zone_types_summary);
  console.log(`REQUIERE_REVISION: ${requiereRevision.length} | Superposiciones: ${overlaps.length} (MEANINGFUL: ${preview.overlaps_summary.MEANINGFUL_OVERLAP}, MINOR: ${preview.overlaps_summary.TOUCH_OR_MINOR_OVERLAP}) | Contenciones: ${containedIn.length}`);
  console.log(`Geometrías no soportadas (MultiPolygon): ${preview.unsupported_geometry.length}`);
  console.log(`Warnings: ${warnings.length} (ERROR: ${warnings.filter(x => x.level === 'ERROR').length})`);
  console.log(`\nArchivos generados:\n  - ${path.relative(ROOT, NORMALIZED_OUT)}\n  - ${path.relative(ROOT, REPORT_JSON)}\n  - ${path.relative(ROOT, REPORT_MD)}`);
  console.log('\n(No se abrió conexión a PostgreSQL. No se insertó nada.)\n');
}

function buildMd(preview, normalized) {
  const t = preview.totals;
  let md = `# Preview de importación del mapa maestro (KML → Farm OS)\n\n`;
  md += `> Generado: ${preview.generated_at}. Modo **dry-run**: no se escribió nada en PostgreSQL.\n`;
  md += `> CRS: ${normalized.crs} · orden ${normalized.coordinate_order} · source: \`${normalized.source}\`\n\n`;
  md += `## Totales\n\n`;
  md += `- Placemarks: **${t.placemarks}** · Polígonos: **${t.polygons}**\n`;
  md += `- Finca: **${normalized.farm_site ? normalized.farm_site.code + ' — ' + normalized.farm_site.name : 'NO DETECTADA'}**\n`;
  md += `- Zonas propuestas: **${t.zones}** · Aliases propuestos: **${t.alias_proposals}**\n`;
  md += `- Campos C detectados: **${t.c_fields_detected}** (${t.c_fields_range}) · C39–C42 ausentes: **${preview.c39_c42_absent ? 'sí' : 'NO'}**\n\n`;
  md += `## Tipos de zona\n\n`;
  Object.entries(preview.zone_types_summary).forEach(([k, v]) => md += `- ${k}: ${v}\n`);
  md += `\n## Jerarquía propuesta (padre → hijos)\n\n`;
  Object.entries(preview.hierarchy_parents).forEach(([p, kids]) => md += `- **${p}**: ${kids.join(', ')}\n`);
  md += `\n## Padres inferidos por contención geométrica\n\n`;
  if (!preview.containment_inferred_parents.length) md += `- (ninguno)\n`;
  else preview.containment_inferred_parents.forEach(c => md += `- ${c.zone} → dentro de ${c.contained_in} (vértices dentro: ${(c.vertex_fraction * 100).toFixed(0)}%)\n`);
  md += `\n## Zonas que REQUIEREN REVISIÓN\n\n`;
  if (!preview.requiere_revision.length) md += `- (ninguna)\n`;
  else preview.requiere_revision.forEach(r => md += `- **${r.zone}** (${r.source_name}): ${r.reason || 'revisar'}\n`);
  md += `\n## Geometrías no soportadas (MultiPolygon/MultiGeometry)\n\n`;
  if (!preview.unsupported_geometry.length) md += `- (ninguna — todos los Placemark son Polygon simples)\n`;
  else preview.unsupported_geometry.forEach(u => md += `- **${u.zone}**: ${u.kind} → UNSUPPORTED_GEOMETRY (no interpretado)\n`);
  md += `\n## Superposiciones entre zonas del mismo nivel (solo reporte)\n\n`;
  md += `Estimación por muestreo. Advertencias para revisión futura por el dibujo manual del KML; **no** son errores de importación y **no** se corrige ninguna geometría. `;
  md += `Total: ${preview.overlaps_summary.total} · MEANINGFUL_OVERLAP: ${preview.overlaps_summary.MEANINGFUL_OVERLAP} · TOUCH_OR_MINOR_OVERLAP: ${preview.overlaps_summary.TOUCH_OR_MINOR_OVERLAP}.\n\n`;
  if (!preview.overlaps_same_level.length) md += `- (ninguna)\n`;
  else preview.overlaps_same_level.forEach(o => md += `- [${o.severity}] ${o.a} ↔ ${o.b}${o.level_parent ? ' (bajo ' + o.level_parent + ')' : ' (nivel raíz)'} · ≈${o.approx_intersection_m2} m² (${(o.ratio_of_smaller * 100).toFixed(1)}% de la menor)\n`);
  md += `\n## Zonas contenidas dentro de otras\n\n`;
  if (!preview.zones_contained_in_others.length) md += `- (ninguna)\n`;
  else preview.zones_contained_in_others.forEach(c => md += `- ${c.inner} dentro de ${c.outer}\n`);
  md += `\n## Warnings\n\n`;
  if (!preview.warnings.length) md += `- (ninguno)\n`;
  else preview.warnings.forEach(x => md += `- [${x.level}] ${x.msg}\n`);
  md += `\n---\n_No se ejecutó ninguna escritura en base de datos ni se modificó información histórica._\n`;
  return md;
}

if (require.main === module) main();

module.exports = {
  parseKml, parseCoordString, ringIsClosed, ringAreaM2, centroid,
  pointInRing, containment, polygonsOverlap, slug,
  KML_PATH, MAPPING_PATH, NORMALIZED_OUT, REPORT_JSON,
};
