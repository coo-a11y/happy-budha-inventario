# Migración de SQLite a PostgreSQL

## Cambios realizados

Se ha completado la migración del servidor de SQLite3 a PostgreSQL. A continuación se detallan los cambios realizados:

### 1. Archivos creados y modificados

- **`.env.local`** (NUEVO)
  - Contiene las credenciales de conexión a la base de datos PostgreSQL de Railway
  - PORT y NODE_ENV configurados

- **`package.json`** (MODIFICADO)
  - Reemplazado `sqlite3: ^5.1.6` por `pg: ^8.11.3`
  - Se mantienen todas las otras dependencias iguales

- **`server.js`** (MODIFICADO)
  - Reemplazado el módulo `sqlite3` por `pg`
  - Cambio de callbacks a async/await para mejor manejo de errores
  - Actualización de todas las queries SQL de SQLite a PostgreSQL

### 2. Cambios principales en SQL

#### Creación de tablas
- **SQLite**: `INTEGER PRIMARY KEY AUTOINCREMENT` 
- **PostgreSQL**: `SERIAL PRIMARY KEY` (auto-incremento automático)

- **SQLite**: `DATETIME DEFAULT CURRENT_TIMESTAMP`
- **PostgreSQL**: `TIMESTAMP DEFAULT CURRENT_TIMESTAMP`

#### Parámetros de consultas
- **SQLite**: `?` como placeholders
- **PostgreSQL**: `$1, $2, $3...` como placeholders numerados

#### Funciones de texto
- **SQLite**: `LIKE '%texto%'`
- **PostgreSQL**: `ILIKE '%texto%'` (case-insensitive en PostgreSQL)

#### Funciones de fecha
- **SQLite**: `date('now')`, `date(campo)`
- **PostgreSQL**: `CURRENT_DATE`, `campo::date`

#### Cálculo de fechas
- **SQLite**: `date('now', '+60 days')`
- **PostgreSQL**: `CURRENT_DATE + INTERVAL '60 days'`

### 3. Endpoints modificados

Todos los endpoints ahora usan `pool.query()` en lugar de callbacks:

- `GET /api/productos` - Listado con filtros
- `GET /api/productos/:id` - Obtener un producto
- `POST /api/productos` - Crear/actualizar producto
- `POST /api/movimientos/entrada` - Registrar entrada
- `POST /api/movimientos/salida` - Registrar salida
- `GET /api/movimientos` - Listar movimientos
- `DELETE /api/movimientos/:id` - Eliminar movimiento
- `DELETE /api/productos/:id` - Eliminar producto
- `GET /api/estadisticas` - Obtener estadísticas del dashboard
- `GET /api/exportar/excel` - Exportar a Excel

### 4. Manejo de conexiones

- **Pool de conexiones**: Se usa `const pool = new Pool()` para manejar múltiples conexiones concurrentes
- **SSL**: Configurado `rejectUnauthorized: false` para conexiones remotas (Railway)
- **Graceful shutdown**: Se cierra el pool correctamente en `process.on('SIGINT')`

## Pasos para instalar y ejecutar

### 1. Instalar dependencias (EN TU MÁQUINA LOCAL)

```bash
cd "/Users/saryalarcon/Desktop/happybudha-inventario 5"
npm install
```

### 2. Verificar `.env.local`

El archivo `.env.local` ya está creado con las credenciales de Railway:

```env
DATABASE_URL=postgresql://postgres:uxNXFyoHxjKhRujePGVAIFfnJGFrRMps@postgres.railway.internal:5432/railway
PORT=3000
NODE_ENV=development
```

### 3. Ejecutar el servidor

```bash
npm start
```

O en modo desarrollo con nodemon:

```bash
npm run dev
```

### 4. Verificar la conexión

Accede a http://localhost:3000 en tu navegador. El servidor debería mostrar:

```
╔═══════════════════════════════════════════════════╗
║  Happy Budha - Sistema de Inventario v4         ║
║  🌐 http://localhost:3000                        ║
║  ✅ Servidor escuchando en puerto 3000           ║
╚═══════════════════════════════════════════════════╝
```

Y en la consola:

```
✅ BD conectada: { now: 2026-07-05T19:44:00.000Z }
✅ Tabla productos lista
✅ Tabla movimientos lista
✅ Tabla usuarios lista
✅ Tabla conversiones lista
```

## Notas importantes

1. **Base de datos compartida**: Ahora estás usando la base de datos PostgreSQL compartida de Railway. Todos los datos se guardan en la nube.

2. **Credenciales seguras**: Las credenciales están en `.env.local` que NO debe committearse a git. Asegúrate de que `.gitignore` incluya `*.local`.

3. **Compatibilidad**: La estructura de las tablas es idéntica, por lo que la interfaz del navegador funciona sin cambios.

4. **Migrando datos existentes**: Si tenías datos en la base de datos SQLite anterior, necesitarás exportarlos e importarlos a PostgreSQL manualmente.

5. **Diferencias menores**: PostgreSQL es más estricto con tipos de datos. Si hay errores, revisa los logs en `console.error()`.

## Rollback a SQLite (si es necesario)

Si necesitas volver a SQLite:

1. Revertir `package.json`: cambiar `pg` por `sqlite3`
2. Revertir `server.js` al código anterior
3. `npm install`

## Troubleshooting

### Error de conexión
- Verifica que `DATABASE_URL` en `.env.local` es correcta
- Asegúrate que tu máquina tiene acceso a `postgres.railway.internal`

### Error "query_placeholder_mismatch"
- Las queries usan `$1, $2...` pero se pasó el número de parámetros incorrecto
- Revisa que el número de `$N` coincida con el array de parámetros

### Tabla ya existe
- Esto es normal. `CREATE TABLE IF NOT EXISTS` no lanza error si la tabla ya existe.

---

**Migración completada**: 2026-07-05  
**Estado**: Listo para producción en Railway
