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
          // Retornar el primer día del mes especificado (año y mes están en formato calendario 1-12)
          // JavaScript Date usa 0-indexed meses, así que restamos 1
          return new Date(año, mes - 1, 1);
        }
      }
      return null;
    }`;

const newCode = `    function parsearFecha(fechaStr) {
      if (!fechaStr) return null;
      
      // Formato YYYY-MM-DD (ejemplo: 2026-09-01)
      if (fechaStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = fechaStr.split('-');
        const fecha = new Date(parseInt(year), parseInt(month) - 1, 1);
        return isNaN(fecha.getTime()) ? null : fecha;
      }
      
      // Formato MM-YY o MM-YYYY (ejemplo: 09-26 o 09-2026)
      if (fechaStr.match(/^\d{2}-\d{2,4}$/)) {
        const [month, year] = fechaStr.split('-');
        let fullYear = parseInt(year);
        if (fullYear < 100) fullYear += 2000;
        const fecha = new Date(fullYear, parseInt(month) - 1, 1);
        return isNaN(fecha.getTime()) ? null : fecha;
      }
      
      // Formato mes-YY (ejemplo: ago-27, may-25)
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
          const fecha = new Date(año, mes - 1, 1);
          return isNaN(fecha.getTime()) ? null : fecha;
        }
      }
      return null;
    }`;

const updated = content.replace(old, newCode);
fs.writeFileSync('server.js', updated);
console.log('✅ parsearFecha() actualizado para manejar YYYY-MM-DD');
