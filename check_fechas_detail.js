const fs = require('fs');
const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));

const con_fecha = data.productos.rows.filter(p => p.fecha_caducidad);
const sin_fecha = data.productos.rows.filter(p => !p.fecha_caducidad);

console.log(`Total productos: ${data.productos.rows.length}`);
console.log(`Con fecha: ${con_fecha.length}`);
console.log(`Sin fecha: ${sin_fecha.length}`);

console.log('\n🔍 Primeros 10 productos con fecha:');
con_fecha.slice(0, 10).forEach((p, i) => {
  console.log(`  ${i+1}. ${p.nombre}: "${p.fecha_caducidad}"`);
});
