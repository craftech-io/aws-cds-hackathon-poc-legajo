---
status: accepted
---

# El agente se comunica solo por tools; el texto final del turno es una nota interna

Casi todos los turnos del agente nacen de eventos que no son un mensaje a responder (un hito, una lectura, un rebote, un cambio de ETA) y un mismo turno puede tener que escribirle al proveedor en inglés y al importador en español. Decidimos que **todo mensaje salga por `send_whatsapp` o `send_email`**, con `kind` y `refs` estructurados, y que el texto final del Harness sea una **nota del turno** que va a la bitácora y a la consola y nunca se envía.

## Considered options

- **Responder con el texto final del turno, como un chat**: sirve para un solo destinatario y un solo canal, y deja el mensaje sin estructura (tipo, observaciones, documentos) para la política y las pruebas.
- **Mezclar las dos cosas**: arriesga el doble mensaje.

## Consequences

- La política, G2, la verificación determinista y el cerco corren en un solo lugar: el pipeline de salida que usan las tools y los mensajes del estudio.
- Las pruebas asiertan mensajes estructurados (`kind`, `refs`, destinatario), no redacciones del modelo.
- La nota del turno le explica al estudio qué decidió el agente y por qué.
