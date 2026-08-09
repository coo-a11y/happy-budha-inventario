// El problema: cuando parseo "07-26", obtengo mes=7
// Pero en JavaScript, los meses son 0-indexed (enero=0, julio=6)
// Así que new Date(2026, 7, 0) retorna el último día de AGOSTO, no julio

// La solución es restar 1 al mes cuando se usa en Date
// Cambiar: return new Date(año, mes, 0);
// Por: return new Date(año, mes - 1, 1); // Primer día del mes (o usar mes - 1 para último día del mes anterior)

const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf-8');

const old = `    function parsearFecha(fechaStr) {
      if (!fechaStr) return null;
      const mesesAbrev = {
        'ene': 1, 'feb': 2, 'mar': 3, 'abr': 4, 'may': 5, 'jun': 6,
        'jul': 7, 'ago': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dic': 12
      };
      const partes = fechaStr.toLowerCase().split('-');
      if (partes.length === 2) {
        let mes = parseInt(partes[0]);
        if (isNaN(mes)) mes = mesesAbrev[partes[0]];
        let año = parseInt(partes[1]);
        if (año < 100 && año >= 0) año += 2000;
        if (mes > 0 && mes <= 12 && año > 1900) {
          return new Date(año, mes, 0);
        }
      }
      return null;
    }`;

const newCode = `    function parsearFecha(fechaStr) {
      if (!fechaStr) return null;
      const mesesAbrev = {
        'ene': 1, 'feb': 2, 'mar': 3, 'abr': 4, 'may': 5, 'jun': 6,
        'jul': 7, 'ago': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dic': 12
      };
      const partes = fechaStr.toLowerCase().split('-');
      if (partes.length === 2) {
        let mes = parseInt(partes[0]);
        if (isNaN(mes)) mes = mesesAbrev[partes[0]];
        let año = parseInt(partes[1]);
        if (año < 100 && año >= 0) año += 2000;
        if (mes > 0 && mes <= 12 && año > 1900) {
          // Retornar el primer día del mes especificado (año y mes están en formato calendario 1-12)
          // JavaScript Date usa 0-indexed meses, así que restamos 1
          return new Date(año, mes - 1, 1);
        }
      }
      return null;
    }`;

const updated = content.replace(old, newCode);
fs.writeFileSync('server.js', updated);
console.log('✅ parsearFecha() corregido');
