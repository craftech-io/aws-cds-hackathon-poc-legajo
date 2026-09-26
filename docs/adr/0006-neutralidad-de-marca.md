---
status: accepted
---

# Marca neutral: "Legajo listo · Powered by Craftech", datos ficticios, ningún cliente nombrado

El CTO fijó que la POC no use datos ni dependa de ninguna empresa real del mercado de software aduanero y que no nombre a ningún cliente de Craftech. Decidimos que la marca pública sea **Legajo listo** con "Powered by Craftech"; que la narrativa pública sea "a coordination agent for customs brokerage firms (estudios de despachantes de aduana) in Latin America"; que el remitente que ven las partes sea el estudio (ficticio) "vía Legajo listo"; y que todo nombre de empresa, buque, transportista y entidad del seed sea inventado y rotulado "ficticio". Ningún archivo, commit, texto de la landing ni PDF nombra a un cliente de Craftech.

## Considered options

- **Co-branding con una empresa del mercado**: exige su autorización escrita y ata la submission a su marca.
- **Marca de Craftech sola**: el producto necesita un nombre que un estudio entienda.
- **Nombre de producto propio y neutral** (elegida).

## Consequences

- Una lista de términos prohibidos vive fuera del repo (secreto de GitHub `FORBIDDEN_TERMS`); CI y `security` la corren sobre todo el árbol y el seed.
- El display name de WhatsApp lo decide el CTO al conectar la WABA (P-04): Meta revisa la relación entre la marca y la empresa.
- Si el nombre cambia, cambian el subdominio, la identidad SES y `copy/`; el código no lo nombra en ningún otro lugar.
