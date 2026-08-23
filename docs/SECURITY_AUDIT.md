# SECURITY_AUDIT.md — Auditoría de secretos (PARTE 1)

Revisión de secretos hardcodeados en el repositorio. **Los valores están redactados a propósito.**
No se rotaron ni cambiaron credenciales de Railway en esta fase (según lo indicado).

## Hallazgos

### 1. `SECRETO ENCONTRADO` — archivo `.enves`, tipo `DATABASE_URL` (ALTA)

- El archivo `.enves` estaba **versionado en git** y contenía:
  `DATABASE_URL=postgresql://USUARIO:****REDACTED****@****REDACTED****/****`
- `.enves` **no es usado por el código** (la app carga `.env` vía dotenv). Es un archivo
  residual, probablemente un error de tipeo de `.env`.
- **Acción tomada (segura, no destructiva):**
  - Añadido a `.gitignore`.
  - `git rm --cached .enves` → deja de versionarse a futuro. **El archivo sigue en tu disco**,
    solo se quitó del control de versiones.
- **Pendiente recomendado (requiere tu aprobación):** el secreto **sigue en el historial de git**.
  Cuando decidas, conviene **rotar la contraseña de PostgreSQL en Railway** y, opcionalmente,
  limpiar el historial. Esto es un cambio de credenciales, así que **no** lo hice automáticamente.

### 2. `.env` — `DATABASE_URL`, `PORT`, `NODE_ENV` (OK)

- `.env` **sí** contiene el `DATABASE_URL` real, pero **ya estaba en `.gitignore`** y **no** está
  versionado. Correcto. No requiere acción.

### 3. Código fuente `server.js` (OK)

- No hay secretos hardcodeados. Todo se lee de variables de entorno:
  - `process.env.DATABASE_URL` (`server.js:430,438`)
  - `process.env.GOOGLE_SHEETS_WEBHOOK_URL` (`server.js:490`)
  - `process.env.PORT` (`server.js:7`)
- **Nota (no secreto, pero a mejorar):** el login (`server.js:978`) es simbólico —
  acepta cualquier `email`+`rol` sin contraseña real ni hash. Es autenticación de conveniencia,
  no de seguridad. Recomendado endurecer en una fase futura (no en esta).

### 4. Archivos de datos versionados (INFO, no son secretos)

- `data.json`, `data.json.backup`, `inventario.db*` están versionados y contienen datos de
  inventario. **No los desversioné** porque `data.json` **sí es usado** por el código (fallback
  LocalDB y semilla de migración inicial). Solo se deja constancia; cualquier cambio aquí se
  consultaría antes.

## Resumen

| Ítem | Severidad | Estado |
|---|---|---|
| `.enves` versionado con DATABASE_URL | ALTA | Desversionado; rotación de credencial pendiente de tu OK |
| `.env` con secretos | — | Correcto (ya ignorado) |
| Secretos en `server.js` | — | Ninguno (usa env vars) |
| Login sin contraseña real | MEDIA | Anotado para fase futura |
| Datos versionados (`data.json`, `.db`) | INFO | Sin cambios (en uso) |
