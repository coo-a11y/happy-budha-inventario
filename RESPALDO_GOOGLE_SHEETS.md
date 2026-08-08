# Respaldo automático a Google Sheets

Guía para conectar la app de inventario con una hoja de Google Sheets de respaldo.
La app enviará **Productos**, **Movimientos** y **Mediciones** a esa hoja en cada cambio
(y con el botón "☁️ Respaldar a Google Sheets").

---

## Paso 1 — Crear la hoja
1. Entra a https://drive.google.com y crea una **Hoja de cálculo** nueva (Google Sheets).
2. Ponle un nombre, por ejemplo: **Respaldo Inventario HappyBudha**.
3. Guárdala en la carpeta de Drive que quieras.

## Paso 2 — Pegar el script
1. En la hoja, ve al menú **Extensiones → Apps Script**.
2. Borra todo el código que aparece por defecto.
3. Pega **exactamente** este código:

```javascript
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    Object.keys(data).forEach(function (nombre) {
      var seccion = data[nombre];
      if (!seccion || !seccion.headers) return;

      var titulo = nombre.charAt(0).toUpperCase() + nombre.slice(1); // Productos, Movimientos, Mediciones
      var hoja = ss.getSheetByName(titulo) || ss.insertSheet(titulo);
      hoja.clearContents();

      var ncols = seccion.headers.length;
      var filas = (seccion.rows || []).map(function (r) {
        r = r || [];
        while (r.length < ncols) r.push('');
        return r.slice(0, ncols);
      });

      var valores = [seccion.headers].concat(filas);
      hoja.getRange(1, 1, valores.length, ncols).setValues(valores);
      hoja.getRange(1, 1, 1, ncols).setFontWeight('bold');
      hoja.setFrozenRows(1);
    });

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

4. Haz clic en el ícono de **guardar** (💾).

## Paso 3 — Publicar como aplicación web
1. Arriba a la derecha: **Implementar (Deploy) → Nueva implementación**.
2. En "Tipo", elige el engranaje ⚙️ → **Aplicación web** (Web app).
3. Configura:
   - **Descripción:** Respaldo inventario
   - **Ejecutar como:** Yo (tu cuenta)
   - **Quién tiene acceso:** **Cualquier persona** (Anyone)
4. Clic en **Implementar**. Te pedirá **autorizar permisos** → acepta (elige tu cuenta,
   "Configuración avanzada" → "Ir a (nombre) (no seguro)" → Permitir). Esto es normal
   porque el script es tuyo.
5. Copia la **URL de la aplicación web** (termina en `/exec`).

## Paso 4 — Conectar la app (Railway)
1. Entra a tu proyecto en **Railway** → tu servicio de la app → pestaña **Variables**.
2. Agrega una variable nueva:
   - **Nombre:** `GOOGLE_SHEETS_WEBHOOK_URL`
   - **Valor:** la URL que copiaste (la que termina en `/exec`)
3. Guarda. Railway reinicia la app sola.

## Listo
- Aparecerá el botón **"☁️ Respaldar a Google Sheets"** en la pestaña Productos.
- Cada vez que registres un movimiento, producto o medición, la hoja se actualiza sola
  (a los pocos segundos). También puedes forzarlo con el botón.
- La hoja tendrá 3 pestañas: **Productos**, **Movimientos**, **Mediciones**, siempre con
  los datos actuales (se reescriben en cada respaldo).

## Notas
- La URL es secreta: no la compartas. Cualquiera con esa URL podría escribir en la hoja.
- Si algún día cambias el script, debes hacer **Implementar → Gestionar implementaciones →
  editar → Nueva versión** para que tome los cambios.
