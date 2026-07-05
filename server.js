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
      fs.writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Error guardando data.json:', err.message);
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
    return query; // PostgreSQL usa $1, $2, etc
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(producto_id) REFERENCES productos(id)
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(producto_id) REFERENCES productos(id)
      )`);
    }
    console.log('✅ Tabla movimientos lista');

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
        FOREIGN KEY(producto_id) REFERENCES productos(id)
      )`);
    } else {
      await executeQuery(`CREATE TABLE IF NOT EXISTS conversiones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER,
        unidad_presentacion TEXT,
        unidad_salida TEXT,
        factor REAL,
        FOREIGN KEY(producto_id) REFERENCES productos(id)
      )`);
    }
    console.log('✅ Tabla conversiones lista');

    // 5. Iniciar servidor después de todo
    setTimeout(() => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔═══════════════════════════════════════════════════╗
║  Happy Budha - Sistema de Inventario v4         ║
║  🌐 http://localhost:${PORT}                        ║
║  ✅ Servidor escuchando en puerto ${PORT}           ║
╚═══════════════════════════════════════════════════╝
        `);
      });
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
        ? `UPDATE productos SET codigo=?, nombre=?, categoria=?, presentacion=?, stock=?,
           stock_minimo=?, precio=?, fecha_caducidad=?, zona=?, contifico_id=?, updated_at=${updateTime}
           WHERE id=?`
        : `UPDATE productos SET codigo=?, nombre=?, categoria=?, presentacion=?, stock=?,
           stock_minimo=?, precio=?, fecha_caducidad=?, zona=?, contifico_id=?, updated_at=CURRENT_TIMESTAMP
           WHERE id=?`;
      await executeQuery(query, [codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id, req.body.id]);
      res.json({ success: true, id: req.body.id });
    } else {
      // Crear
      const result = await executeQuery(
        `INSERT INTO productos (codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id]
      );
      const lastId = usePostgres ? result.rows[0].id : result.lastID;
      res.json({ success: true, id: lastId });
    }
  } catch (err) {
    console.error('Error en POST /api/productos:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ ENDPOINTS DE MOVIMIENTOS ============

// Registrar entrada
app.post('/api/movimientos/entrada', async (req, res) => {
  try {
    const { producto_id, cantidad, unidad_salida, zona_destino, operario, descripcion } = req.body;

    const result = await executeQuery('SELECT * FROM productos WHERE id = ?', [producto_id]);
    const producto = result.rows[0];

    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Validar stock: si es NULL o undefined, usar 0
    const stockActual = producto.stock !== null && producto.stock !== undefined ? parseFloat(producto.stock) : 0;
    const nuevoStock = stockActual + parseFloat(cantidad || 0);

    await executeQuery('UPDATE productos SET stock = ? WHERE id = ?', [nuevoStock, producto_id]);

    const movResult = await executeQuery(
      `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, unidad_salida, zona_destino, operario, descripcion)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [producto_id, 'entrada', cantidad, unidad_salida, zona_destino, operario, descripcion]
    );

    const movId = usePostgres ? movResult.rows[0].id : movResult.lastID;
    res.json({ success: true, id: movId, nuevoStock });
  } catch (err) {
    console.error('Error en POST /api/movimientos/entrada:', err);
    res.status(500).json({ error: err.message });
  }
});

// Registrar salida (con cálculo automático de costo)
app.post('/api/movimientos/salida', async (req, res) => {
  try {
    const { producto_id, cantidad_salida, unidad_salida, zona_origen, operario, descripcion } = req.body;

    const result = await executeQuery('SELECT * FROM productos WHERE id = ?', [producto_id]);
    const producto = result.rows[0];

    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Validar stock: si es NULL o undefined, usar 0
    const stockActual = producto.stock !== null && producto.stock !== undefined ? parseFloat(producto.stock) : 0;
    const cantidadSalida = parseFloat(cantidad_salida || 0);

    // Validar que hay suficiente stock
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

    const movResult = await executeQuery(
      `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, cantidad_salida, unidad_salida,
       zona_origen, operario, costo_unitario, costo_total, descripcion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [producto_id, 'salida', stockActual, cantidadSalida, unidad_salida, zona_origen, operario, costoUnitario, costoTotal, descripcion]
    );

    const movId = usePostgres ? movResult.rows[0].id : movResult.lastID;
    res.json({ success: true, id: movId, nuevoStock, costoTotal });
  } catch (err) {
    console.error('Error en POST /api/movimientos/salida:', err);
    res.status(500).json({ error: err.message });
  }
});

// Obtener movimientos
app.get('/api/movimientos', async (req, res) => {
  try {
    const { producto_id, tipo, desde, hasta } = req.query;
    let query = `
      SELECT m.*, p.nombre, p.codigo
      FROM movimientos m
      JOIN productos p ON m.producto_id = p.id
      WHERE 1=1
    `;
    let params = [];

    if (producto_id) {
      query += usePostgres ? ` AND m.producto_id = ?` : ` AND m.producto_id = ?`;
      params.push(producto_id);
    }
    if (tipo) {
      query += usePostgres ? ` AND m.tipo = ?` : ` AND m.tipo = ?`;
      params.push(tipo);
    }
    if (desde) {
      query += usePostgres ? ` AND m.id >= ?` : ` AND m.id >= ?`;
      params.push(desde);
    }
    if (hasta) {
      query += usePostgres ? ` AND m.id <= ?` : ` AND m.id <= ?`;
      params.push(hasta);
    }

    query += ' ORDER BY m.id DESC LIMIT 500';

    const result = await executeQuery(query, params);
    let rows = result.rows;

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

    res.json({ success: true, mensaje: 'Movimiento eliminado y stock revertido' });
  } catch (err) {
    console.error('Error en DELETE /api/movimientos/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// Eliminar producto
app.delete('/api/productos/:id', async (req, res) => {
  try {
    if (usuarioActual.rol !== 'admin' && usuarioActual.rol !== 'gerente') {
      return res.status(403).json({ error: 'Permisos insuficientes' });
    }

    const productoId = req.params.id;

    // Primero verificar si hay movimientos asociados
    const countResult = await executeQuery('SELECT COUNT(*) as count FROM movimientos WHERE producto_id = ?', [productoId]);
    const count = parseInt(countResult.rows[0].count) || 0;

    if (count > 0) {
      return res.status(400).json({ error: `No se puede eliminar: hay ${count} movimiento(s) asociado(s)` });
    }

    // Eliminar producto
    await executeQuery('DELETE FROM productos WHERE id = ?', [productoId]);
    res.json({ success: true, mensaje: 'Producto eliminado' });
  } catch (err) {
    console.error('Error en DELETE /api/productos/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ ESTADÍSTICAS PARA DASHBOARD ============

app.get('/api/estadisticas', async (req, res) => {
  try {
    const result = await executeQuery('SELECT * FROM productos');
    const productos = result.rows;

    const today = new Date().toISOString().split('T')[0];

    const stats = {
      totalProductos: productos.length,
      productosCaducados: productos.filter(p => p.fecha_caducidad && p.fecha_caducidad < today).length,
      productosProximoCaducar: productos.filter(p => {
        if (!p.fecha_caducidad) return false;
        const dias = Math.floor((new Date(p.fecha_caducidad) - new Date(today)) / (1000 * 60 * 60 * 24));
        return dias >= 0 && dias <= 60;
      }).length,
      productosBajoStock: productos.filter(p => p.stock <= p.stock_minimo).length,
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
