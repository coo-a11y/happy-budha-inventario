require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Inicializar BD
const dbPath = path.join(__dirname, 'inventario.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Error abriendo BD:', err);
  else console.log('BD conectada');
});

// Crear tablas si no existen
db.serialize(() => {
  // Tabla de productos
  db.run(`CREATE TABLE IF NOT EXISTS productos (
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

  // Tabla de movimientos
  db.run(`CREATE TABLE IF NOT EXISTS movimientos (
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

  // Tabla de usuarios/roles
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    email TEXT UNIQUE,
    rol TEXT,
    activo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabla de conversiones de unidades
  db.run(`CREATE TABLE IF NOT EXISTS conversiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER,
    unidad_presentacion TEXT,
    unidad_salida TEXT,
    factor REAL,
    FOREIGN KEY(producto_id) REFERENCES productos(id)
  )`);
});

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
app.get('/api/productos', (req, res) => {
  const { categoria, zona, buscar, estado } = req.query;
  let query = 'SELECT * FROM productos WHERE 1=1';
  let params = [];

  if (categoria) {
    query += ' AND categoria = ?';
    params.push(categoria);
  }
  if (zona) {
    query += ' AND zona = ?';
    params.push(zona);
  }
  if (buscar) {
    query += ' AND (nombre LIKE ? OR codigo LIKE ?)';
    params.push(`%${buscar}%`, `%${buscar}%`);
  }
  if (estado === 'caducado') {
    query += ` AND fecha_caducidad != '' AND fecha_caducidad < date('now')`;
  } else if (estado === 'proximo-caducar') {
    query += ` AND fecha_caducidad != '' AND date(fecha_caducidad) BETWEEN date('now') AND date('now', '+60 days')`;
  } else if (estado === 'bajo-stock') {
    query += ' AND stock <= stock_minimo';
  }

  query += ' ORDER BY nombre ASC';

  db.all(query, params, (err, rows) => {
    if (err) res.status(500).json({ error: err.message });
    else {
      // Si el usuario es operario, ocultar precios
      if (usuarioActual.rol === 'operario') {
        rows = rows.map(r => ({ ...r, precio: null, costo_total: null }));
      }
      res.json(rows);
    }
  });
});

// Obtener un producto específico
app.get('/api/productos/:id', (req, res) => {
  db.get('SELECT * FROM productos WHERE id = ?', [req.params.id], (err, row) => {
    if (err) res.status(500).json({ error: err.message });
    else {
      if (usuarioActual.rol === 'operario') {
        row = { ...row, precio: null };
      }
      res.json(row);
    }
  });
});

// Crear/actualizar producto
app.post('/api/productos', (req, res) => {
  if (usuarioActual.rol !== 'admin' && usuarioActual.rol !== 'gerente') {
    return res.status(403).json({ error: 'Permisos insuficientes' });
  }

  const { codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id } = req.body;

  if (req.body.id) {
    // Actualizar
    db.run(
      `UPDATE productos SET codigo=?, nombre=?, categoria=?, presentacion=?, stock=?,
       stock_minimo=?, precio=?, fecha_caducidad=?, zona=?, contifico_id=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id, req.body.id],
      (err) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json({ success: true, id: req.body.id });
      }
    );
  } else {
    // Crear
    db.run(
      `INSERT INTO productos (codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [codigo, nombre, categoria, presentacion, stock, stock_minimo, precio, fecha_caducidad, zona, contifico_id],
      function (err) {
        if (err) res.status(500).json({ error: err.message });
        else res.json({ success: true, id: this.lastID });
      }
    );
  }
});

// ============ ENDPOINTS DE MOVIMIENTOS ============

// Registrar entrada
app.post('/api/movimientos/entrada', (req, res) => {
  const { producto_id, cantidad, unidad_salida, zona_destino, operario, descripcion } = req.body;

  db.get('SELECT * FROM productos WHERE id = ?', [producto_id], (err, producto) => {
    if (err || !producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const nuevoStock = producto.stock + cantidad;

    db.run('UPDATE productos SET stock = ? WHERE id = ?', [nuevoStock, producto_id], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      db.run(
        `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, unidad_salida, zona_destino, operario, descripcion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [producto_id, 'entrada', cantidad, unidad_salida, zona_destino, operario, descripcion],
        function (err) {
          if (err) res.status(500).json({ error: err.message });
          else res.json({ success: true, id: this.lastID, nuevoStock });
        }
      );
    });
  });
});

// Registrar salida (con cálculo automático de costo)
app.post('/api/movimientos/salida', (req, res) => {
  const { producto_id, cantidad_salida, unidad_salida, zona_origen, operario, descripcion } = req.body;

  db.get('SELECT * FROM productos WHERE id = ?', [producto_id], (err, producto) => {
    if (err || !producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Validar que hay suficiente stock
    if (producto.stock < cantidad_salida) {
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
        costoTotal = costoUnitario * cantidad_salida;
      }
    }

    const nuevoStock = producto.stock - cantidad_salida;

    db.run('UPDATE productos SET stock = ? WHERE id = ?', [nuevoStock, producto_id], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      db.run(
        `INSERT INTO movimientos (producto_id, tipo, cantidad_presentacion, cantidad_salida, unidad_salida,
         zona_origen, operario, costo_unitario, costo_total, descripcion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [producto_id, 'salida', producto.stock, cantidad_salida, unidad_salida, zona_origen, operario, costoUnitario, costoTotal, descripcion],
        function (err) {
          if (err) res.status(500).json({ error: err.message });
          else res.json({ success: true, id: this.lastID, nuevoStock, costoTotal });
        }
      );
    });
  });
});

// Obtener movimientos
app.get('/api/movimientos', (req, res) => {
  const { producto_id, tipo, desde, hasta } = req.query;
  let query = `
    SELECT m.*, p.nombre, p.codigo
    FROM movimientos m
    JOIN productos p ON m.producto_id = p.id
    WHERE 1=1
  `;
  let params = [];

  if (producto_id) {
    query += ' AND m.producto_id = ?';
    params.push(producto_id);
  }
  if (tipo) {
    query += ' AND m.tipo = ?';
    params.push(tipo);
  }
  if (desde) {
    query += " AND m.created_at >= datetime(?)";
    params.push(desde);
  }
  if (hasta) {
    query += " AND m.created_at <= datetime(?)";
    params.push(hasta);
  }

  query += ' ORDER BY m.created_at DESC LIMIT 500';

  db.all(query, params, (err, rows) => {
    if (err) res.status(500).json({ error: err.message });
    else {
      if (usuarioActual.rol === 'operario') {
        rows = rows.map(r => ({ ...r, precio: null, costo_unitario: null, costo_total: null }));
      }
      res.json(rows);
    }
  });
});

// ============ ESTADÍSTICAS PARA DASHBOARD ============

app.get('/api/estadisticas', (req, res) => {
  db.all('SELECT * FROM productos', (err, productos) => {
    if (err) return res.status(500).json({ error: err.message });

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
  });
});

// ============ EXPORTAR A EXCEL ============
app.get('/api/exportar/excel', (req, res) => {
  if (usuarioActual.rol === 'operario') {
    return res.status(403).json({ error: 'Operarios no pueden exportar' });
  }

  db.all('SELECT * FROM productos ORDER BY nombre', (err, productos) => {
    if (err) return res.status(500).json({ error: err.message });

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
  });
});

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║  Happy Budha - Sistema de Inventario v4         ║
║  🌐 http://localhost:${PORT}                        ║
║  ✅ Servidor escuchando en puerto ${PORT}           ║
╚═══════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  db.close();
  process.exit();
});
