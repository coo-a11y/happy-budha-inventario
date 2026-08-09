const fs = require('fs');
const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));

console.log('📊 Análisis de formatos de fecha en data.json:\n');

const formatos = {};
data.productos.rows.forEach((p, idx) => {
  const fecha = p.fecha_caducidad;
  if (fecha) {
    const formato = fecha.match(/^\d{1,2}-\d{2,4}$/) ? 'MM-YY/MM-YYYY' :
                   fecha.match(/^\d{4}-\d{2}-\d{2}$/) ? 'YYYY-MM-DD' :
                   fecha.match(/^[a-z]{3}-\d{2}$/i) ? 'mes-YY (ej: ago-27)' :
                   'OTRO';
    formatos[formato] = (formatos[formato] || 0) + 1;
    if (idx < 5) console.log(`Producto ${idx+1}: "${fecha}" → ${formato}`);
  }
});

console.log('\n📈 Resumen:');
Object.entries(formatos).forEach(([fmt, count]) => console.log(`  ${fmt}: ${count}`));
