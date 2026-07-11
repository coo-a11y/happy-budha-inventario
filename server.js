require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Ruta raíz - IMPORTANTE para servir index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// ============ WRAPPER DE BD EN MEMORIA + JSON ============
// LocalDB: almacena datos en memoria durante sesión y persiste en data.json
class LocalDB {
  constructor(dataFile = './data.json') {
    this.dataFile = dataFile;
    this.data = {};
    this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const content = fs.readFileSync(this.dataFile, 'utf8');
        this.data = JSON.parse(content);
      } else {
        this.data = {};
      }
    } catch (err) {
      console.log('Inicializando data.json nuevo');
      this.data = {};
    }
  }

  saveData() {
    try {
      console.log('💾 Guardando data.json...');
      fs.writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2), 'utf8');
      console.log('✅ data.json guardado');
    } catch (err) {
      console.warn('⚠️ Advertencia: no se pudo guardar data.json:', err.message);
      console.warn('ℹ️ Los datos se mantienen en memoria durante esta sesión');
    }
  }

  // Parsear y ejecutar queries SQL simplificadas
  query(sql, params = []) {
    return new Promise((resolve, reject) => {
      try {
        const result = this._executeSQL(sql, params);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      try {
        const result = this._executeSQL(sql, params);
        resolve({ lastID: result.lastID, changes: result.changes });
      } catch (err) {
        reject(err);
      }
    });
  }

  _executeSQL(sql, params = []) {
    sql = sql.trim();

    // CREATE TABLE
    if (sql.toUpperCase().startsWith('CREATE TABLE')) {
      const match = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
      if (match) {
        const tableName = match[1];
        if (!this.data[tableName]) {
          this.data[tableName] = { rows: [], nextId: 1 };
          this.saveData();
        }
      }
      return { rows: [], changes: 0 };
    }

    // SELECT
    if (sql.toUpperCase().startsWith('SELECT')) {
      return this._handleSelect(sql, params);
    }

    // INSERT
    if (sql.toUpperCase().startsWith('INSERT')) {
      return this._handleInsert(sql, params);
    }

    // UPDATE
    if (sql.toUpperCase().startsWith('UPDATE')) {
      return this._handleUpdate(sql, params);
    }

    // DELETE
    if (sql.toUpperCase().startsWith('DELETE')) {
      return this._handleDelete(sql, params);
    }

    // PRAGMA (ignorar)
    if (sql.toUpperCase().startsWith('PRAGMA')) {
      return { rows: [], changes: 0 };
    }

    throw new Error(`Query no soportada: ${sql.substring(0, 50)}`);
  }

  _handleSelect(sql, params) {
    // SELECT * FROM tabla WHERE condiciones
    const countMatch = sql.match(/SELECT\s+COUNT\(\*\)\s+(?:as|AS)\s+(\w+)/i);

    if (countMatch) {
      // Manejo especial para COUNT(*)
      const alias = countMatch[1];
      const fromMatch = sql.match(/FROM\s+(\w+)/i);
      const tableName = fromMatch ? fromMatch[1] : null;

      if (!tableName || !this.data[tableName]) {
        return { rows: [{ [alias]: 0 }], rowCount: 1 };
      }

      let rows = [...this.data[tableName].rows];

      // Procesar WHERE para contar solo los que cumplan
      const whereMatch = sql.match(/WHERE\s+(.*?)(?=ORDER|LIMIT|GROUP|$)/i);
      if (whereMatch) {
        const whereClause = whereMatch[1].trim();
        rows = rows.filter(row => {
          return this._evaluateWhere(whereClause, row, params);
        });
      }

      return { rows: [{ [alias]: rows.length }], rowCount: 1 };
    }

    const fromMatch = sql.match(/FROM\s+(\w+)/i);
    const tableName = fromMatch ? fromMatch[1] : null;

    if (!tableName || !this.data[tableName]) {
      return { rows: [], rowCount: 0 };
    }

    let rows = [...this.data[tableName].rows];

    // Procesar JOINs si existen
    // Ej: "JOIN productos p ON m.producto_id = p.id"
    const joinMatch = sql.match(/JOIN\s+(\w+)\s+(?:AS\s+)?(\w+)\s+ON\s+(.*?)(?=WHERE|ORDER|LIMIT|$)/i);
    if (joinMatch) {
      const joinTable = joinMatch[1];
      const joinAlias = joinMatch[2];
      const onCondition = joinMatch[3];

      if (this.data[joinTable]) {
        // Reemplazar aliases en la condición: "m.producto_id = p.id" -> evaluación
        const mainAlias = tableName === 'movimientos' ? 'm' : (tableName === 'productos' ? 'p' : tableName);

        rows = rows.flatMap(mainRow => {
          const matchedJoinRows = this.data[joinTable].rows.filter(joinRow => {
            // Reemplazar "m.campo" con valor de mainRow y "p.campo" con valor de joinRow
            let condition = onCondition;
            Object.keys(mainRow).forEach(key => {
              const pattern = new RegExp(`\\b${mainAlias}\\.${key}\\b`, 'g');
              condition = condition.replace(pattern, JSON.stringify(mainRow[key]));
            });
            Object.keys(joinRow).forEach(key => {
              const pattern = new RegExp(`\\b${joinAlias}\\.${key}\\b`, 'g');
              condition = condition.replace(pattern, JSON.stringify(joinRow[key]));
            });

            // Evaluar la condición resultante (ej: "1 = 5" o "5 = 5")
            try {
              return eval(condition);
            } catch {
              return false;
            }
          });

          return matchedJoinRows.map(joinRow => ({
            ...mainRow,
            ...joinRow
          }));
        });
      }
    }

    // Procesar WHERE
    const whereMatch = sql.match(/WHERE\s+(.*?)(?=ORDER|LIMIT|GROUP|$)/i);
    if (whereMatch) {
      const whereClause = whereMatch[1].trim();
      rows = rows.filter(row => {
        return this._evaluateWhere(whereClause, row, params);
      });
    }

    // Procesar ORDER BY
    const orderMatch = sql.match(/ORDER\s+BY\s+(.*?)(?=LIMIT|$)/i);
    if (orderMatch) {
      const orderClause = orderMatch[1].trim();
      rows = this._applyOrderBy(rows, orderClause);
    }

    // Procesar LIMIT
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    return { rows, rowCount: rows.length };
  }

  _handleInsert(sql, params) {
    const match = sql.match(/INSERT\s+INTO\s+(\w+)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)/i);
    if (!match) throw new Error('INSERT inválido');

    const tableName = match[1];
    const columns = match[2].split(',').map(c => c.trim());

    if (!this.data[tableName]) {
      this.data[tableName] = { rows: [], nextId: 1 };
    }

    const row = {};
    columns.forEach((col, idx) => {
      row[col] = params[idx] !== undefined ? params[idx] : null;
    });

    // Si no hay ID en las columnas, asignar uno automáticamente
    if (!columns.includes('id')) {
      row.id = this.data[tableName].nextId++;
    } else if (!row.id) {
      // Si id es NULL o undefined, asignar uno
      row.id = this.data[tableName].nextId++;
    }

    this.data[tableName].rows.push(row);
    console.log(`📝 [INSERT ${tableName}] Nueva fila agregada. Total: ${this.data[tableName].rows.length}`);
    this.saveData();

    return { lastID: row.id, changes: 1 };
  }

  _handleUpdate(sql, params) {
    const match = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.*?)\s+WHERE\s+(.*)/i);
    if (!match) throw new Error('UPDATE inválido');

    const tableName = match[1];
    const setClause = match[2];
    const whereClause = match[3];

    if (!this.data[tableName]) {
      return { changes: 0 };
    }

    let paramIndex = 0;
    const updates = {};

    // Parsear SET: "col1=?, col2=?, ..." o "col1=?, updated_at=CURRENT_TIMESTAMP"
    const setParts = setClause.split(',').map(p => p.trim());
    setParts.forEach(part => {
      const [col, value] = part.split('=').map(s => s.trim());
      if (value === '?') {
        updates[col] = params[paramIndex++];
      } else if (value.toUpperCase() === 'CURRENT_TIMESTAMP') {
        updates[col] = new Date().toISOString();
      } else {
        // Otros valores (literales, funciones)
        updates[col] = value;
      }
    });

    // Los parámetros restantes son para WHERE
    const whereParams = params.slice(paramIndex);

    let changes = 0;
    this.data[tableName].rows = this.data[tableName].rows.map(row => {
      if (this._evaluateWhere(whereClause, row, whereParams)) {
        changes++;
        return { ...row, ...updates };
      }
      return row;
    });

    this.saveData();
    return { changes };
  }

  _handleDelete(sql, params) {
    const match = sql.match(/DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.*)/i);
    if (!match) throw new Error('DELETE inválido');

    const tableName = match[1];
    const whereClause = match[2];

    if (!this.data[tableName]) {
      return { changes: 0 };
    }

    const initialLength = this.data[tableName].rows.length;
    this.data[tableName].rows = this.data[tableName].rows.filter(row => {
      return !this._evaluateWhere(whereClause, row, params);
    });

    const changes = initialLength - this.data[tableName].rows.length;
    this.saveData();
    return { changes };
  }

  _evaluateWhere(whereClause, row, params) {
    // Manejar "1=1" (siempre verdadero)
    if (whereClause === '1=1') return true;

    // Dividir por AND/OR
    const conditions = whereClause.split(/\s+AND\s+/i);
    let paramIndex = 0;

    for (const condition of conditions) {
      const result = this._evaluateSingleCondition(condition.trim(), row, params, paramIndex);
      if (!result.value) return false;
      paramIndex = result.paramIndex;
    }

    return true;
  }

  _evaluateSingleCondition(condition, row, params, paramIndex) {
    // "campo = ?" o "campo != ?" o "campo LIKE ?" o "campo > ?" etc
    const operatorMatch = condition.match(/^(\w+)\s*(=|!=|<>|>|<|>=|<=|LIKE|ILIKE|IN|NOT\s+IN|BETWEEN)\s*(.+)$/i);
    if (!operatorMatch) {
      return { value: true, paramIndex };
    }

    const field = operatorMatch[1];
    const operator = operatorMatch[2].toUpperCase();
    const valueStr = operatorMatch[3].trim();

    const fieldValue = row[field];
    let compareValue;

    if (valueStr === '?') {
      compareValue = params[paramIndex];
      paramIndex++;
    } else if (valueStr.match(/^['"].*['"]$/)) {
      compareValue = valueStr.slice(1, -1);
    } else if (valueStr === 'NULL') {
      compareValue = null;
    } else {
      compareValue = valueStr;
    }

    let result = false;

    switch (operator) {
      case '=':
        result = fieldValue == compareValue;
        break;
      case '!=':
      case '<>':
        result = fieldValue != compareValue;
        break;
      case '>':
        result = fieldValue > compareValue;
        break;
      case '<':
        result = fieldValue < compareValue;
        break;
      case '>=':
        result = fieldValue >= compareValue;
        break;
      case '<=':
        result = fieldValue <= compareValue;
        break;
      case 'LIKE':
      case 'ILIKE':
        const pattern = compareValue.replace(/%/g, '.*');
        const regex = new RegExp(`^${pattern}$`, operator === 'ILIKE' ? 'i' : '');
        result = regex.test(String(fieldValue || ''));
        break;
      case 'IS':
        result = fieldValue === null;
        break;
      case 'IS NOT':
        result = fieldValue !== null;
        break;
    }

    return { value: result, paramIndex };
  }

  _applyOrderBy(rows, orderClause) {
    const parts = orderClause.split(',').map(p => p.trim());

    return rows.sort((a, b) => {
      for (const part of parts) {
        const [field, direction] = part.split(/\s+/);
        const aVal = a[field];
        const bVal = b[field];

        if (aVal < bVal) return direction?.toUpperCase() === 'DESC' ? 1 : -1;
        if (aVal > bVal) return direction?.toUpperCase() === 'DESC' ? -1 : 1;
      }
      return 0;
    });
  }

  _evaluateCondition(condition, rowsMap, params) {
    // Evaluador genérico para condiciones
    return true;
  }

  close() {
    this.saveData();
  }
}

// ============ DETECCIÓN Y CONFIGURACIÓN DE BD ============
// Si DATABASE_URL existe -> PostgreSQL; si no -> LocalDB (en memoria + JSON)
const usePostgres = !!process.env.DATABASE_URL;
let db;
let pool; // Para PostgreSQL

if (usePostgres) {
  // Usar PostgreSQL
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
  console.log('🐘 Configurado: PostgreSQL (DATABASE_URL presente)');
} else {
  // Usar LocalDB (en memoria + persistencia JSON)
  db = new LocalDB('./data.json');
  console.log('📦 Configurado: LocalDB (en memoria + data.json)');
}

// ============ HELPER PARA EJECUTAR QUERIES ============
// Normaliza queries para PostgreSQL o LocalDB
function normalizeQuery(query) {
  if (usePostgres) {
    // Convertir ? a $1, $2, etc para PostgreSQL
    let paramIndex = 1;
    return query.replace(/\?/g, () => `$${paramIndex++}`);
  } else {
    // LocalDB usa ? para placeholders
    return query.replace(/\$\d+/g, '?');
  }
}

// Wrapper para ejecutar queries de forma uniforme
async function executeQuery(query, params = []) {
  query = normalizeQuery(query);

  if (usePostgres) {
    const result = await pool.query(query, params);
    return result;
  } else {
    return await db.query(query, params);
  }
}

// Para INSERT/UPDATE/DELETE que retornan lastID
async function executeModify(query, params = []) {
  query = normalizeQuery(query);

  if (usePostgres) {
    const result = await pool.query(query, params);
    return result;
  } else {
    return await db.run(query, params);
  }
}

// Inicializar BD
const initializeDatabase = async () => {
  try {
    if (usePostgres) {
      // Probar conexión a PostgreSQL
      const result = await pool.query('SELECT NOW()');
      console.log('✅ BD conectada:', result.rows[0]);
    } else {
      // LocalDB: simplemente verificar que está inicializado
      console.log('✅ BD LocalDB conectada: data.json');
    }

    // 1. Crear tabla productos
    if (usePostgres) {
      await pool.query(`CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        codigo TEXT UNIQUE,
        nombre TEXT,
        categoria TEXT,
        presentacion TEXT,
        stock REAL,
        stock_minimo REAL,
        precio REAL,
        fecha_caducidad TEXT,
        bodega TEXT,
        zona TEXT,
        contifico_id TEXT,
        tipo_producto TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    } else {
      await executeQuery(`CREATE TABLE IF NOT EXISTS productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE,
        nombre TEXT,
        categoria TEXT,
        presentacion TEXT,
        stock REAL,
        stock_minimo REAL,
        precio REAL,
        fecha_caducidad TEXT,
        zona TEXT,
        contifico_id TEXT,
        tipo_producto TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    }
    console.log('✅ Tabla productos lista');

    // 1B. Crear tabla lotes (para gestionar lotes por fecha de caducidad)
    if (usePostgres) {
      await pool.query(`CREATE TABLE IF NOT EXISTS lotes (
        id SERIAL PRIMARY KEY,
        producto_id INTEGER NOT NULL,
        cantidad REAL,
        fecha_caducidad DATE,
        fecha_ingreso DATE,
        operario TEXT,
        descripcion TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE SET NULL
      )`);
    } else {
      await executeQuery(`CREATE TABLE IF NOT EXISTS lotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER,
        cantidad REAL,
        fecha_caducidad DATE,
        fecha_ingreso DATE,
        operario TEXT,
        descripcion TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE SET NULL
      )`);
    }
    console.log('✅ Tabla lotes lista');

    // 2. Crear tabla movimientos
    if (usePostgres) {
      await pool.query(`CREATE TABLE IF NOT EXISTS movimientos (
        id SERIAL PRIMARY KEY,
        producto_id INTEGER,
        tipo TEXT,
        cantidad_presentacion REAL,
        cantidad_salida REAL,
        unidad_salida TEXT,
        zona_origen TEXT,
        zona_destino TEXT,
        operario TEXT,
        costo_unitario REAL,
        costo_total REAL,
        descripcion TEXT,
        contifico_kardex_id TEXT,
        fecha_caducidad TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE SET NULL
      )`);
    } else {
      await executeQuery(`CREATE TABLE IF NOT EXISTS movimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER,
        tipo TEXT,
        cantidad_presentacion REAL,
        cantidad_salida REAL,
        unidad_salida TEXT,
        zona_origen TEXT,
        zona_destino TEXT,
        operario TEXT,
        costo_unitario REAL,
        costo_total REAL,
        descripcion TEXT,
        contifico_kardex_id TEXT,
        fecha_caducidad TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE SET NULL
      )`);
    }
    console.log('✅ Tabla movimientos lista');
    
    // Corregir constraint de clave foránea si existe
    try {
      if (usePostgres) {
        // Cambiar producto_id para permitir NULL
        await pool.query(`ALTER TABLE movimientos ALTER COLUMN producto_id DROP NOT NULL`).catch(() => {});
        await pool.query(`ALTER TABLE movimientos DROP CONSTRAINT IF EXISTS movimientos_producto_id_fkey`);
        await pool.query(`ALTER TABLE movimientos ADD CONSTRAINT movimientos_producto_id_fkey FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE SET NULL`);
        console.log('✅ FK constraint actualizado para ON DELETE SET NULL');
      }
    } catch (err) {
      console.log('⚠️ FK constraint ya existe o no necesita actualizar');
    }

    // 3. Crear tabla usuarios
    if (usePostgres) {
      await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre TEXT,
        email TEXT UNIQUE,
        rol TEXT,
        activo INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    } else {
      await executeQuery(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT,
        email TEXT UNIQUE,
        rol TEXT,
        activo INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    }
    console.log('✅ Tabla usuarios lista');

    // 4. Crear tabla conversiones
    if (usePostgres) {
      await pool.query(`CREATE TABLE IF NOT EXISTS conversiones (
        id SERIAL PRIMARY KEY,
        producto_id INTEGER,
        unidad_presentacion TEXT,
        unidad_salida TEXT,
        factor REAL,
        FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE SET NULL
      )`);
    } else {
      await executeQuery(`CREATE TABLE IF NOT EXISTS conversiones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER,
        unidad_presentacion TEXT,
        unidad_salida TEXT,
        factor REAL,
        FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE SET NULL
      )`);
    }
    console.log('✅ Tabla conversiones lista');

    // Agregar columnas faltantes si es PostgreSQL
    if (usePostgres) {
      try {
        await pool.query('ALTER TABLE productos ADD COLUMN bodega TEXT');
      } catch (err) {
        // Columna ya existe, ignorar
      }
      try {
        await pool.query('ALTER TABLE movimientos ADD COLUMN fecha_caducidad TEXT');
      } catch (err) {
        // Columna ya existe, ignorar
      }
    }

    // Migrar datos de data.json a PostgreSQL si está vacía
    if (usePostgres) {
      try {
        const checkProd = await pool.query('SELECT COUNT(*) as count FROM productos');
        console.log('📊 Productos en PostgreSQL:', checkProd.rows[0].count);
        const prodCount = parseInt(checkProd.rows[0].count) || 0;
        console.log('🔍 Count:', prodCount, 'Tipo:', typeof prodCount);
        if (prodCount === 0) {
          console.log('📥 PostgreSQL vacía. Intentando migrar desde data.json...');
          const fs = require('fs');
          const path = require('path');
          const dataPath = path.join(__dirname, 'data.json');
          console.log('📂 Buscando:', dataPath);
          if (fs.existsSync(dataPath)) {
            console.log('✅ data.json encontrado');
            const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
            const productos = dataJson.productos?.rows || [];
            console.log(`📥 Cargando ${productos.length} productos...`);
            for (const p of productos) {
              await pool.query(
                'INSERT INTO productos (codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, bodega, zona) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                [p.codigo, p.nombre, p.categoria, p.presentacion, p.stock, p.stock_minimo, p.precio, p.fecha_caducidad, p.bodega, p.zona]
              );
            }
            console.log(`✅ ${productos.length} productos migrados a PostgreSQL`);
          } else {
            console.log('❌ data.json NO encontrado en:', dataPath);
          }
        }
      } catch (err) {
        console.error('❌ Error en migración:', err.message);
      }
    }

    // 5. Iniciar servidor después de todo
    console.log('⏳ Esperando migración...');
    setTimeout(() => {
      console.log('✅ Iniciando servidor...');
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔═══════════════════════════════════════════════════╗
║  Happy Budha - Sistema de Inventario v4         ║
║  🌐 http://localhost:${PORT}                        ║
║  ✅ Servidor escuchando en puerto ${PORT}           ║
╚═══════════════════════════════════════════════════╝
        `);
      }, 5000);
    }, 800);
  } catch (err) {
    console.error('❌ Error inicializando BD:', err);
    process.exit(1);
  }
};

// Inicializar base de datos
initializeDatabase();

// ============ AUTENTICACIÓN SIMPLE ============
// Por ahora usamos sesiones simples. En producción usar JWT.
let usuarioActual = {
  id: 1,
  nombre: 'Admin',
  rol: 'admin', // 'admin', 'gerente', 'operario'
  email: 'admin@happybudha.com'
};

app.post('/api/login', (req, res) => {
  const { email, password, rol } = req.body;
  // Validación simple (en producción, hashear contraseña)
  if (email && rol) {
    usuarioActual = { id: 1, nombre: email.split('@')[0], rol, email };
    res.json({ success: true, usuario: usuarioActual });
  } else {
    res.status(400).json({ error: 'Credenciales inválidas' });
  }
});

app.get('/api/usuario-actual', (req, res) => {
  res.json(usuarioActual);
});

// ============ INFORMACIÓN DE USUARIO ============
app.get('/api/usuario-actual', (req, res) => {
  res.json({
    rol: usuarioActual.rol,
    nombre: usuarioActual.nombre
  });
});

// ============ ENDPOINTS DE PRODUCTOS ============

// Listar productos con filtros
app.get('/api/productos', async (req, res) => {
  try {
    const { categoria, zona, buscar, estado } = req.query;
    let query = 'SELECT * FROM productos WHERE 1=1';
    let params = [];
    let paramCount = 1;

    if (categoria) {
      query += usePostgres ? ` AND categoria = $${paramCount}` : ' AND categoria = ?';
      params.push(categoria);
      paramCount++;
    }
    if (zona) {
      query += usePostgres ? ` AND zona = $${paramCount}` : ' AND zona = ?';
      params.push(zona);
      paramCount++;
    }
    if (buscar) {
      if (usePostgres) {
        query += ` AND (nombre ILIKE $${paramCount} OR codigo ILIKE $${paramCount + 1})`;
      } else {
        query += ` AND (nombre LIKE ? OR codigo LIKE ?)`;
      }
      params.push(`%${buscar}%`, `%${buscar}%`);
      paramCount += 2;
    }
    if (estado === 'caducado') {
      if (usePostgres) {
        query += ` AND fecha_caducidad != '' AND fecha_caducidad::date < CURRENT_DATE`;
      } else {
        query += ` AND fecha_caducidad != '' AND date(fecha_caducidad) < date('now')`;
      }
    } else if (estado === 'proximo-caducar') {
      if (usePostgres) {
        query += ` AND fecha_caducidad != '' AND fecha_caducidad::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days'`;
      } else {
        query += ` AND fecha_caducidad != '' AND date(fecha_caducidad) BETWEEN date('now') AND date('now', '+60 days')`;
      }
    } else if (estado === 'bajo-stock') {
      query += ' AND stock <= stock_minimo';
    }

    query += ' ORDER BY nombre ASC';

    const result = await executeQuery(query, params);
    let rows = result.rows;

    // Si el usuario es operario, ocultar precios
    if (usuarioActual.rol === 'operario') {
      rows = rows.map(r => ({ ...r, precio: null, costo_total: null }));
    }
    res.json(rows);
  } catch (err) {
    console.error('Error en GET /api/productos:', err);
    res.status(500).json({ error: err.message });
  }
});

// Obtener un producto específico
app.get('/api/productos/:id', async (req, res) => {
  try {
    const result = await executeQuery('SELECT * FROM productos WHERE id = ?', [req.params.id]);
    let row = result.rows[0];

    if (!row) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    if (usuarioActual.rol === 'operario') {
      row = { ...row, precio: null };
    }
    res.json(row);
  } catch (err) {
    console.error('Error en GET /api/productos/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// Crear/actualizar producto
app.post('/api/productos', async (req, res) => {
  try {
    if (usuarioActual.rol !== 'admin' && usuarioActual.rol !== 'gerente') {
      return res.status(403).json({ error: 'Permisos insuficientes' });
    }

    const { codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id } = req.body;

    if (req.body.id) {
      // Actualizar
      const updateTime = usePostgres ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP';
      const query = usePostgres
        ? `UPDATE productos SET codigo=?, nombre=?, categoria=?, presentacion=?, stock=?, stock_minimo=?, precio=?, fecha_caducidad=?, zona=?, contifico_id=?, updated_at=${updateTime} WHERE id=?`
        : `UPDATE productos SET codigo=?, nombre=?, categoria=?, presentacion=?, stock=?, stock_minimo=?, precio=?, fecha_caducidad=?, zona=?, contifico_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      await executeQuery(query, [codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id, req.body.id]);
      res.json({ success: true, id: req.body.id });
    } else {
      // Crear
      console.log('📝 Creando producto:', { codigo, nombre });
      const query = usePostgres
        ? `INSERT INTO productos (codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (codigo) DO UPDATE SET nombre=?, categoria=?, presentacion=?, stock=?, stock_minimo=?, precio=?, fecha_caducidad=?, zona=?, contifico_id=? RETURNING id`
        : `INSERT INTO productos (codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const params = usePostgres
        ? [codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id]
        : [codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id];
      const result = await executeQuery(query, params);
      const lastId = usePostgres ? result.rows[0]?.id : result.lastID;
      console.log('✅ Producto creado con ID:', lastId);
      
      // Crear movimiento de entrada automático si hay stock
      if (stock > 0) {
        try {
          let costoTotal = 0;
          if (precio && precio > 0) {
            // Costo = precio por unidad * cantidad de unidades
            costoTotal = precio * stock;
          }
          console.log('💰 Costo calculado:', { precio, stock, costoTotal });
          const movQuery = usePostgres
            ? `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, unidad_salida, zona_destino, operario, descripcion, costo_total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
            : `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, unidad_salida, zona_destino, operario, descripcion, costo_total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          await executeQuery(movQuery, [lastId, 'entrada', stock, presentacion || 'und', zona || 'Almacén', 'Sistema', `Importación desde Excel - ${nombre}`, costoTotal, new Date().toISOString()]);
          console.log('📥 Movimiento de entrada creado con costo:', costoTotal);
        } catch (err) {
          console.log('⚠️ No se pudo crear movimiento:', err.message);
        }
      }
      
      if (!usePostgres) db.saveData();
      res.json({ success: true, id: lastId });
    }
  } catch (err) {
    console.error('Error en POST /api/productos:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ CONVERSIÓN DE UNIDADES DE MEDIDA ============
// Cada unidad tiene una dimensión (masa/volumen/conteo) y un factor hacia la
// unidad base de esa dimensión: masa->gramo, volumen->mililitro, conteo->unidad.
const FACTOR_UNIDAD = {
  g: 1, gr: 1, gramo: 1, gramos: 1,
  kg: 1000, kilo: 1000, kilogramo: 1000, kilogramos: 1000,
  lb: 453.592, libra: 453.592, libras: 453.592,
  ml: 1, cc: 1, mililitro: 1, mililitros: 1,
  l: 1000, lt: 1000, litro: 1000, litros: 1000,
  un: 1, u: 1, und: 1, unidad: 1, unidades: 1
};
const DIM_UNIDAD = {
  g: 'masa', gr: 'masa', gramo: 'masa', gramos: 'masa',
  kg: 'masa', kilo: 'masa', kilogramo: 'masa', kilogramos: 'masa',
  lb: 'masa', libra: 'masa', libras: 'masa',
  ml: 'volumen', cc: 'volumen', mililitro: 'volumen', mililitros: 'volumen',
  l: 'volumen', lt: 'volumen', litro: 'volumen', litros: 'volumen',
  un: 'conteo', u: 'conteo', und: 'conteo', unidad: 'conteo', unidades: 'conteo'
};

function normalizarUnidad(txt) {
  if (!txt) return null;
  const k = String(txt).trim().toLowerCase();
  return DIM_UNIDAD[k] ? k : null;
}

// Deduce la unidad base del producto a partir de su presentación.
// Ej: "25 KG" -> "kg", "250 CC" -> "cc", "1 litro" -> "litro", "1 und" -> "und".
function unidadBasePresentacion(presentacion) {
  if (!presentacion) return null;
  const m = String(presentacion).match(/[a-zA-Z]+/);
  return m ? normalizarUnidad(m[0]) : null;
}

// Convierte 'cantidad' expresada en 'unidadOrigen' a la unidad base del producto.
// Devuelve { ok, cantidad, convertido, error }.
// Si no se puede determinar alguna unidad, no convierte (resta directa segura).
function convertirAUnidadBase(cantidad, unidadOrigen, presentacion) {
  const uOrig = normalizarUnidad(unidadOrigen);
  const uBase = unidadBasePresentacion(presentacion);
  if (!uOrig || !uBase) {
    return { ok: true, cantidad, convertido: false };
  }
  if (DIM_UNIDAD[uOrig] !== DIM_UNIDAD[uBase]) {
    return {
      ok: false,
      error: `No se puede convertir "${unidadOrigen}" a la unidad del producto (${uBase}): son de distinto tipo (${DIM_UNIDAD[uOrig]} vs ${DIM_UNIDAD[uBase]}).`
    };
  }
  const factor = FACTOR_UNIDAD[uOrig] / FACTOR_UNIDAD[uBase];
  return { ok: true, cantidad: cantidad * factor, convertido: uOrig !== uBase, unidadBase: uBase };
}

// ============ ENDPOINTS DE MOVIMIENTOS ============

// Registrar entrada (crea un lote nuevo)
app.post('/api/movimientos/entrada', async (req, res) => {
  try {
    const { producto_id, cantidad, unidad_salida, zona_destino, operario, descripcion, fecha_caducidad } = req.body;

    const result = await executeQuery('SELECT * FROM productos WHERE id = ?', [producto_id]);
    const producto = result.rows[0];

    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Convertir la cantidad ingresada a la unidad base del producto (según su
    // presentación), igual que en la salida. Se valida ANTES de escribir nada.
    const convEnt = convertirAUnidadBase(parseFloat(cantidad || 0), unidad_salida, producto.presentacion);
    if (!convEnt.ok) {
      return res.status(400).json({ error: convEnt.error });
    }
    const cantidadBase = convEnt.cantidad; // en la unidad base del stock

    // 1. Verificar si existe lote inicial (stock anterior)
    const lotesExistentes = await executeQuery('SELECT COUNT(*) as count FROM lotes WHERE producto_id = ?', [producto_id]);
    const existenLotes = parseInt(lotesExistentes.rows[0]?.count) || 0;
    
    // Si no hay lotes y el producto tiene stock, crear lote inicial
    if (existenLotes === 0 && producto.stock > 0) {
      const loteInicialQuery = usePostgres
        ? `INSERT INTO lotes (producto_id, cantidad, fecha_caducidad, fecha_ingreso, operario, descripcion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
        : `INSERT INTO lotes (producto_id, cantidad, fecha_caducidad, fecha_ingreso, operario, descripcion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      
      const hoy = new Date().toISOString().split('T')[0];
      await executeQuery(
        loteInicialQuery,
        [producto_id, producto.stock, producto.fecha_caducidad || hoy, hoy, 'Sistema', 'Lote inicial (stock existente)', new Date().toISOString()]
      );
    }

    // 2. Crear nuevo lote
    const loteQuery = usePostgres
      ? `INSERT INTO lotes (producto_id, cantidad, fecha_caducidad, fecha_ingreso, operario, descripcion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      : `INSERT INTO lotes (producto_id, cantidad, fecha_caducidad, fecha_ingreso, operario, descripcion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    
    const hoy = new Date().toISOString().split('T')[0];
    const loteResult = await executeQuery(
      loteQuery,
      [producto_id, cantidadBase, fecha_caducidad || hoy, hoy, operario, descripcion, new Date().toISOString()]
    );
    const loteId = usePostgres ? loteResult.rows[0].id : loteResult.lastID;

    // 3. Actualizar stock: SUMAR la cantidad ingresada al stock actual del producto.
    //    NO se recalcula desde la tabla de lotes, porque el stock puede haberse
    //    ajustado por importación de Excel, edición manual o salidas —cambios que
    //    no modifican la tabla de lotes— y recalcular desde lotes borraría el stock real.
    const stockAntes = (producto.stock !== null && producto.stock !== undefined) ? parseFloat(producto.stock) : 0;
    const nuevoStock = stockAntes + cantidadBase;

    // fecha_caducidad del producto = la más próxima a vencer entre la que ya tenía
    // y la del nuevo ingreso (normalizada a YYYY-MM-DD).
    const normFecha = (v) => {
      if (!v) return null;
      if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
      return String(v).split('T')[0];
    };
    let fechaMasProxima = null;
    let tsMasProximo = Infinity;
    for (const f of [normFecha(producto.fecha_caducidad), normFecha(fecha_caducidad)]) {
      if (!f) continue;
      const ts = new Date(f).getTime();
      if (!isNaN(ts) && ts < tsMasProximo) { tsMasProximo = ts; fechaMasProxima = f; }
    }

    if (fechaMasProxima) {
      await executeQuery('UPDATE productos SET stock = ?, fecha_caducidad = ? WHERE id = ?', [nuevoStock, fechaMasProxima, producto_id]);
    } else {
      await executeQuery('UPDATE productos SET stock = ? WHERE id = ?', [nuevoStock, producto_id]);
    }

    // 3. Registrar en movimientos
    const movQuery = usePostgres
      ? `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, unidad_salida, zona_destino, operario, descripcion, fecha_caducidad, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      : `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, unidad_salida, zona_destino, operario, descripcion, fecha_caducidad, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const movResult = await executeQuery(
      movQuery,
      [producto_id, 'entrada', cantidad, unidad_salida, zona_destino, operario, `Lote: ${loteId} - ${descripcion}`, fecha_caducidad || hoy, new Date().toISOString()]
    );

    const movId = usePostgres ? movResult.rows[0].id : movResult.lastID;
    res.json({ success: true, id: movId, loteId, nuevoStock });
  } catch (err) {
    console.error('Error en POST /api/movimientos/entrada:', err);
    res.status(500).json({ error: err.message });
  }
});

// Registrar salida (con cálculo automático de costo)
app.post('/api/movimientos/salida', async (req, res) => {
  try {
    const { producto_id, cantidad_salida, unidad_salida, zona_origen, operario, descripcion } = req.body;
    console.log('📝 Movimiento salida recibido:', { producto_id, cantidad_salida, unidad_salida, zona_origen });

    const result = await executeQuery('SELECT * FROM productos WHERE id = ?', [producto_id]);
    const producto = result.rows[0];

    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Validar stock: si es NULL o undefined, usar 0
    const stockActual = producto.stock !== null && producto.stock !== undefined ? parseFloat(producto.stock) : 0;
    const cantidadIngresada = parseFloat(cantidad_salida || 0);

    // Convertir la cantidad a la unidad base del producto (según su presentación).
    // Ej: producto en "25 KG"; el usuario saca 500 g -> 0.5 kg descontados del stock.
    const conv = convertirAUnidadBase(cantidadIngresada, unidad_salida, producto.presentacion);
    if (!conv.ok) {
      return res.status(400).json({ error: conv.error });
    }
    const cantidadSalida = conv.cantidad; // ya en la unidad base del stock

    // Validar que hay suficiente stock (comparando en la misma unidad)
    if (stockActual < cantidadSalida) {
      return res.status(400).json({ error: 'Stock insuficiente' });
    }

    // Calcular costo unitario automáticamente
    // Ej: si el producto es de 25 KG y el precio es 100, entonces 1 KG = 100/25 = 4
    let costoUnitario = 0;
    let costoTotal = 0;

    if (producto.precio && producto.presentacion) {
      // Extraer cantidad de la presentación (ej: "25 KG" -> 25)
      const match = producto.presentacion.match(/(\d+\.?\d*)/);
      if (match) {
        const cantidadPresentacion = parseFloat(match[1]);
        costoUnitario = producto.precio / cantidadPresentacion;
        costoTotal = costoUnitario * cantidadSalida;
      }
    }

    const nuevoStock = stockActual - cantidadSalida;

    await executeQuery('UPDATE productos SET stock = ? WHERE id = ?', [nuevoStock, producto_id]);

    // En el historial se guarda lo que el usuario ingresó (cantidad + unidad),
    // aunque el descuento al stock se haya hecho ya convertido a la unidad base.
    const movQuery = usePostgres
      ? `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, cantidad_salida, unidad_salida, zona_origen, operario, costo_unitario, costo_total, descripcion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      : `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, cantidad_salida, unidad_salida, zona_origen, operario, costo_unitario, costo_total, descripcion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const movResult = await executeQuery(
      movQuery,
      [producto_id, 'salida', stockActual, cantidadIngresada, unidad_salida, zona_origen, operario, costoUnitario, costoTotal, descripcion, new Date().toISOString()]
    );

    const movId = usePostgres ? movResult.rows[0]?.id : movResult.lastID;
    res.json({ success: true, id: movId, nuevoStock, costoTotal, cantidadDescontada: cantidadSalida, convertido: conv.convertido });
  } catch (err) {
    console.error('Error en POST /api/movimientos/salida:', err);
    res.status(500).json({ error: err.message });
  }
});

// Obtener movimientos
app.get('/api/movimientos', async (req, res) => {
  try {
    const { producto_id, tipo, desde, hasta } = req.query;
    let query = `SELECT * FROM movimientos WHERE 1=1`;
    let params = [];

    if (producto_id) {
      query += ` AND producto_id = ?`;
      params.push(producto_id);
    }
    if (tipo) {
      query += ` AND tipo = ?`;
      params.push(tipo);
    }

    query += ' ORDER BY id DESC LIMIT 5000';

    const result = await executeQuery(query, params);
    let rows = result.rows;

    // Obtener todos los productos para mapear nombres
    const productosResult = await executeQuery('SELECT id, nombre, codigo FROM productos');
    const productosMap = {};
    productosResult.rows.forEach(p => {
      productosMap[p.id] = p;
    });

    // Agregar nombre y código a cada movimiento
    rows = rows.map(r => ({
      ...r,
      nombre: productosMap[r.producto_id]?.nombre || '-',
      codigo: productosMap[r.producto_id]?.codigo || '-'
    }));

    if (usuarioActual.rol === 'operario') {
      rows = rows.map(r => ({ ...r, precio: null, costo_unitario: null, costo_total: null }));
    }
    res.json(rows);
  } catch (err) {
    console.error('Error en GET /api/movimientos:', err);
    res.status(500).json({ error: err.message });
  }
});

// Eliminar movimiento (con reversión de stock)
app.delete('/api/movimientos/:id', async (req, res) => {
  try {
    const { clave } = req.body;
    const movimientoId = req.params.id;

    // Validación simple de clave
    if (clave !== 'mindmind4482') {
      return res.status(403).json({ error: 'Clave incorrecta' });
    }

    const movResult = await executeQuery('SELECT * FROM movimientos WHERE id = ?', [movimientoId]);
    const movimiento = movResult.rows[0];

    if (!movimiento) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }

    // Obtener producto para revertir stock
    const prodResult = await executeQuery('SELECT * FROM productos WHERE id = ?', [movimiento.producto_id]);
    const producto = prodResult.rows[0];

    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Revertir stock según el tipo de movimiento
    let nuevoStock = producto.stock;
    if (movimiento.tipo === 'salida') {
      nuevoStock = producto.stock + movimiento.cantidad_salida;
    } else if (movimiento.tipo === 'entrada') {
      nuevoStock = producto.stock - movimiento.cantidad_presentacion;
    }

    // Actualizar stock
    await executeQuery('UPDATE productos SET stock = ? WHERE id = ?', [nuevoStock, movimiento.producto_id]);

    // Eliminar movimiento
    await executeQuery('DELETE FROM movimientos WHERE id = ?', [movimientoId]);

    // Si el producto queda con stock 0, registrar la eliminación en historial
    if (nuevoStock <= 0) {
      // Registrar eliminación como movimiento (sin eliminar el producto)
      const elimQuery = usePostgres
        ? `INSERT INTO movimientos (producto_id, tipo, operario, descripcion, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`
        : `INSERT INTO movimientos (producto_id, tipo, operario, descripcion, created_at) VALUES (?, ?, ?, ?, ?)`;
      await executeQuery(elimQuery, [movimiento.producto_id, 'eliminación', 'Sistema', `Producto eliminado - Stock llegó a 0`, new Date().toISOString()]);
      console.log('📝 Registro de eliminación creado');
    }

    res.json({ success: true, mensaje: 'Movimiento eliminado y stock revertido' });
  } catch (err) {
    console.error('Error en DELETE /api/movimientos/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// Eliminar producto
app.delete('/api/productos/:id', async (req, res) => {
  try {
    // Solo admin puede eliminar productos
    if (usuarioActual.rol !== 'admin') {
      return res.status(403).json({ error: 'Solo admin puede eliminar productos' });
    }

    const productoId = req.params.id;

    // Obtener datos del producto antes de eliminar
    const prodResult = await executeQuery('SELECT * FROM productos WHERE id = ?', [productoId]);
    const producto = prodResult.rows[0];

    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Primero: Calcular la cantidad original que se ingresó
    const entradaResult = await executeQuery('SELECT SUM(cantidad_presentacion) as total FROM movimientos WHERE producto_id = ? AND tipo = ?', [productoId, 'entrada']);
    const cantidadOriginal = parseInt(entradaResult.rows[0]?.total) || 0;

    // Segundo: Eliminar todos los movimientos previos del producto
    await executeQuery('DELETE FROM movimientos WHERE producto_id = ?', [productoId]);

    // Tercero: Registrar la eliminación en el historial con todos los detalles
    const elimQuery = usePostgres
      ? `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, unidad_salida, zona_origen, operario, descripcion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      : `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, unidad_salida, zona_origen, operario, descripcion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    
    await executeQuery(elimQuery, [
      productoId, 
      'eliminación', 
      cantidadOriginal,
      producto.presentacion || '',
      producto.zona || 'N/A',
      'Admin', 
      `ELIMINADO: ${producto.nombre} (Código: ${producto.codigo}) - Cantidad original: ${cantidadOriginal}`,
      new Date().toISOString()
    ]);

    // Tercero: Eliminar el producto
    await executeQuery('DELETE FROM productos WHERE id = ?', [productoId]);

    res.json({ success: true, mensaje: 'Producto eliminado y registro creado en historial' });
  } catch (err) {
    console.error('Error en DELETE /api/productos/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ ENDPOINTS DE LOTES ============
app.get('/api/lotes/:producto_id', async (req, res) => {
  try {
    const { producto_id } = req.params;
    const result = await executeQuery('SELECT * FROM lotes WHERE producto_id = ? ORDER BY fecha_caducidad ASC', [producto_id]);
    res.json(result.rows || []);
  } catch (err) {
    console.error('Error en GET /api/lotes:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ ESTADÍSTICAS PARA DASHBOARD ============

app.get('/api/estadisticas', async (req, res) => {
  try {
    const result = await executeQuery('SELECT * FROM productos');
    const productos = result.rows;

    const today = new Date();
    const hace60Dias = new Date();
    hace60Dias.setDate(hace60Dias.getDate() + 60);

    // Función para parsear fecha en formato "mes-año"
    function parsearFecha(fechaStr) {
      if (!fechaStr) return null;
      
      // Formato YYYY-MM-DD (ejemplo: 2026-09-01)
      if (fechaStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = fechaStr.split('-');
        // Retornar el último día del mes para comparación correcta
        const fecha = new Date(parseInt(year), parseInt(month), 0);
        return isNaN(fecha.getTime()) ? null : fecha;
      }
      
      // Formato MM-YY o MM-YYYY (ejemplo: 09-26 o 09-2026)
      if (fechaStr.match(/^\d{2}-\d{2,4}$/)) {
        const [month, year] = fechaStr.split('-');
        let fullYear = parseInt(year);
        if (fullYear < 100) fullYear += 2000;
        // Retornar el último día del mes para comparación correcta
        const fecha = new Date(fullYear, parseInt(month), 0);
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
          // Retornar el último día del mes para comparación correcta
          const fecha = new Date(año, mes, 0);
          return isNaN(fecha.getTime()) ? null : fecha;
        }
      }
      return null;
    }

    const stats = {
      totalProductos: productos.length,
      productosCaducados: productos.filter(p => {
        const fecha = parsearFecha(p.fecha_caducidad);
        return fecha && fecha < today;
      }).length,
      productosProximoCaducar: productos.filter(p => {
        const fecha = parsearFecha(p.fecha_caducidad);
        return fecha && fecha <= hace60Dias && fecha >= today;
      }).length,
      productosBajoStock: productos.filter(p => p.stock <= (p.stock_minimo || 0)).length,
      productosSinStock: productos.filter(p => p.stock === 0 || p.stock < 1).length,
      valorTotalInventario: productos.reduce((sum, p) => sum + (p.stock * (p.precio || 0)), 0),
      categorias: [...new Set(productos.map(p => p.categoria))],
      zonas: [...new Set(productos.map(p => p.zona))]
    };

    res.json(stats);
  } catch (err) {
    console.error('Error en GET /api/estadisticas:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ EXPORTAR A EXCEL ============
app.get('/api/exportar/excel', async (req, res) => {
  try {
    if (usuarioActual.rol === 'operario') {
      return res.status(403).json({ error: 'Operarios no pueden exportar' });
    }

    const result = await executeQuery('SELECT * FROM productos ORDER BY nombre');
    const productos = result.rows;

    // Usar librería xlsx si está instalada
    try {
      const XLSX = require('xlsx');
      const ws = XLSX.utils.json_to_sheet(productos);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Inventario');

      const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=inventario.xlsx');
      res.send(buffer);
    } catch (e) {
      // Fallback: enviar JSON si xlsx no está instalado
      res.json(productos);
    }
  } catch (err) {
    console.error('Error en GET /api/exportar/excel:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ IMPORTAR DESDE EXCEL ============
app.post('/api/importar/excel', async (req, res) => {
  try {
    const { productos } = req.body;
    if (!Array.isArray(productos)) {
      return res.status(400).json({ error: 'Se esperaba un array de productos' });
    }

    let agregados = 0;
    for (const p of productos) {
      // Validar que tenga al menos código y nombre
      if (!p.codigo || !p.nombre) continue;

      const nuevoProducto = {
        codigo: p.codigo,
        nombre: p.nombre,
        categoria: p.categoria || 'Sin categoría',
        presentacion: p.presentacion || '',
        stock: parseFloat(p.stock) || 0,
        stock_minimo: parseFloat(p.stock_minimo) || 5,
        precio: parseFloat(p.precio) || 0,
        fecha_caducidad: p.fecha_caducidad || '',
        bodega: p.bodega || 'Almacén',
        zona: p.zona || 'C1',
        id: require('crypto').randomBytes(6).toString('hex')
      };

      await executeQuery(
        `INSERT INTO productos (codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, bodega, zona, id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [nuevoProducto.codigo, nuevoProducto.nombre, nuevoProducto.categoria, nuevoProducto.presentacion,
         nuevoProducto.stock, nuevoProducto.stock_minimo, nuevoProducto.precio, nuevoProducto.fecha_caducidad,
         nuevoProducto.bodega, nuevoProducto.zona, nuevoProducto.id]
      );
      agregados++;
    }

    res.json({ success: true, agregados });
  } catch (err) {
    console.error('Error en POST /api/importar/excel:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ NORMALIZACIÓN TEMPORAL: FORMATO DE FECHAS ============
// Endpoint de un solo uso: convierte fechas de caducidad en formato viejo
// MM-YY o MM-YYYY (ej. "07-27") al estándar YYYY-MM-DD usando día 15.
// Uso: abrir en el navegador https://TU-APP/api/normalizar-fechas?clave=mindmind4482
// IMPORTANTE: eliminar este bloque después de usarlo una vez.
app.get('/api/normalizar-fechas', async (req, res) => {
  try {
    if (req.query.clave !== 'mindmind4482') {
      return res.status(403).json({ error: 'Clave incorrecta' });
    }

    const result = await executeQuery('SELECT id, codigo, fecha_caducidad FROM productos');
    const productos = result.rows || [];
    const cambios = [];

    for (const p of productos) {
      const f = p.fecha_caducidad ? String(p.fecha_caducidad).trim() : '';
      // Solo formato MM-YY o MM-YYYY (2 dígitos - 2 a 4 dígitos)
      const m = f.match(/^(\d{2})-(\d{2,4})$/);
      if (!m) continue;
      const mes = parseInt(m[1], 10);
      let anio = parseInt(m[2], 10);
      if (anio < 100) anio += 2000;
      if (mes < 1 || mes > 12) continue;
      const nueva = `${anio}-${String(mes).padStart(2, '0')}-15`;
      await executeModify('UPDATE productos SET fecha_caducidad = ? WHERE id = ?', [nueva, p.id]);
      cambios.push({ codigo: p.codigo, antes: f, despues: nueva });
    }

    res.json({
      success: true,
      mensaje: `${cambios.length} fechas normalizadas a YYYY-MM-DD`,
      cambios
    });
  } catch (err) {
    console.error('Error en GET /api/normalizar-fechas:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

process.on('SIGINT', () => {
  if (usePostgres) {
    pool.end(() => {
      console.log('Conexión a PostgreSQL cerrada');
      process.exit();
    });
  } else {
    db.close();
    console.log('BD LocalDB guardada a data.json');
    process.exit();
  }
});
