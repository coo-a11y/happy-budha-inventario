const fs = require('fs');

// Leer data.json
const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));

const mesesAbrev = {
  'ene': '01', 'feb': '02', 'mar': '03', 'abr': '04', 'may': '05', 'jun': '06',
  'jul': '07', 'ago': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dic': '12'
};

let convertidos = 0;
let yaFormato = 0;

data.productos.rows.forEach(p => {
  const fecha = p.fecha_caducidad || '';
  
  // Si ya está en formato MM-YY, déjalo
  if (fecha.match(/^\d{2}-\d{2}$/)) {
    yaFormato++;
    return;
  }
  
  // Si está en formato mes-YY (ago-27), convierte a MM-YY (08-27)
  if (fecha.match(/^[a-z]{3}-\d{2}$/i)) {
    const [mes, year] = fecha.toLowerCase().split('-');
    const mesNum = mesesAbrev[mes];
    if (mesNum) {
      p.fecha_caducidad = `${mesNum}-${year}`;
      convertidos++;
    }
    return;
  }
  
  // Si está en formato YYYY-MM-DD, convierte a MM-YY (2026-07-05 → 07-26)
  if (fecha.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = fecha.split('-');
    p.fecha_caducidad = `${month}-${year.slice(-2)}`;
    convertidos++;
    return;
  }
  
  // Si está en otro formato numérico como 10-2027, déjalo
  if (fecha.match(/^\d{2}-\d{4}$/)) {
    const [month, year] = fecha.split('-');
    p.fecha_caducidad = `${month}-${year.slice(-2)}`;
    convertidos++;
  }
});

// Guardar
fs.writeFileSync('data.json', JSON.stringify(data, null, 2));

console.log(`✅ Conversión completada:`);
console.log(`   - Convertidos: ${convertidos}`);
console.log(`   - Ya en formato MM-YY: ${yaFormato}`);
console.log(`   - Total: ${data.productos.rows.length}`);
