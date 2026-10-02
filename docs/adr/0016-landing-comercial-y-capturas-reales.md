---
status: accepted
---

# Landing comercial que muestra el producto real: capturas automatizadas y renders con componentes reales, con manifiesto

Decisión del CTO del 2026-09-26: la landing vende el producto a un cliente futuro (problema, qué hace, para quién, cómo se integra, impacto como **metas rotuladas**, qué es simulado) y lo **muestra** con imágenes del producto real, con la esencia de la landing de la POC anterior de Craftech (habla del producto, lo muestra con capturas reales, dice qué es real y qué simulado, galería con zoom) pero con identidad visual propia, transiciones animadas con propósito y buena lectura de 360 a 1440+ px. El diseño visual y el guion de secciones son de `docs/landing-spec.md` (diseñador UI/UX); este ADR fija la arquitectura: rutas, carga, animación, origen de cada imagen y cómo se verifica. Estándar: skill `poc-landing` del workspace; neutralidad de textos, ADR-0014.

## 1. Rutas y carga

| Ruta | Qué | Carga |
|---|---|---|
| `/` | Landing es/en (conmutador; `?lang=en` o `localStorage`, con `try/catch`) | Chunk propio sin la consola, sin tRPC ni el SDK de Cognito |
| `/signup` | Alta (ADR-0015 §1; un solo flujo, sin lista de espera, §1.4) | Chunk propio; se abre siempre con **navegación completa** (enlaces `<a href>` que el router no intercepta) para que WAF desafíe el documento; sin SDK de WAF (ADR-0015 §3.3) |
| `/login` | Ingreso, "Olvidé mi contraseña" (código + contraseña nueva), aviso de cupo lleno | Chunk de auth (existente) |
| `/app/*` | Consola | Carga diferida (`import()` por ruta) |
| `/legal/privacy.html`, `/legal/terms.html` | Estáticas es/en con versión y fecha (ADR-0015 §8) | HTML puro |

CTAs: **"Probar la demo" / "Try the demo"** (el único CTA de alta, siempre el mismo: ADR-0015 §1.4) → `/signup` con navegación completa (conserva los parámetros `utm_*`); **"Ingresar" / "Sign in"** → `/login`; **"Hablemos" / "Let's talk"** → la URL de contacto de Craftech, una sola constante `CRAFTECH_CONTACT_URL` en `packages/web/src/views/landing/links.ts` (el operador confirma el valor; nueva pestaña con `rel="noopener"`). Pie: "Legajo listo · Powered by Craftech", legales y aviso "datos 100 % sintéticos".

`robots`: un único `packages/web/public/robots.txt` estático, igual en todo deploy: `/` y `/legal/` indexables; `Disallow` para `/app/`, `/signup`, `/login`, `/forgot` y `/welcome`, que además llevan `<meta name="robots" content="noindex">`.

Presupuesto: el de `docs/landing-spec.md` §5.3, que es la fuente única (LCP < 2,5 s con el `h1` del hero como elemento LCP, CLS < 0,05, INP < 200 ms medidos con Lighthouse sobre `poc` en la verificación post-deploy; JS propio de landing y acceso ≤ 90 KB gzip y runtime de terceros —React, zod, tRPC, en chunks `vendor-*`— ≤ 100 KB gzip con su propio tope, CSS ≤ 35 KB y fuente ≤ 45 KB verificados en CI por `scripts/landing/bundle-budget.ts`; la separación del runtime se decidió al integrar la etapa A2 porque React 19 solo ya ocupa dos tercios de 90 KB); el hero no tiene imagen raster (el teléfono es HTML/CSS); las imágenes bajo el pliegue van con `loading="lazy"` y `decoding="async"`. Sin fuentes ni scripts de terceros; sin analítica. Metadatos `title`, `description`, Open Graph (una captura real como imagen) y `hreflang` es/en; `robots` como arriba (estático, sin variante por stage ni por estado del alta, ADR-0015 §1.4).

## 2. Animación

- Solo `transform` y `opacity`; `IntersectionObserver` para los reveals y el recorrido; scroll-driven animations de CSS donde el navegador las soporte, con el mismo resultado final sin ellas; View Transitions para el cambio de paso del recorrido cuando exista la API.
- **Sin librería de animación**: todo lo pedido (reveals, recorrido sticky, chat que se escribe solo, contadores) cabe en CSS + un hook `useInView` y un hook `useTypewriter` en `views/landing/motion/`. Agregar una librería requiere justificarla en este ADR.
- Recorrido del producto: en ≥ 1024 px, columna de texto con pasos y un visor **sticky** cuya imagen o render cambia con el paso visible; en < 1024 px, pasos apilados con su imagen debajo de cada uno. El mismo arreglo de pasos (`views/landing/tour-steps.ts`) alimenta las dos formas.
- `prefers-reduced-motion: reduce`: sin transiciones ni escritura progresiva; cada render muestra su estado final; los contadores muestran el valor final. Todo el contenido es legible sin animación y sin JS de animación.
- Las cifras de "Impacto" son **metas rotuladas** ("meta", "supuesto") desde `copy`, nunca métricas de la demo presentadas como resultados.

## 3. De dónde sale cada imagen

Un solo contrato, en dos archivos, con el detalle y la lista completa en `docs/landing-spec.md` §7.3 y §7.4 (que lo repiten tal cual). Tres estados posibles de una entrada de `packages/web/public/landing/manifest.json` (**versión 2**, lista `entries`, una entrada por par `id` + `viewport`):

| Estado | Qué es | Rótulo visible en la leyenda (claves de `copy`, `docs/landing-spec.md` §2.10) | Dónde puede ir |
|---|---|---|---|
| `capture` | Captura de la consola o de una página real servida | Origen `poc`: ninguno; origen `local`: "Entorno local, agente guionado" / "Local environment, scripted agent" (`gallery.localNote`) | Galería, escenario del recorrido, "Ampliar", Open Graph |
| `render` | Componente animado de la landing hecho **con componentes y textos reales del producto** (p. ej. `WhatsAppPhone`, `EmailThread`, plantillas de `packages/bff/src/copy/`) para una vista que todavía no existe en la consola, o que queda por diseño (política `zoom`) | "Animación con los componentes y textos del producto" / "Animation built with the product's components and texts" (`gallery.renderNote`) | Hero y escenario del recorrido como componente vivo; su `png` es el cuadro estático de "Ampliar" y de reduced motion |
| `placeholder` | Imagen provisoria | "Imagen provisoria" | Solo si no hay otra salida; **nunca** en el hero ni como `og-card`. La lista de `docs/landing-spec.md` §7.3 no usa ninguno |

Nunca un mockup que muestre una función que el producto no tiene. Cada `render` y cada `placeholder` declara qué captura real lo reemplaza.

**Esquema de una entrada** (`packages/web/src/views/landing/manifest.ts`, zod `.strict()`):

`{ id, status, origin?: "poc" | "local", viewport: "desktop" | "mobile", sources: {avif: [{src, w}], webp: [{src, w}], png: {src, w, h}}, capturedAt?, commit?, component? (ruta del componente del render), textSources? (claves de copy o plantillas que usa), replacedBy? (id de la captura que lo reemplaza), replaceIn? (WP que construye la vista) }`

Reglas del esquema: `capture` ⇔ tiene `origin`, `capturedAt` y `commit`; `render` ⇔ tiene `component`, `textSources`, `replacedBy` y `replaceIn`; `placeholder` ⇔ tiene `replacedBy` y `replaceIn`; cada estado rechaza los campos de los otros. `src` valida `^/landing/[a-z0-9-]+/(desktop|mobile)(-\d+)?\.(avif|webp|png)$`. El momento del mundo de una captura no va en el manifiesto: vive en `scripts/landing/captures.json`.

**Manifiesto de renders** `scripts/landing/renders.json` (fuera de `public/`; es la lista que pidió el CTO): un objeto por render con `component`, `textSources`, `replacedBy`, `replaceIn` (los mismos valores que su entrada del manifiesto), `reason` (por qué hoy es un render), **`policy`** y **`until`**:

| `policy` | Qué pasa cuando `replacedBy` ya es `capture` de origen `poc` |
|---|---|
| `swap` | La captura pasa a ser el visual principal del paso (el render puede quedar como animación de entrada de 1,5 s sin reduced motion) y la entrada `render` sale del manifiesto y de `renders.json` **en el mismo commit** |
| `zoom` | El render queda **por diseño** (el canal es simulado, o la vista combina dos partes) y "Ampliar" abre la captura; nunca se saca |

`until`: el criterio de reemplazo en texto, con su escenario y su WP (p. ej. "`SC-24` en verde en `poc` y `console-dossier-reading` con origen `poc` (WP-36)"). Una captura de origen `local` nunca dispara el reemplazo: en la etapa A2 todas las capturas son `local` y todos los renders siguen.

## 4. Pipeline de capturas

| Script | Qué hace |
|---|---|
| `scripts/landing/capture-console.ts --target poc` | Playwright (Chrome instalado) contra `https://legajo.demo.craftech.io` **únicamente** (cualquier otra `--base-url` se rechaza; cierra el hallazgo abierto de la ola 5), login real con la cuenta sintética `guest-test` (`GUEST_TEST_PASSWORD` desde el entorno, nunca impreso), después de una corrida real del recorrido (`SC-24`); origen `poc` |
| `scripts/landing/capture-console.ts --target local` | Servidor de UI local (Vite + `appRouter` real sobre el mundo sintético en memoria, con los momentos de `tests/ui-server/moments/`); origen `local` |
| `scripts/landing/render-visuals.ts` | Páginas reales servidas localmente (link de carga, `og-card` de la propia landing) y el cuadro estático (`png`) de cada render, es y en |
| `scripts/landing/encode.ts` (nuevo) | PNG → AVIF (calidad 50) y WebP (calidad 80) con `sharp` (dependencia nueva de desarrollo, versión estable exacta declarada en el WP) en los anchos de `docs/landing-spec.md` §5.3: **480, 960, 1440 y 1920** (desktop) y **390 y 780** (mobile); escribe `sources` |
| `scripts/landing/manifest-file.ts` (existente, se amplía) | Escribe y actualiza las entradas del manifiesto v2 |
| `npm run landing:renders` | Imprime id → `replacedBy` → estado actual de esa captura → `policy` → `until`, para el reporte de `qa` y el plan |

- Viewports: desktop 1440 × 900 y mobile 390 × 844, `deviceScaleFactor` 2, `reducedMotion: "reduce"`, zona horaria de Buenos Aires, tema claro, animaciones deshabilitadas.
- Cada frame pasa `frame-check.ts` **antes** de escribirse: `FORBIDDEN_TERMS` (falla cerrado), palabras de ADR-0014 (importadas de `scripts/lint/neutral-words.ts`), JWT, claves de AWS, links de carga con token y cualquier email que no sea `*@sim.legajo.demo.craftech.io` o del dominio del app.
- Toda petición fuera del objetivo (y de Cognito en `poc`) se aborta y hace fallar la corrida.
- Las imágenes se versionan en `packages/web/public/landing/` con el manifiesto; el operador corre `--target poc` después de un deploy con el recorrido en verde y commitea el resultado.

`npm run landing:check` (CI, dentro de los checks de §18 de `docs/architecture.md`): el manifiesto valida con zod; todo `id` que usa la landing existe con sus archivos; todo `render` del manifiesto figura en `renders.json` con el mismo `component`, `textSources`, `replacedBy` y `replaceIn`, y viceversa; **un render con `policy: "swap"` cuyo `replacedBy` ya existe como `capture` de origen `poc` falla** (hay que sacarlo); un render `zoom` nunca falla por eso; ningún `placeholder` en el hero ni en `og-card`; todo `alt` y toda leyenda existen en `copy` es y en.

## 5. Galería

Lightbox accesible (existente, se adapta): `dialog` modal con foco atrapado y devuelto, teclado (flechas, Escape), swipe, `<picture>` con AVIF/WebP y leyenda con el rótulo de §3; zoom hasta el tamaño natural de la captura.

## Considered options

- **Imágenes diseñadas a mano**: más lindas, pero prometen lo que la consola no hace y envejecen con cada cambio de UI.
- **Video embebido como recorrido**: pesado para móvil y no se actualiza con el producto; el video de la submission es otra pieza.
- **Librería de animación**: agrega peso al chunk de la landing para efectos que CSS e `IntersectionObserver` ya resuelven.

## Consequences

- Cada vez que cambia una vista de la consola que aparece en la landing, se vuelven a correr las capturas; `landing:check` obliga a sacar los renders `swap` a medida que sus vistas se capturan en `poc` (olas 3 a 5); los `zoom` quedan.
- El recorrido animado depende de `copy/` real: si cambia una plantilla, cambia la landing en el mismo PR.
- La landing es la primera superficie que ve un prospecto: `qa` la prueba en 360, 390, 768, 1024 y 1440 px, con y sin `prefers-reduced-motion`, en es y en.
