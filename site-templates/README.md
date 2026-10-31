# Plantillas de webs

Ejemplos que el superadmin puede importar en **Plataforma → Plantillas web → Importar ejemplos**.
Cada plantilla es un `.html` y un `.json` con el mismo nombre (nombre, descripción y campos editables).

Marcadores:

| Marcador | Qué pone |
|---|---|
| `{{clave}}` | el valor de un campo editable declarado en `fields` (siempre escapado) |
| `{{empresa}}` | nombre de la empresa |
| `{{#productos}} … {{/productos}}` | repite el bloque por cada producto activo |
| `{{nombre}} {{descripcion}} {{precio}} {{imagen}} {{id}}` | datos del producto (dentro del bloque) |
| `{{comprar}}` | botón «Agregar al carrito» (o «Agotado») |
| `{{carrito}}` | botón del carrito; si la plantilla no lo pone, se añade flotante |

Tipos de campo: `text`, `textarea`, `image` (URL o imagen subida), `url` (solo http/https), `color` (#rrggbb).
El carrito y el pago los añade la plataforma (`public/site-shop.js`); la plantilla no necesita JavaScript.
