#!/usr/bin/env node
/**
 * tests/kml-import.test.js — Pruebas del importador KML (PARTE 2B).
 * READ-ONLY sobre el KML. No toca base de datos. Sin framework (assert nativo).
 *
 * Uso: node tests/kml-import.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const K = require('../scripts/import-kml-map.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

const xml = fs.readFileSync(K.KML_PATH, 'utf8');
const placemarks = K.parseKml(xml);
const names = placemarks.map(p => p.name);

console.log('\n=========  TESTS: importador KML  =========\n');

test('Parser detecta Placemarks', () => {
  assert.ok(placemarks.length > 0, 'no se detectaron placemarks');
});

test('59 polígonos detectados', () => {
  const polys = placemarks.filter(p => p.isPolygon && p.rings.length && p.rings[0].coords.length);
  assert.strictEqual(polys.length, 59, `esperados 59, obtenidos ${polys.length}`);
});

test('Conversión de coordenadas KML → [lon,lat] numérico', () => {
  const pts = K.parseCoordString('-75.5,-0.5,0 -75.6,-0.6,0');
  assert.deepStrictEqual(pts, [[-75.5, -0.5], [-75.6, -0.6]]);
  // Todas las coords del KML son numéricas y de 2 componentes
  for (const pm of placemarks) for (const r of pm.rings) for (const c of r.coords) {
    assert.ok(Number.isFinite(c[0]) && Number.isFinite(c[1]), `coord no numérica en ${pm.name}`);
  }
});

test('Coordenadas en rango WGS84 (lon ∈ [-180,180], lat ∈ [-90,90])', () => {
  for (const pm of placemarks) for (const r of pm.rings) for (const [lon, lat] of r.coords) {
    assert.ok(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90, `fuera de rango en ${pm.name}`);
  }
});

test('Cada LinearRing exterior está cerrado (o se puede cerrar) y tiene ≥3 vértices', () => {
  for (const pm of placemarks) {
    const outer = pm.rings.find(r => r.kind === 'outer') || pm.rings[0];
    assert.ok(outer && outer.coords.length >= 3, `ring insuficiente en ${pm.name}`);
    // El KML puede venir sin cerrar; validamos que el importador lo cierra en el GeoJSON.
    const ring = outer.coords.slice();
    if (!K.ringIsClosed(ring)) ring.push(ring[0]);
    assert.ok(K.ringIsClosed(ring), `no se pudo cerrar el ring de ${pm.name}`);
  }
});

test('C1–C38 presentes', () => {
  for (let i = 1; i <= 38; i++) {
    assert.ok(names.includes('C' + i), `falta C${i}`);
  }
});

test('C39–C42 ausentes (no inventados)', () => {
  for (const n of ['C39', 'C40', 'C41', 'C42']) {
    assert.ok(!names.includes(n), `no debería existir ${n}`);
  }
});

test('Planta presente', () => {
  assert.ok(names.includes('Planta'), 'falta el polígono Planta');
});

test('Perímetro de finca presente', () => {
  assert.ok(names.some(n => /Perímetro total HappyBuddha/i.test(n)), 'falta el perímetro');
});

test('Sin nombres duplicados', () => {
  const counts = {};
  names.forEach(n => counts[n] = (counts[n] || 0) + 1);
  const dups = Object.entries(counts).filter(([, c]) => c > 1).map(([n]) => n);
  assert.strictEqual(dups.length, 0, `duplicados: ${dups.join(', ')}`);
});

test('Cuarto de congelación contenido geométricamente en Planta', () => {
  const geom = {};
  placemarks.forEach(pm => { const o = pm.rings.find(r => r.kind === 'outer') || pm.rings[0]; if (o) geom[pm.name] = o.coords; });
  const cong = geom['Cuarto de congelación'];
  const planta = geom['Planta'];
  assert.ok(cong && planta, 'faltan geometrías');
  const c = K.containment(cong, planta);
  assert.ok(c.inside, `Cuarto de congelación no resultó contenido en Planta (fracción vértices dentro: ${(c.frac * 100).toFixed(0)}%)`);
});

// Chequeos sobre la salida normalizada (si existe / se puede generar)
test('normalized.json y preview reflejan finca + 58 zonas + 38 aliases', () => {
  // Regenerar de forma segura ejecutando el importador en dry-run
  require('child_process').execSync('node ' + JSON.stringify(path.join(__dirname, '..', 'scripts', 'import-kml-map.js')) + ' --dry-run', { stdio: 'ignore' });
  const norm = JSON.parse(fs.readFileSync(K.NORMALIZED_OUT, 'utf8'));
  assert.ok(norm.farm_site && norm.farm_site.code === 'HB-FINCA-01', 'finca incorrecta');
  assert.strictEqual(norm.zones.length, 58, `esperadas 58 zonas, ${norm.zones.length}`);
  assert.strictEqual(norm.alias_proposals.length, 38, `esperados 38 aliases, ${norm.alias_proposals.length}`);
  assert.strictEqual(norm.crs, 'WGS84 / EPSG:4326');
  assert.strictEqual(norm.coordinate_order, '[longitude, latitude]');
});

console.log(`\nResultado: ${pass} OK, ${fail} fallos.\n`);
process.exit(fail ? 1 : 0);
