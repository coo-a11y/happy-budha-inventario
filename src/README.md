# src/ — Estructura futura (aún vacía por diseño)

Carpetas preparadas para la evolución modular de HappyBuddha Farm OS.
**En la fase actual (PARTE 1) NO se ha movido código aquí todavía**, para no arriesgar
funcionalidades en producción. `server.js` sigue siendo la fuente de verdad.

La migración de código a estas carpetas será gradual y verificada, en fases posteriores,
solo tras tu aprobación.

- `routes/` — definición de endpoints HTTP (extraídos de server.js en el futuro).
- `services/` — lógica de negocio (inventario, producción, cultivo…).
- `repositories/` — acceso a datos (queries), aislando el motor (Postgres/local).
- `modules/` — módulos agrícolas nuevos de Farm OS.
