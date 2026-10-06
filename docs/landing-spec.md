# Spec · landing comercial y pantallas públicas de acceso

Especificación implementable de la landing (`/`), del alta propia (signup), del ingreso (login), de la recuperación de
contraseña, del cierre de sesión y de los estados del "mundo invitado". Aplica el estándar de Craftech para superficies
públicas de POCs (skill del workspace `poc-landing`, `../.claude/skills/poc-landing/SKILL.md` en el workspace de Craftech; no
se copia al repo) y la decisión del CTO del 2026-09-26. Reemplaza, para las superficies públicas, lo que dicen
`docs/design-brief.md` §7 y §7.1 sobre el botón y las cuentas de evaluadores.

Idioma de este doc: español (Argentina). Los textos visibles van en §2 y §8, en es-AR y en inglés.

## 0. Marco, alcance y decisiones

### 0.1 Reglas duras que esta spec aplica

| # | Regla | Dónde se hace cumplir |
|---|---|---|
| R-01 | La POC publicada es un **producto para un cliente futuro**. Ninguna superficie visible nombra el concurso ni su vocabulario (lista en §2.0). La palabra "evaluación" no aparece en ninguna superficie visible, ni siquiera con otro sentido | `npm run lint:neutral-surfaces` sobre fuentes visibles y `dist` (§5.6) |
| R-02 | El rol pensado para quien prueba la demo es **`GUEST`** ("Invitado" / "Guest"); usuarios `guest-NN`; comportamiento igual al rol anterior | Código, infra, seed, tests y docs (renombre en el WP de superficies públicas) |
| R-03 | Marca pública "Legajo listo · Powered by Craftech". Empresas y personas **ficticias** (las del seed); ningún cliente de Craftech ni empresa real del mercado | `npm run lint:forbidden` (lista externa) |
| R-04 | Métricas solo como **metas** o **supuestos** rotulados; nunca como resultados de producción | Copy de §2.7 y test de copy (§5.6) |
| R-05 | Capturas solo del producto real; donde una vista no existe todavía, **render animado** con los componentes y textos reales, rotulado y listado en el manifiesto con la captura que lo reemplaza (§7) | `manifest.ts` (zod) + test del manifiesto |
| R-06 | Signup = alta de invitado **y** captación de lead con consentimientos separados, sin tildar, versionados (§8) | BFF + tabla `Leads` + tests |
| R-07 | Tailwind v4 con `@theme`; sin hex en JSX; archivos ≤ 400 líneas; feature-based; sin librerías de estado | `npm run lint` |

### 0.2 Qué hay hoy (punto de partida)

| Pieza | Estado en la rama | Qué hace esta spec |
|---|---|---|
| `packages/web/src/views/landing/` | Landing de la etapa anterior: escenas de la operación 4471 con textos reales (`conversations.ts` arma cada plantilla desde `@legajo/bff/copy`), `WhatsAppPhone`, `EmailThread`, `SceneVisuals`, `Lightbox` (`<dialog>` nativo con teclado y swipe), `gallery.tsx`, `manifest.ts`, `lang.tsx`, copy es/en | Se **rediseña**: se conservan los datos y componentes que muestran texto real (conversaciones, hilo de email, lecturas, hitos de ETA, decisiones), el `Lightbox`, la galería y el manifiesto (ampliado, §7.4). Se reemplazan layout, estilo, secciones y copy. Se eliminan el botón bilingüe de evaluadores, la sección de evaluadores y toda mención del concurso |
| `packages/web/src/views/login/` | Login SRP propio, MFA TOTP opcional para cuentas del estudio, cambio de contraseña inicial; copy solo en es-AR y con referencias al rol anterior | Se agrega es/en, signup, verificación por código, recuperación y estados de mundo (§8); se quita toda mención del rol anterior |
| `public/legal/privacy.html`, `terms.html` | Legales de la demo | Se reescriben con responsable, finalidad, retención, baja y borrado (Ley 25.326) y versión de texto (§8.9) |
| `public/landing/manifest.json` | Solo `upload-page` y `upload-done` (renders) | Se amplía con capturas de consola y renders animados (§7) |
| Consola (`/app/*`) | Vistas `operations`, `dossier`, `escalations`, `registry`, `simulator`, `mailbox`, `clock`, `metrics`, `audit` y el panel `tour` existen en la web; buena parte de sus mutaciones no está cableada en el BFF (ola 3 sin construir) | Las capturas se toman con el servidor local de UI y el mundo sintético determinista hasta que la vista funcione en `poc` (§7.2) |

### 0.3 Decisiones de esta spec

| # | Decisión | Por qué |
|---|---|---|
| D-01 | Rutas públicas: `/` landing, `/signup`, `/signup/verify`, `/login`, `/forgot`, `/forgot/reset`, `/welcome` (preparando tu mundo), `/legal/privacy.html`, `/legal/terms.html`. La consola sigue en `/app/*` | Una URL por pantalla: se pueden compartir, capturar y probar con Playwright |
| D-02 | Idioma: `?lang=es` o `?lang=en` gana; si no, la última elección del visitante (`localStorage`, con `try/catch`); si no, el idioma del navegador: español si `navigator.languages` trae cualquier `es*`, inglés en cualquier otro caso (`browserLang()` en `packages/web/src/lib/preferred-lang.ts`, fuente única junto con la clave `legajo.lang`; la usan la landing, el acceso y la consola). `<html lang>` = `es-AR` o `en`. El selector `ES \| EN` (`components/LangToggle.tsx`) vive en el header de la landing y de las pantallas de acceso: muestra el idioma **actual** relleno, cada opción es un botón con `aria-pressed` y `aria-current`, de 44 px, dentro de un grupo rotulado (`lang.label`). Bajo 768 px va dentro del menú | Visitantes de LatAm y de habla inglesa; el idioma elegido viaja al lead (§8.2) |
| D-03 | La landing es parte del bundle de la web, pero **cargada aparte**: `LandingView` y las pantallas de acceso en un chunk; la consola en otro (`React.lazy`), así el LCP de `/` no paga la consola | Presupuesto de performance (§5.5) |
| D-04 | "WhatsApp" se nombra solo como el **canal** (uso nominativo, igual que la documentación de AWS End User Messaging Social); sin logo ni colores de marca de terceros; el teléfono se dibuja con un estilo propio, marcado "simulador" | La skill pide marca neutra; el canal es parte de la propuesta de valor y no puede omitirse |
| D-05 | Servicios de AWS se nombran por su nombre oficial en la sección de integración, sin logos de AWS en la landing | Sección técnica honesta sin sugerir un aval |
| D-06 | Ninguna animación depende de una librería: CSS (scroll-driven animations con `@supports`), `IntersectionObserver` y View Transitions con fallback. Sin dependencias nuevas | Regla de dependencias de la ola 0 y presupuesto de JS |
| D-07 | Tipografía: una sola fuente variable autoalojada para títulos (subset latin + latin-ext, `woff2`) y la pila del sistema para el cuerpo | LCP y CSP (sin Google Fonts en runtime) |
| D-08 | El botón "Hablemos" va a la página de contacto pública de Craftech (§9), en una pestaña nueva, con UTM | Verificado el 2026-09-26 |
| D-09 | El recorrido guiado de la consola (`views/tour`) no cambia de lógica; cambia su copy para el rol `GUEST` y deja de hablar de "cuentas asignadas" | El invitado se da de alta solo |
| D-10 | La landing no muestra precios ni promete fechas de disponibilidad comercial; sí explica **de qué depende el costo** y cuál es el paso siguiente (FAQ, §2.13) | Es una demo; lo comercial va por "Hablemos", pero una objeción sin respuesta hace perder al visitante |
| D-11 | **Una sola alta pública, sin modos.** No hay modo "lista de espera" ni ninguna variante de la landing o del alta por stage: el CTA primario es siempre "Probar la demo" / "Try the demo" (punto 5 del CTO), la landing es siempre indexable y toda alta verificada por código termina en un mundo de invitado. Cuando el tope de mundos de invitado activos está lleno, la cuenta y el lead verificado existen igual y `/welcome` muestra el estado `CAPACITY` ("La demo está completa en este momento" + "Hablemos") sin crear mundo; el próximo ingreso reintenta. Detalle en §8.0 y §8.5 | Los deploys de `poc` son por ola, pero la URL no se comparte hasta que el producto completo (olas 3 a 6) está desplegado y probado. Una lista de espera guardaría consentimiento de contacto de direcciones sin verificar (inválido bajo la Ley 25.326) y cambiaría el CTA que eligió el CTO |
| D-12 | **Mecánica del acceso = ADR-0015 y FL-101 a FL-131.** §8 fija copy y experiencia; procedimientos, estados, códigos de error, nombres de archivos, secretos y scripts se toman de ADR-0015 y de `docs/tool-catalog.md` sin renombrar. Ningún número de límites se escribe a mano en el copy ni en los tests: toda duración, tope o cantidad visible se deriva de `packages/shared/src/guest-limits.ts` (fuente única de ADR-0015 §3.2 y §4) | Una sola fuente de verdad: si WAF o las cuotas cambian, cambia un archivo y el copy lo sigue |
| D-13 | Dos audiencias: **estudios de despachantes** (compran el producto) y **plataformas de software de comercio exterior** (lo integran como módulo). La segunda tiene su bloque en `#integrations` y su CTA "Hablemos de integrarlo" | Evita que un proveedor de software lea la landing como la de un competidor |

## 1. Posicionamiento y narrativa

### 1.1 Propuesta de valor

| Pieza | Contenido (el texto exacto va en §2) |
|---|---|
| Línea de valor | Cada legajo completo antes de que llegue el buque |
| Qué es | Un agente de coordinación que persigue la factura comercial, el packing list y el certificado de origen de cada importación, habla con cada parte por su canal y en su idioma, y deja el legajo listo para que el despachante lo apruebe |
| Para quién | Estudios de despachantes de aduana de Latinoamérica (el despachante y su equipo operativo); de rebote, sus importadores y los proveedores extranjeros de esos importadores. Además, **plataformas de software de comercio exterior** que quieran sumarlo como módulo: se conecta por dos contratos (lector documental en OpenAPI 3.1; plataforma de gestión como API REST versionada) y por eventos (§1.8, bloque "Para plataformas") |
| Qué no es | No clasifica mercadería, no valora, no liquida tributos, no asesora en materia aduanera, no lee documentos por su cuenta y **no aprueba**: aprobar es siempre de una persona |
| Prueba | "Probar la demo": en dos minutos, un estudio ficticio propio con la operación 4471 lista para recorrer |

### 1.2 Arco narrativo (orden de las secciones)

| # | Sección | Ancla | Pregunta del visitante que responde | Visual |
|---|---|---|---|---|
| 1 | Hero | `#top` | ¿Qué es y para quién? | Teléfono con la conversación que se escribe sola (§4.4) + CTA |
| 2 | El problema | `#problem` | ¿Por qué me duele hoy? | 3 tarjetas con ícono lineal y una línea de tiempo "buque en camino" que se llena al hacer scroll |
| 2.1 | Video del producto | `#video` | ¿Cómo se ve funcionando? | El video de la submission (2 min, narrado en inglés con subtítulos en la imagen), servido desde `public/landing/video/` con póster, sin reproducción automática y con `preload="none"`: no pesa en el presupuesto de la carga inicial (§5.3). Su texto respeta la voz de producto (sin "demo" ni "simulado") |
| 3 | Recorrido del producto | `#tour` | ¿Cómo lo hace, paso a paso? | Scrollytelling de 8 pasos con escenario fijo (desktop) o carrusel (mobile) (§4.3) |
| 4 | Qué hace, por actor | `#capabilities` | ¿Qué gana cada uno? | 3 columnas: importador, proveedor extranjero, estudio |
| 5 | Lo que garantiza el código | `#guarantees` | ¿Puedo confiar en un agente? | 6 garantías con la regla que las hace cumplir (chips de regla reales) |
| 6 | Impacto | `#impact` | ¿Qué gano? | 4 contadores: 3 metas del comprador medibles en la consola (rótulo "Meta") y 1 garantía en código |
| 7 | Cómo se integra | `#integrations` | ¿Con qué se conecta y dónde corre? | Diagrama de 4 carriles (partes → entrada → agente → salida y datos) + bloque "Para plataformas de comercio exterior" |
| 8 | Qué es simulado en esta demo | `#demo` | ¿Qué es real acá? | Tabla de 4 columnas: real / implementado en modo simulado / sistemas simulados / datos |
| 9 | Preguntas frecuentes | `#faq` | ¿Dónde quedan mis datos? ¿Y si no tengo lector? ¿Qué necesito para WhatsApp? ¿Cuánto cuesta? | 6 preguntas en `<details>` (§2.13) |
| 10 | Galería | `#gallery` | ¿Cómo se ve la consola? | Grilla de capturas reales con zoom (§6) |
| 11 | CTA final | `#start` | ¿Cómo lo pruebo? | "Probar la demo", "Ingresar", "Hablemos" y "Powered by Craftech" |

El header fijo muestra: wordmark "Legajo listo", enlaces a `#tour`, `#guarantees`, `#integrations`, `#architecture`, `#faq`
(≥ 1280 px), selector `ES | EN`, "Ingresar" (enlace) y el CTA primario (botón "Probar la demo"). En < 1280 px los enlaces van a un menú (`<details>` o botón con `aria-expanded`), y el CTA primario sigue
visible. **Scroll-spy**: el enlace de la sección que cruza una banda delgada a un tercio de la pantalla (un
`IntersectionObserver`, sin librería, `views/landing/scroll-spy.ts`) lleva `aria-current="location"` y un relleno
visible; mientras la banda está sobre una sección sin enlace (hero, problema, video…) ninguno lo lleva.

### 1.3 Los 3 dolores

| # | Dolor | Qué pasa hoy | Qué cambia |
|---|---|---|---|
| 1 | Persecución manual | El despachante persigue por su WhatsApp personal; el importador reenvía emails al proveedor; nadie sabe qué se pidió, a quién ni cuándo | El agente pide lo que falta en el momento justo (hitos relativos a la ETA), por el canal de cada parte, y deja todo en la línea de tiempo |
| 2 | Correcciones tardías y sin dueño | Un peso que no coincide aparece con el buque en puerto, y el importador recibe un problema que no es suyo | Cada PDF pasa por el lector documental al llegar; el agente asigna responsable y le pide la corrección a quien corresponde, el mismo día |
| 3 | La ETA se mueve y los plazos quedan viejos | Nadie recalcula; el riesgo de almacenaje y demora no se ve | Un evento del transportista reprograma todos los hitos en el código; el riesgo se estima con supuestos rotulados |

### 1.4 Recorrido del producto (8 pasos)

Sigue la historia de la operación 4471 (`docs/design-brief.md` §4 y §14; seed `docs/seed-spec.md`): "Estudio Delta"
(estudio ficticio), "Norpampa Insumos SRL" (importador ficticio), "Qingdao Bluewave Textiles Co., Ltd." (proveedor
ficticio), buque ficticio "Austral Aurora", ETA 22/10. Cada paso cambia el visual con una transición (§4.3). Los textos
de WhatsApp y de email salen de `@legajo/bff/copy` (fuente única); lo que escribe el modelo en un turno real se rotula
"ejemplo de texto del agente".

| # | Paso | Actor que mira | Lo que se muestra | Visual (id del manifiesto, §7) |
|---|---|---|---|---|
| 1 | El primer pedido | Importador (WhatsApp) | Hito ETA − 7: llega la plantilla aprobada con lo que falta y 4 botones (subir documentos, que los mande el proveedor, hacer una pregunta, dejar de recibir avisos) | `tour-request` (render animado del teléfono) |
| 2 | "Los manda el proveedor" | Importador (WhatsApp) | Delega con un botón, confirma el contacto registrado; la política difiere el email por el horario del proveedor y el agente lo avisa | `tour-delegate` (render animado del teléfono + chip `CP-HOURS-SUPPLIER`) |
| 3 | Lo que recibe el proveedor | Proveedor (email en inglés) | Email en inglés desde la dirección de la operación; el proveedor responde por email con los PDFs, en el mismo hilo | `tour-supplier` (hilo de email) → captura `console-mailbox` |
| 4 | Lo que encuentra el lector | Estudio (consola) | El lector documental externo devuelve: certificado válido; packing list con peso bruto 12.480 kg contra 12.840 kg de la factura | `tour-reader` (tarjeta de lectura) → captura `console-dossier-reading` |
| 5 | Quién corrige | Proveedor e importador | El agente asigna el responsable (el proveedor), pide la corrección en el hilo y al importador le dice "no tenés que hacer nada"; con la versión 2 el legajo queda listo para revisión | `tour-owner` (hilo + teléfono) → capturas `console-dossier` y `console-simulator` |
| 6 | La ETA se adelanta | Estudio (consola) | El transportista informa 22/10 → 20/10; el código reprograma los hitos sin pasar por el modelo; el agente avisa el nuevo plazo | `tour-eta` (tabla de hitos antes/ahora) → captura `console-clock` |
| 7 | Escalamiento al despachante | Estudio (email + consola) | "¿Qué posición arancelaria va?" es asesoramiento: el guardrail bloquea antes del modelo, sale la respuesta fija, el caso pasa al estudio (plantilla `legajo_escalado`) y el despachante recibe el email de escalamiento | `tour-escalation` (teléfono + email del estudio) → captura `console-escalations` |
| 8 | Aprobación humana | Despachante (consola) | Con los tres documentos válidos, el despachante revisa y aprueba con un ingreso reciente; ninguna herramienta del agente puede aprobar; el importador recibe el aviso; después, canal y liberación | `tour-approval` (controles de aprobación) → captura `console-dossier-approval` |

### 1.5 Qué hace, por actor

| Actor | Qué gana | Capacidades |
|---|---|---|
| Importador | Sabe qué le toca y qué no | Pedido por WhatsApp con botones; link de carga sin login; delegar al proveedor con un toque; respuestas a dudas con el checklist del estudio; "no tenés que hacer nada" cuando la corrección es de otro; baja de avisos cuando quiera |
| Proveedor extranjero | Un pedido claro, en inglés, en su horario | Email en inglés desde la dirección de la operación; correcciones concretas en el mismo hilo; nunca fuera de su horario laboral |
| Estudio (despachante y equipo) | Legajos completos antes del arribo, con el motivo de cada paso | Operaciones con su próximo evento; detalle del legajo con lecturas, observaciones y responsables; escalamientos por motivo; tomar la conversación; aprobar; métricas con N y rótulo; bitácora de decisiones con su regla |

### 1.6 Garantías en código

| Garantía | Cómo se cumple (sin nombrar archivos en la landing) | Chip de regla real |
|---|---|---|
| La aprobación es siempre humana | No existe una herramienta que apruebe; la política del agente lo deniega y la consola pide un ingreso reciente | `CED-NO-APPROVE` |
| La política de contacto vive en el código | Opt-in, ventana de 24 h, horario de cada parte, un recordatorio por día: se decide antes de cada envío | `CP-OPTIN`, `CP-HOURS-AR`, `CP-HOURS-SUPPLIER`, `CP-ONE-PER-DAY` |
| Nadie recibe un dato ajeno | Cerco de destinatarios por perfil de remitente; ningún saliente lleva enlaces ni contactos ajenos | `CP-NO-FOREIGN-LINKS` |
| La lectura de documentos no es nuestra | Cada PDF va al lector documental por su contrato; lo desconocido va al despachante | — |
| La identidad no la decide el modelo | Teléfono registrado del importador; dirección de la operación, contacto confirmado y DMARC del proveedor | — |
| Todo lo entrante es hostil | Datos sensibles enmascarados antes de guardarse; texto aislado y filtrado por un guardrail antes del modelo | — |

Los chips usan `RuleChip` con el id real (`@legajo/shared`), así un id que desaparezca rompe el typecheck.

### 1.7 Impacto: metas y supuestos rotulados

La sección habla del **resultado que busca el comprador**, no de las garantías (esas ya están en el hero, en
`#guarantees` y en el paso 8). Ningún número se presenta como resultado: cada tile es una **meta** rotulada que la
consola mide en cada mundo con su N (`docs/design-brief.md` §8), salvo una sola garantía en código.

| Tile | Valor | Rótulo | Nota (cómo se mide en la consola) |
|---|---|---|---|
| Legajo completo antes del arribo | 72 h | Meta | Los tres documentos válidos al menos 72 horas antes de la ETA vigente. KPI "% completos ≥ 72 h antes del arribo", con su N |
| Cada corrección, pedida a su responsable | El mismo día | Meta | Desde que llega el PDF, la observación se asigna a quien la tiene que corregir y se le pide ese día. La línea de tiempo del legajo muestra la hora de la lectura y la del pedido; el KPI "% observaciones al responsable correcto" lleva su N |
| Una sola historia por operación | 100 % | Meta | Cada pedido, respuesta, lectura y decisión en una sola línea de tiempo por operación, con su motivo. Se ve en el detalle del legajo y en la bitácora |
| Aprobaciones hechas por una persona | 100 % | Garantía en código | Ninguna herramienta del agente puede aprobar (única garantía de la sección) |

Nota al pie (`impact.footnote` + `impact.assumptions`): "Los números de tu demo se miden en la consola, con su N, su
fuente y su rótulo: medido, agente guionado o supuesto. El riesgo de demora se estima con supuestos editables por
estudio (días libres en puerto, USD por día y por contenedor)." Sin cifras de días libres ni de USD en la landing, y sin
la frase "no verificada": esas cifras son supuestos de la consola, rotulados allí (`docs/design-brief.md` §1). No se
muestra ningún porcentaje de ahorro de tiempo ni de costo.

Números permitidos en `#impact` (lista de `landing.test.ts`): `72` y `100`. "El mismo día" es texto, no contador.

### 1.8 Cómo se integra

| Carril | Nodo | Estado en la demo |
|---|---|---|
| Canales | WhatsApp por **AWS End User Messaging Social** (plantillas aprobadas, botones, documentos) | Implementado, en modo simulado |
| Canales | Email por **Amazon SES** (envío y recepción, DMARC, hilo por operación) | Real, de punta a punta |
| Canales | Link de carga sin login (URL prefirmada a S3, escaneo de malware) | Real |
| Agente | **Amazon Bedrock AgentCore** (Harness, Gateway con herramientas, Policy, Memory) + **Amazon Bedrock Guardrails** | Real |
| Tiempo | **Amazon EventBridge Scheduler** (hitos relativos a la ETA) y bus de eventos (transportista, aduana) | Real; transportista y aduana simulados |
| Documentos | **Lector documental** externo detrás de un contrato **OpenAPI**: el que elija el estudio; si todavía no usa ninguno, Craftech adapta el elegido durante el piloto | Contrato real; lector simulado |
| Sistema del estudio | Conector por contrato (API REST versionada `/v1`, con schema zod) a la plataforma de gestión del estudio, adaptado a cada estudio | Contrato real; plataforma simulada |
| Base | **Serverless** en AWS: Lambda, SQS FIFO por operación, DynamoDB, S3, Cognito, CloudFront; todo por infraestructura como código | Real |

Tres mensajes de venta bajo el diagrama, **los mismos en §1.8 y §2.8**: "Sin servidores que administrar",
"Conectores por contrato", "Todo por infraestructura como código". La landing no dice dónde se despliega para
cada cliente (en la cuenta de AWS del estudio o en otra): ningún documento del diseño lo resuelve, y una frase sin
diseño detrás no se publica. Si `architect` registra un ADR de modelo de despliegue, el mensaje se suma acá y en §2.13.

**Bloque "Para plataformas de comercio exterior"** (dentro de `#integrations`, debajo del diagrama; D-13). Dice solo lo
que existe:

| Punto | Contenido | De dónde sale |
|---|---|---|
| Dos contratos | El lector documental se conecta por un contrato **OpenAPI 3.1** publicado; la plataforma de gestión, por una API REST versionada (`/v1`) con schema publicado. Sin "OpenAPI" para la plataforma mientras su contrato no esté escrito en OpenAPI | `packages/reader-contract/openapi.yaml`; `packages/platform-mock/src/schema.ts` y `docs/architecture-integrations.md` §6 |
| Eventos | Estados y novedades (transportista, aduana, plataforma) entran por el bus de eventos | Bus `Feeds` (`docs/architecture.md`) |
| En código | Canales, política de contacto y reglas viven en código, sobre AWS serverless | ADR-0012, §1.6 |
| Siguiente paso | "Hablemos de integrarlo": misma constante de contacto con `utm_content=platform` (§9) | §9 |

No promete marca blanca, SDK ni embebido: nada de eso está diseñado.

### 1.8.1 Cómo funciona por dentro (`#architecture`)

Primero el **diagrama conectado** (`ArchitectureDiagram`, `#architecture-diagram`) y debajo la misma arquitectura por
capas (seis tarjetas con los íconos oficiales de AWS) y los cuatro pasos de un mensaje.

| Pieza | Decisión |
|---|---|
| Fuente | El mismo `docs/assets/architecture/architecture.html` del README. `npx tsx scripts/diagram/render-architecture-public.ts` lo carga, reescribe los textos con la voz de producto y, en español, los traduce (`scripts/diagram/public-texts.ts`), y escribe `public/landing/architecture/architecture-{es,en}-{1920,3840}.webp`. Sin las etiquetas del concurso, sin el nombre del modelo ni del runtime del agente, sin "mock": un texto del HTML sin entrada en `public-texts.ts` corta el render, así que una caja nueva no sale sin traducir |
| Imagen | `<img>` de 1920 × 1380 con `width` y `height` declarados (sin salto de layout), `loading="lazy"`, `srcset` 1920/3840 y `alt` en cada idioma (`architecture.diagram.alt`, sin las palabras de `neutral-words.ts`) |
| Enlace | "Abrir en tamaño completo" / "Open full size": botón visible sobre la figura, abre el WebP de 3840 px en una pestaña nueva |
| Teléfono | La figura mantiene 1024 px de ancho dentro de una región con scroll horizontal (con aviso "Deslizá…") en vez de encogerse hasta ser ilegible |

### 1.9 Qué es simulado en esta demo

| Real | Implementado, en modo simulado | Sistemas simulados | Datos |
|---|---|---|---|
| Lista explícita, sin "todos": Amazon SES de punta a punta, Amazon Bedrock AgentCore y Guardrails, EventBridge Scheduler, SQS, DynamoDB, S3, Cognito y CloudFront | AWS End User Messaging Social (adaptador de WhatsApp), probado con fixtures; en la demo, un simulador de teléfono dentro de la consola | Lector documental, plataforma de gestión aduanera, transportista, aduana y proveedores (buzones propios) | 100 % sintéticos; estudios, importadores, proveedores, buques y personas ficticios |

Regla: **ningún servicio o sistema aparece en dos columnas** (test en `landing.test.ts`, §5.6). Cada columna es una
lista de ids en `views/landing/demo-columns.ts` (`real`, `simulatedMode`, `mocks`) de la que sale el copy de §2.9; el
test verifica que la intersección de las tres listas sea vacía y que el copy de cada idioma nombre exactamente los ids
de su columna.

### 1.10 CTA final

"Probar la demo" (primario, `/signup` por navegación completa, `<a href>`), "Ingresar" (secundario, `/login`), "Hablemos" (terciario, contacto de Craftech,
§9). Debajo: "Legajo listo · Powered by Craftech", legales, aviso de datos sintéticos. El bloque tiene una sola
versión (D-11): mismo título, mismo lead y mismo CTA primario en todo stage.

## 2. Copy deck (es-AR y en)

Fuente en código: `views/landing/copy-es.ts` y `copy-en.ts` (misma forma de tipo, una clave que falta en un idioma no
compila) y, para las pantallas de acceso, `views/auth/copy-es.ts` y `copy-en.ts` (§8). Las palabras de documentos,
estados, reglas y partes siguen saliendo de `@legajo/bff/copy` (`labelsEsAR`, `OBSERVATION_LABELS`, plantillas). Voseo
rioplatense en es-AR; inglés llano en en. Números: coma decimal y punto de miles en es-AR (`12.480 kg`), punto decimal y
coma de miles en en (`12,480 kg`), vía `lib/format`.

### 2.0 Vocabulario prohibido en superficies visibles

Fuente única: `scripts/lint/neutral-words.ts`, definida en ADR-0014 §2-§4 (grupos del concurso, sus premios, quienes
lo juzgan y la evaluación, más la frase del nombre del concurso, en español e inglés, normalizados sin acentos, por
palabra completa y con cortes de camelCase; la lista literal vive solo en ADR-0014). `lint:neutral-surfaces` y `frame-check.ts` la importan. Además de esa lista, la copia de esta spec no usa
"evaluar" (el verbo es "probar"), ni "cliente real", "caso de éxito" o "resultados" para hablar de métricas.

### 2.1 Header, idioma y navegación

| Clave | es-AR | en |
|---|---|---|
| `lang.label` (nombre del grupo `ES \| EN`; cada botón se llama "Español" o "English", con su `lang`) | Idioma | Language |
| `nav.label` | Secciones de la página | Page sections |
| `nav.tour` | Cómo funciona | How it works |
| `nav.guarantees` | Garantías | Guarantees |
| `nav.integrations` | Integración | Integration |
| `nav.demo` | Qué es simulado | What is simulated |
| `nav.faq` | Preguntas | Questions |
| `nav.menu` | Menú | Menu |
| `nav.skip` | Saltar al contenido | Skip to content |
| `cta.try` | Probar la demo | Try the demo |
| `cta.signIn` | Ingresar | Sign in |
| `cta.talk` | Hablemos | Let's talk |
| `cta.toConsole` (sesión activa) | Ir a mi consola | Go to my console |
| `cta.talkHint` (`title`/`aria-describedby`) | Se abre el contacto de Craftech en una pestaña nueva | Opens Craftech's contact page in a new tab |

### 2.2 Hero

| Clave | es-AR | en |
|---|---|---|
| `hero.eyebrow` | Para estudios de despachantes de aduana | For customs brokerage firms |
| `hero.title` | Cada legajo completo antes de que llegue el buque. | Every import file complete before the vessel arrives. |
| `hero.lead` | Legajo listo persigue la factura comercial, el packing list y el certificado de origen de cada importación: al importador por WhatsApp, al proveedor extranjero por email y en inglés. Decide quién corrige cada observación, recalcula los plazos cuando se mueve la ETA y te deja el legajo listo para aprobar. | Legajo listo chases the commercial invoice, the packing list and the certificate of origin of every import: the importer on WhatsApp, the foreign supplier by email, in English. It decides who must fix each finding, reschedules deadlines when the ETA moves and leaves the file ready for you to approve. |
| `hero.primary` | Probar la demo | Try the demo |
| `hero.secondary` | Ingresar | Sign in |
| `hero.tertiary` | Ver cómo funciona | See how it works |
| `hero.trust` (3 ítems con check) | La aprobación es siempre tuya · Política de contacto en código · Serverless en AWS | Approval is always yours · Contact policy in code · Serverless on AWS |
| `hero.note` | Demo con datos 100 % sintéticos: tu propio estudio ficticio, listo en un minuto. | Demo with 100% synthetic data: your own fictitious firm, ready in a minute. |
| `hero.phoneCaption` | Simulador: los textos son los reales de las plantillas; el estudio es ficticio. | Simulator: the texts are the real template texts; the firm is fictitious. |
| `hero.replay` | Repetir la conversación | Replay the conversation |
| `hero.phoneLabel` | Conversación de ejemplo por WhatsApp entre Estudio Delta y un importador | Sample WhatsApp conversation between Estudio Delta and an importer |

### 2.3 El problema

| Clave | es-AR | en |
|---|---|---|
| `problem.eyebrow` | El problema | The problem |
| `problem.title` | Tres documentos, dos idiomas y un buque que no espera | Three documents, two languages and a vessel that does not wait |
| `problem.lead` | Antes del arribo, el despachante necesita el legajo completo. Los documentos los tiene el importador o, casi siempre, un proveedor extranjero que contesta en inglés, desde otra zona horaria y por email. | Before arrival, the broker needs the complete file. The documents are with the importer or, almost always, with a foreign supplier who answers in English, from another time zone and by email. |
| `problem.items[0].title` | Persecución manual | Manual chasing |
| `problem.items[0].text` | Mensajes desde el WhatsApp personal, emails reenviados y nadie sabe qué se pidió, a quién ni cuándo. | Messages from a personal phone, forwarded emails, and nobody knows what was asked, of whom or when. |
| `problem.items[1].title` | Correcciones tardías y sin dueño | Late fixes with no owner |
| `problem.items[1].text` | Un peso que no coincide aparece con el buque en puerto, y el importador recibe un problema que no es suyo. | A weight mismatch shows up with the vessel in port, and the importer gets a problem that is not theirs. |
| `problem.items[2].title` | La ETA se mueve | The ETA moves |
| `problem.items[2].text` | El arribo cambia, los plazos quedan viejos y el riesgo de almacenaje y demora no se ve hasta que cuesta. | The arrival changes, deadlines go stale and the storage and demurrage risk stays hidden until it costs. |
| `problem.timeline.label` | Días hasta el arribo | Days to arrival |
| `problem.timeline.marks` | ETA − 7 · ETA − 3 · ETA − 48 h · Arribo | ETA − 7 · ETA − 3 · ETA − 48 h · Arrival |

### 2.4 Recorrido del producto

| Clave | es-AR | en |
|---|---|---|
| `tour.eyebrow` | Cómo funciona | How it works |
| `tour.title` | Operación 4471, de punta a punta | Operation 4471, end to end |
| `tour.lead` | Un importador ficticio trae textiles en el buque Austral Aurora, con arribo el 22/10. La factura ya es válida; faltan el packing list y el certificado de origen. Así lo resuelve Legajo listo. | A fictitious importer brings textiles on the vessel Austral Aurora, arriving on 22/10. The invoice is already valid; the packing list and the certificate of origin are missing. This is how Legajo listo handles it. |
| `tour.stepLabel(n, total)` | Paso {n} de {total} | Step {n} of {total} |
| `tour.previous` / `tour.next` | Paso anterior / Paso siguiente | Previous step / Next step |
| `tour.stepsLabel` | Pasos del recorrido | Tour steps |
| `tour.simTime` | Hora simulada | Simulated time |
| `tour.agentSample` | Ejemplo de texto del agente | Sample agent text |
| `tour.template` | Plantilla aprobada | Approved template |
| `tour.fixed` | Texto fijo | Fixed text |
| `tour.renderBadge` | Animación con los componentes y textos del producto | Animation built with the product's components and texts |
| `tour.steps.request.channel` | WhatsApp · plantilla | WhatsApp · template |
| `tour.steps.request.title` | El primer pedido, siete días antes del arribo | The first request, seven days before arrival |
| `tour.steps.request.text` | Al importador le llega lo que falta con cuatro botones: subir los documentos, que los mande el proveedor, hacer una pregunta o dejar de recibir avisos. | The importer gets what is missing with four buttons: upload the documents, have the supplier send them, ask a question or stop the notices. |
| `tour.steps.delegate.channel` | WhatsApp · política de contacto | WhatsApp · contact policy |
| `tour.steps.delegate.title` | «Los manda el proveedor» | "The supplier will send them" |
| `tour.steps.delegate.text` | El importador delega con un toque y confirma el contacto registrado. Del otro lado son las 21:00: el email espera hasta las 09:00 del proveedor, y el agente se lo avisa al importador. | The importer delegates with one tap and confirms the registered contact. It is 9 p.m. on the other side: the email waits until 9 a.m. supplier time, and the agent tells the importer. |
| `tour.steps.supplier.channel` | Email · en inglés | Email · in English |
| `tour.steps.supplier.title` | Lo que recibe el proveedor | What the supplier receives |
| `tour.steps.supplier.text` | Un pedido claro, en inglés, desde la dirección de la operación. El proveedor contesta en el mismo hilo con los PDFs adjuntos. | A clear request, in English, from the operation's address. The supplier replies in the same thread with the PDFs attached. |
| `tour.steps.reader.channel` | Lector documental | Document reader |
| `tour.steps.reader.title` | Lo que encuentra el lector | What the reader finds |
| `tour.steps.reader.text` | Cada PDF va al lector documental por su contrato. El certificado es válido; el packing list declara 12.480 kg de peso bruto y la factura, 12.840 kg. | Every PDF goes to the document reader through its contract. The certificate is valid; the packing list states 12,480 kg gross weight and the invoice, 12,840 kg. |
| `tour.steps.owner.channel` | Email · WhatsApp | Email · WhatsApp |
| `tour.steps.owner.title` | Quién corrige | Who must fix it |
| `tour.steps.owner.text` | La corrección es del proveedor: el agente se la pide en el mismo hilo. Al importador le dice solo lo que le toca: «no tenés que hacer nada». Con la versión 2, el legajo queda listo para revisión. | The fix belongs to the supplier: the agent asks for it in the same thread. The importer only hears what concerns them: "nothing for you to do". With version 2, the file is ready for review. |
| `tour.steps.eta.channel` | Transportista · hitos | Carrier · milestones |
| `tour.steps.eta.title` | La ETA se adelanta dos días | The ETA moves two days earlier |
| `tour.steps.eta.text` | El transportista informa un arribo nuevo. El código reprograma los hitos pendientes, sin pasar por el modelo, y el agente comunica el nuevo plazo. | The carrier reports a new arrival. The code reschedules the pending milestones, without the model, and the agent communicates the new deadline. |
| `tour.steps.escalation.channel` | Guardrail · escalamiento | Guardrail · escalation |
| `tour.steps.escalation.title` | Lo que no le toca al agente, va al despachante | What is not the agent's call goes to the broker |
| `tour.steps.escalation.text` | «¿Qué posición arancelaria va?» es asesoramiento aduanero. Un guardrail lo detiene antes del modelo, el importador recibe una respuesta fija y el despachante, un aviso de escalamiento con el contexto. | "Which tariff heading applies?" is customs advice. A guardrail stops it before the model, the importer gets a fixed answer and the broker gets an escalation notice with the context. |
| `tour.steps.approval.channel` | Consola del estudio | Firm console |
| `tour.steps.approval.title` | La aprobación es siempre humana | Approval is always human |
| `tour.steps.approval.text` | Con los tres documentos válidos, el despachante revisa lecturas y observaciones y aprueba con un ingreso reciente. Ninguna herramienta del agente puede aprobar. | With all three documents valid, the broker reviews readings and findings and approves after a recent sign-in. No agent tool can approve. |
| `tour.eta.before` / `tour.eta.after` | Antes / Ahora | Before / Now |
| `tour.eta.milestones` | Último recordatorio (ETA − 3 días) · Escalamiento si falta algo (ETA − 48 h) · Arribo | Final reminder (ETA − 3 days) · Escalation if anything is missing (ETA − 48 h) · Arrival |
| `tour.reader.found` / `expected` | en el packing list / en la factura | on the packing list / on the invoice |
| `tour.reader.owner` | Responsable | Owner |
| `tour.deferral.supplier` | Diferido por el horario del proveedor hasta las 09:00 de allá | Deferred by the supplier's working hours until 9 a.m. their time |
| `tour.deferral.importer` | Diferido por el horario de Argentina hasta las 09:00 | Deferred by Argentina's hours until 9 a.m. |

Los textos de las burbujas, del hilo de email y de la tarjeta de lectura no están en esta tabla: se generan desde
`@legajo/bff/copy` como hoy (`conversations.ts`, `supplier-replies.json`), con la glosa en inglés en la página en.

### 2.5 Qué hace, por actor

| Clave | es-AR | en |
|---|---|---|
| `capabilities.eyebrow` | Qué hace | What it does |
| `capabilities.title` | Cada parte, por su canal y en su idioma | Every party, on their channel and in their language |
| `capabilities.importer.title` | Importador | Importer |
| `capabilities.importer.lead` | Sabe qué le toca y qué no. | Knows what is theirs to do and what is not. |
| `capabilities.importer.items` | Pedido por WhatsApp con botones · Link de carga sin usuario ni contraseña · Delegar al proveedor con un toque · Dudas respondidas con el checklist del estudio · Baja de avisos cuando quiera | WhatsApp request with buttons · Upload link with no username or password · Delegate to the supplier with one tap · Questions answered from the firm's checklist · Opt out of notices at any time |
| `capabilities.supplier.title` | Proveedor extranjero | Foreign supplier |
| `capabilities.supplier.lead` | Un pedido claro, en inglés y en su horario. | A clear request, in English and in their working hours. |
| `capabilities.supplier.items` | Email en inglés desde la dirección de la operación · Correcciones concretas en el mismo hilo · Nunca fuera de su horario laboral | English email from the operation's address · Specific fixes in the same thread · Never outside their working hours |
| `capabilities.firm.title` | Estudio | Brokerage firm |
| `capabilities.firm.lead` | Legajos completos antes del arribo, con el motivo de cada paso. | Complete files before arrival, with the reason for every step. |
| `capabilities.firm.items` | Operaciones con su próximo evento · Detalle del legajo con lecturas, observaciones y responsables · Escalamientos por motivo · Tomar la conversación cuando quieras · Aprobar, siempre una persona · Métricas con su N y bitácora de decisiones | Operations with their next event · File detail with readings, findings and owners · Escalations by reason · Take over the conversation at any time · Approve, always a person · Metrics with their N and a decision log |

### 2.6 Garantías

| Clave | es-AR | en |
|---|---|---|
| `guarantees.eyebrow` | Garantías | Guarantees |
| `guarantees.title` | Lo que no depende del modelo | What does not depend on the model |
| `guarantees.lead` | El modelo decide qué hacer en cada turno. Lo que no se negocia está en el código, en las políticas del agente y en los guardrails. | The model decides what to do on each turn. What is not negotiable lives in the code, in the agent's policies and in the guardrails. |
| `guarantees.items[0]` | **La aprobación es siempre humana.** No existe una herramienta del agente que apruebe, y la consola pide un ingreso reciente. | **Approval is always human.** No agent tool can approve, and the console asks for a recent sign-in. |
| `guarantees.items[1]` | **La política de contacto vive en el código.** Opt-in, ventana de 24 horas, horario de cada parte y un recordatorio por día, antes de cada envío. | **The contact policy lives in code.** Opt-in, 24-hour window, each party's hours and one reminder a day, checked before every send. |
| `guarantees.items[2]` | **Nadie recibe un dato ajeno.** Cada envío pasa por un cerco de destinatarios y ningún mensaje lleva enlaces ni contactos ajenos. | **Nobody gets someone else's data.** Every send goes through a recipient fence and no message carries outside links or contacts. |
| `guarantees.items[3]` | **La lectura de documentos es de tu lector.** Cada PDF va al lector documental por su contrato; lo que no reconoce lo resuelve el despachante. | **Document reading belongs to your reader.** Every PDF goes to the document reader through its contract; what it cannot recognise goes to the broker. |
| `guarantees.items[4]` | **La identidad no la decide el modelo.** Teléfono registrado del importador; dirección de la operación, contacto confirmado y DMARC del proveedor. | **The model does not decide identity.** The importer's registered phone; the operation's address, a confirmed contact and DMARC for the supplier. |
| `guarantees.items[5]` | **Todo lo que entra es hostil.** Datos sensibles enmascarados antes de guardarse y un guardrail antes del modelo. | **Everything inbound is hostile.** Sensitive data masked before storage and a guardrail before the model. |
| `guarantees.ruleLabel` | Regla | Rule |

### 2.7 Impacto

| Clave | es-AR | en |
|---|---|---|
| `impact.eyebrow` | Impacto | Impact |
| `impact.title` | Lo que buscamos para tu estudio | What we aim for in your firm |
| `impact.lead` | Esta es una demo: no mostramos resultados de producción. Son metas del diseño, y la consola mide cada una en tu mundo, con su N. | This is a demo: we show no production results. These are design goals, and the console measures each one in your world, with its N. |
| `impact.labels.goal` | Meta | Goal |
| `impact.labels.guarantee` | Garantía en código | Guaranteed in code |
| `impact.tiles[0]` | **72 h** · Legajo completo antes del arribo · Los tres documentos válidos al menos 72 horas antes de la ETA vigente. | **72 h** · File complete before arrival · All three documents valid at least 72 hours before the current ETA. |
| `impact.tiles[1]` | **El mismo día** · Cada corrección, pedida a su responsable · Cuando llega el PDF, la observación va a quien la tiene que corregir, ese mismo día. | **Same day** · Every fix, asked of its owner · When the PDF arrives, the finding goes to whoever must fix it, that same day. |
| `impact.tiles[2]` | **100 %** · Una sola historia por operación · Cada pedido, respuesta, lectura y decisión en una línea de tiempo, con su motivo. | **100%** · One story per operation · Every request, reply, reading and decision on one timeline, with its reason. |
| `impact.tiles[3]` | **100 %** · Aprobaciones hechas por una persona · Ninguna herramienta del agente puede aprobar. | **100%** · Approvals made by a person · No agent tool can approve. |
| `impact.footnote` | Los números de tu demo se miden en la consola, con su N, su fuente y su rótulo: medido, agente guionado o supuesto. | Your demo's numbers are measured in the console, with their N, source and label: measured, scripted agent or assumption. |
| `impact.assumptions` | El riesgo de demora se estima con supuestos editables por estudio (días libres en puerto, USD por día y por contenedor). | Demurrage risk is estimated with assumptions each firm can edit (free days in port, USD per day and per container). |

### 2.8 Integración

| Clave | es-AR | en |
|---|---|---|
| `integrations.eyebrow` | Cómo se integra | How it integrates |
| `integrations.title` | Serverless en AWS, conectado a tus sistemas por contrato | Serverless on AWS, connected to your systems by contract |
| `integrations.lead` | Canales de AWS para hablar con cada parte, un agente con reglas en el código y conectores por contrato a tu lector documental y a tu sistema de gestión. | AWS channels to talk to each party, an agent with rules in code and contract-based connectors to your document reader and your management system. |
| `integrations.lanes.channels` | Canales | Channels |
| `integrations.lanes.agent` | Agente | Agent |
| `integrations.lanes.time` | Tiempo y eventos | Time and events |
| `integrations.lanes.systems` | Tus sistemas | Your systems |
| `integrations.nodes.whatsapp` | WhatsApp por AWS End User Messaging Social · plantillas aprobadas, botones y documentos | WhatsApp through AWS End User Messaging Social · approved templates, buttons and documents |
| `integrations.nodes.email` | Amazon SES · envío y recepción, DMARC y un hilo por operación | Amazon SES · sending and receiving, DMARC and one thread per operation |
| `integrations.nodes.upload` | Link de carga · sin usuario, con escaneo de malware | Upload link · no account, with malware scanning |
| `integrations.nodes.agentcore` | Amazon Bedrock AgentCore · turnos, herramientas, políticas y memoria | Amazon Bedrock AgentCore · turns, tools, policies and memory |
| `integrations.nodes.guardrails` | Amazon Bedrock Guardrails · antes del modelo y sobre cada texto que sale | Amazon Bedrock Guardrails · before the model and on every outgoing text |
| `integrations.nodes.scheduler` | Amazon EventBridge Scheduler · hitos relativos a la ETA que se reprograman solos | Amazon EventBridge Scheduler · ETA-relative milestones that reschedule themselves |
| `integrations.nodes.reader` | Lector documental · el que elija tu estudio, detrás de un contrato OpenAPI | Document reader · the one your firm chooses, behind an OpenAPI contract |
| `integrations.nodes.platform` | Tu sistema de gestión · conector por contrato, adaptado a tu estudio | Your management system · contract-based connector, adapted to your firm |
| `integrations.points` | Sin servidores que administrar · Conectores por contrato · Todo por infraestructura como código | No servers to manage · Contract-based connectors · Everything as infrastructure as code |
| `integrations.platforms.title` | Para plataformas de comercio exterior | For trade-software platforms |
| `integrations.platforms.lead` | ¿Tenés un software para despachantes o importadores? Legajo listo se suma como módulo, sin reemplazar lo que ya hacés. | Do you build software for customs brokers or importers? Legajo listo plugs in as a module, without replacing what you already do. |
| `integrations.platforms.items` | El lector documental se conecta por un contrato OpenAPI publicado · La plataforma de gestión, por una API versionada con su esquema · Estados y novedades entran como eventos · Canales, política de contacto y reglas viven en código, sobre AWS serverless | The document reader connects through a published OpenAPI contract · The management platform, through a versioned API with its schema · Statuses and updates come in as events · Channels, contact policy and rules live in code, on AWS serverless |
| `integrations.platforms.cta` | Hablemos de integrarlo | Let's talk about integrating it |
| `integrations.diagramAlt` | Diagrama: el importador por WhatsApp y el proveedor por email llegan a una cola por operación; el agente en Bedrock AgentCore decide con herramientas y políticas; los envíos salen por un pipeline con la política de contacto; el lector documental y el sistema de gestión se conectan por contrato. | Diagram: the importer on WhatsApp and the supplier by email reach a per-operation queue; the agent on Bedrock AgentCore decides with tools and policies; sends leave through a pipeline with the contact policy; the document reader and the management system connect by contract. |

### 2.9 Qué es simulado

| Clave | es-AR | en |
|---|---|---|
| `demo.eyebrow` | En esta demo | In this demo |
| `demo.title` | Qué es real y qué es simulado | What is real and what is simulated |
| `demo.columns.real` | **Real.** Amazon SES de punta a punta, Amazon Bedrock AgentCore y Guardrails, EventBridge Scheduler, SQS, DynamoDB, S3, Cognito y CloudFront. | **Real.** Amazon SES end to end, Amazon Bedrock AgentCore and Guardrails, EventBridge Scheduler, SQS, DynamoDB, S3, Cognito and CloudFront. |
| `demo.columns.simulatedMode` | **Implementado, en modo simulado.** AWS End User Messaging Social, el adaptador de WhatsApp: probado con fixtures; en la demo usás un simulador de teléfono dentro de la consola. | **Built, running in simulated mode.** AWS End User Messaging Social, the WhatsApp adapter: tested with fixtures; in the demo you use a phone simulator inside the console. |
| `demo.columns.mocks` | **Sistemas simulados.** Lector documental, sistema de gestión aduanera, transportista, aduana y proveedores (con buzones propios). | **Simulated systems.** Document reader, customs management system, carrier, customs and suppliers (with their own mailboxes). |
| `demo.columns.data` | **Datos.** 100 % sintéticos. Estudios, importadores, proveedores, buques y personas son ficticios. | **Data.** 100% synthetic. Firms, importers, suppliers, vessels and people are fictitious. |
| `demo.clock` | El reloj de tu demo está en pausa: la hora simulada avanza con un botón, para que veas en minutos lo que pasa en días. | Your demo's clock is paused: simulated time moves with a button, so you see in minutes what takes days. |

### 2.10 Galería

| Clave | es-AR | en |
|---|---|---|
| `gallery.eyebrow` | La consola | The console |
| `gallery.title` | Todo lo que pasó, con su motivo | Everything that happened, with its reason |
| `gallery.lead` | Capturas de la consola real sobre un mundo sintético. | Captures of the real console over a synthetic world. |
| `gallery.renderNote` (estado `render`) | Animación con los componentes y textos del producto | Animation built with the product's components and texts |
| `gallery.localNote` (estado `capture`, origen `local`) | Entorno local, agente guionado | Local environment, scripted agent |
| `gallery.placeholderNote` (estado `placeholder`) | Imagen provisoria | Provisional image |

Los tres rótulos son los de ADR-0016 §3 (una sola fuente: el texto es-AR de esta tabla es el que cita el ADR); una
`capture` de origen `poc` no lleva rótulo.
| `zoom.open` | Ampliar imagen: {alt} | Enlarge image: {alt} |
| `zoom.close` | Cerrar | Close |
| `zoom.previous` / `zoom.next` | Imagen anterior / Imagen siguiente | Previous image / Next image |
| `zoom.counter(n, total)` | {n} de {total} | {n} of {total} |

Alt y leyenda de cada captura: §7.3.

### 2.11 CTA final y footer

| Clave | es-AR | en |
|---|---|---|
| `closing.title` | Tu estudio de prueba, listo en un minuto | Your trial firm, ready in a minute |
| `closing.lead` | Creá tu cuenta, recibí un estudio ficticio con la operación 4471 y recorré la historia a tu ritmo, con el reloj en tus manos. | Create your account, get a fictitious firm with operation 4471 and walk through the story at your own pace, with the clock in your hands. |
| `closing.try` | Probar la demo | Try the demo |
| `closing.talkAlt` | o escribinos a sales@craftech.io | or write to sales@craftech.io |
| `closing.signIn` | Ya tengo cuenta: ingresar | I have an account: sign in |
| `closing.talkTitle` | ¿Querés llevarlo a tu estudio? | Want it for your firm? |
| `closing.talkLead` | Contanos cómo trabajan hoy y lo vemos juntos. | Tell us how you work today and we will look at it together. |
| `closing.talk` | Hablemos | Let's talk |
| `footer.product` | Legajo listo · Powered by Craftech | Legajo listo · Powered by Craftech |
| `footer.synthetic` | Demo con datos 100 % sintéticos: todo nombre es ficticio. | Demo with 100% synthetic data: every name is fictitious. |
| `footer.legal` | Legales | Legal |
| `footer.privacy` | Privacidad | Privacy |
| `footer.terms` | Términos | Terms |
| `footer.contact` | Contacto | Contact |
| `footer.rights` | © 2026 Craftech | © 2026 Craftech |

### 2.12 Estados de la landing

| Clave | es-AR | en |
|---|---|---|
| `media.loading` | Cargando capturas… | Loading captures… |
| `media.unavailable` | Las capturas no se pudieron cargar. El resto de la página funciona igual. | The captures could not be loaded. The rest of the page works as usual. |
| `session.signedIn` | Tenés una sesión abierta. | You have an open session. |
| `motion.paused` (botón de pausa de animaciones, WCAG 2.2.2) | Pausar animaciones | Pause animations |
| `motion.resume` | Reanudar animaciones | Resume animations |

### 2.13 Preguntas frecuentes (`#faq`)

Sección entre `#demo` y `#gallery` (§1.2, fila 9). Seis `<details>` con `<summary>` como pregunta (el primero cerrado
también: el visitante elige), `h2` "Preguntas frecuentes" / "Questions". Cada respuesta usa **solo afirmaciones que el
diseño respalda**; la columna "Respaldo" no se publica, es para `security` y para quien cambie el texto.

| Clave | es-AR | en | Respaldo |
|---|---|---|---|
| `faq.eyebrow` | Preguntas | Questions | — |
| `faq.title` | Preguntas frecuentes | Frequently asked questions | — |
| `faq.data.q` | ¿Dónde quedan los documentos de mis importadores y quién los ve? | Where do my importers' documents live, and who sees them? | — |
| `faq.data.a` | En AWS, región us-east-1 (Estados Unidos). Antes de guardarse, los datos sensibles (CUIT, DNI, CBU, tarjetas, IBAN) se enmascaran. Ve cada operación solo tu estudio; cada parte recibe únicamente lo que le toca, y el agente trabaja sobre el texto enmascarado. En esta demo todo es sintético. | On AWS, region us-east-1 (United States). Before storage, sensitive data (tax IDs, national IDs, bank accounts, cards, IBAN) is masked. Only your firm sees each operation; every party gets only what concerns them, and the agent works on the masked text. In this demo everything is synthetic. | `docs/architecture.md` (región), CLAUDE.md "Todo contenido entrante es hostil" (enmascarado), cerco de destinatarios (§1.6). **Sin frase sobre entrenamiento del modelo**: se suma solo si `architect` cita en un doc los términos vigentes del proveedor del modelo en Amazon Bedrock, con fecha y enlace |
| `faq.reader.q` | ¿Y si mi estudio no usa un lector documental? | What if my firm does not use a document reader? | — |
| `faq.reader.a` | Legajo listo no lee documentos por su cuenta: cada PDF va a un lector documental a través de un contrato OpenAPI. Si todavía no usás ninguno, lo elegimos juntos y Craftech lo adapta a ese contrato durante el piloto. Lo que el lector no reconoce lo resuelve el despachante. | Legajo listo does not read documents on its own: every PDF goes to a document reader through an OpenAPI contract. If you do not use one yet, we choose it together and Craftech adapts it to that contract during the pilot. Whatever the reader cannot recognise goes to the broker. | ADR-0003, `packages/reader-contract/openapi.yaml` |
| `faq.platform.q` | ¿Cómo se conecta con mi sistema de gestión? | How does it connect to my management system? | — |
| `faq.platform.a` | Con un conector por contrato que se adapta a cada estudio: lee los datos de la operación y recibe los cambios de estado como eventos. En esta demo, el sistema de gestión es simulado. | Through a contract-based connector adapted to each firm: it reads the operation's data and receives status changes as events. In this demo, the management system is simulated. | `docs/architecture-integrations.md` §6 |
| `faq.whatsapp.q` | ¿Qué necesito para usar WhatsApp? | What do I need to use WhatsApp? | — |
| `faq.whatsapp.a` | Un número de empresa propio de tu estudio, plantillas de mensaje aprobadas por el operador del canal y el consentimiento (opt-in) de cada importador. Los mensajes salen por AWS End User Messaging Social y se cobran por uso. En esta demo el canal funciona en modo simulado, con un simulador de teléfono. | Your firm's own business number, message templates approved by the channel operator and each importer's consent (opt-in). Messages go out through AWS End User Messaging Social and are billed per use. In this demo the channel runs in simulated mode, with a phone simulator. | ADR-0002, regla `CP-OPTIN`, `docs/pending.md` P-01 |
| `faq.cost.q` | ¿Cuánto cuesta? | How much does it cost? | — |
| `faq.cost.a` | Depende del volumen de operaciones de tu estudio y del uso de AWS (turnos del agente, emails y mensajes). Contanos cómo trabajan hoy y armamos el piloto juntos. | It depends on your firm's volume of operations and on AWS usage (agent turns, emails and messages). Tell us how you work today and we will plan the pilot together. | D-10; costo por legajo de `docs/design-brief.md` §8 |
| `faq.cost.cta` | Hablemos | Let's talk | §9, `utm_content=faq` |
| `faq.approval.q` | ¿Quién aprueba el legajo? | Who approves the file? | — |
| `faq.approval.a` | Siempre una persona: el despachante, desde la consola y con un ingreso reciente. Ninguna herramienta del agente puede aprobar. | Always a person: the broker, from the console and after a recent sign-in. No agent tool can approve. | ADR-0010, `CED-NO-APPROVE` |

Reglas: sin la frase "tus datos en tu cuenta de AWS" (D-10, §1.8); sin precios; sin promesas de marca blanca, SDK ni
fechas. Un cambio de respuesta que agregue una afirmación nueva necesita su respaldo en esta tabla antes del merge.

## 3. Identidad visual

### 3.1 Concepto

"Puerto de noche, papel de legajo": bandas oscuras de agua de puerto (hero, recorrido, CTA final) alternadas con
secciones claras de papel cálido (problema, garantías, integración). Un acento **señal** (naranja de contenedor, para
acciones y lo que está pendiente) y un acento **vidrio de mar** (verde agua, para lo que quedó resuelto y válido).
Tipografía de títulos geométrica y compacta; cuerpo con la fuente del sistema. Motivo gráfico: una **línea de ruta**
punteada que conecta los pasos del recorrido y avanza con el scroll, y una grilla tenue de legajo en el fondo del hero
(gradientes CSS, sin imágenes). Distinto de la landing de la etapa anterior y de la de otras POCs: no hay degradés de
marca de terceros ni íconos de canales.

La consola conserva su paleta actual (`navy`, `cyan`, …). Los tokens nuevos se agregan al mismo `@theme` de
`packages/web/src/index.css`; los hex viven **solo** ahí.

### 3.2 Tokens de color (`@theme`)

| Token | Valor | Rol | Contraste verificado |
|---|---|---|---|
| `--color-harbor-950` | `#06131f` | Fondo de bandas oscuras (hero, recorrido, CTA final) | — |
| `--color-harbor-900` | `#0b2233` | Superficie elevada sobre oscuro (tarjetas del recorrido) | `foam` 14,2:1 |
| `--color-harbor-800` | `#123248` | Borde y superficie secundaria sobre oscuro | `foam` 11,6:1; `foam-muted` 6,3:1 |
| `--color-harbor-700` | `#1c4763` | Línea de ruta inactiva, divisores sobre oscuro (no para texto) | — |
| `--color-foam` | `#e8f1f6` | Texto principal sobre oscuro | 14,2:1 sobre `harbor-900` |
| `--color-foam-muted` | `#9fb5c4` | Texto secundario sobre oscuro | 8,8:1 sobre `harbor-950` |
| `--color-signal` | `#ff8a3d` | CTA primario (fondo, con texto `harbor-950`), acento y estado "pendiente" sobre oscuro | 8,0:1 con `harbor-950` |
| `--color-signal-ink` | `#a4480d` | Acento y enlaces sobre claro | 5,6:1 sobre `manifest`; 5,0:1 sobre `manifest-deep` |
| `--color-glass` | `#5fd3c6` | Estado "válido/resuelto" y foco sobre oscuro | 10,4:1 sobre `harbor-950` |
| `--color-glass-ink` | `#0f766e` | Estado "válido/resuelto" sobre claro | 5,1:1 sobre `manifest`; 4,6:1 sobre `manifest-deep` |
| `--color-manifest` | `#faf7f2` | Fondo claro principal de la landing y de las pantallas de acceso | — |
| `--color-manifest-deep` | `#f1ebe0` | Fondo claro alterno (secciones pares) | — |
| `--color-rule` | `#e3dccf` | Bordes y divisores sobre claro (no para texto) | — |
| `--color-ink-muted` | `#4d5d72` | Texto secundario sobre claro | 6,3:1 sobre `manifest`; 5,7:1 sobre `manifest-deep` |
| `--color-ink` (existente) | sin cambio | Texto principal sobre claro | 16,3:1 sobre `manifest` |
| `--color-danger`, `--color-danger-soft` (existentes) | sin cambio | Errores de formularios | — |

Reglas: ningún texto de menos de 18,66 px en negrita o 24 px normal por debajo de 4,5:1; `harbor-700` y `rule` nunca
llevan texto. Los rótulos "Meta" y "Garantía en código" (y "Supuesto" donde la consola lo usa) se distinguen también por ícono y
texto, nunca solo por color.

### 3.3 Tipografía

| Token | Valor | Uso |
|---|---|---|
| `--font-display` | `"Space Grotesk Variable", ui-sans-serif, system-ui, sans-serif` | Títulos, números de los contadores, wordmark de pasos |
| `--font-sans` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` (se quita `"Inter"`, que hoy no se carga) | Cuerpo, formularios, consola |
| `--font-mono` (existente) | sin cambio | Ids de regla, números de operación |

Fuente de títulos: Space Grotesk variable (licencia SIL OFL 1.1), paquete `@fontsource-variable/space-grotesk` con
versión exacta declarada en la ola 0, importando solo los subsets `latin` y `latin-ext` del eje `wght` desde el CSS del
chunk de la landing y de acceso (≤ 45 KB `woff2` en total), `font-display: swap`, `<link rel="preload">` del subset
`latin` en `index.html`. Sin Google Fonts en runtime (CSP). Métricas de fallback con `size-adjust` para evitar saltos de
layout (CLS < 0,05).

Escala fluida (`--text-*` con `--line-height` y `--letter-spacing` asociados):

| Token | Tamaño | Interlineado | Tracking |
|---|---|---|---|
| `--text-display` | `clamp(2.25rem, 1.55rem + 3.1vw, 4.25rem)` | 1.04 | -0.025em |
| `--text-h2` | `clamp(1.75rem, 1.35rem + 1.8vw, 2.75rem)` | 1.1 | -0.02em |
| `--text-h3` | `clamp(1.2rem, 1.1rem + 0.5vw, 1.5rem)` | 1.25 | -0.01em |
| `--text-lead` | `clamp(1.0625rem, 1rem + 0.35vw, 1.25rem)` | 1.55 | 0 |
| `--text-counter` | `clamp(2.75rem, 2rem + 3.4vw, 4.5rem)` | 1 | -0.03em, `tabular-nums` |
| `--text-eyebrow` | `0.75rem` | 1.4 | 0.14em, mayúsculas |
| Cuerpo | `1rem` (16 px mínimo en mobile; en inputs siempre ≥ 16 px para que iOS no haga zoom) | 1.6 | 0 |

Longitud de línea: 60-72 caracteres (`max-w-[65ch]` se expresa como token `--container-prose: 65ch`).

### 3.4 Espaciado, grilla y contenedores

| Token | Valor | Uso |
|---|---|---|
| `--spacing` (Tailwind) | `0.25rem` | Base 4 px |
| `--spacing-gutter` | `clamp(1rem, 0.6rem + 1.8vw, 2rem)` | Margen lateral (16 px a 360 px) |
| `--spacing-section` | `clamp(4rem, 2.8rem + 5vw, 8rem)` | Padding vertical de sección |
| `--container-content` | `72rem` | Ancho de contenido |
| `--container-tour` | `80rem` | Ancho del recorrido (texto + escenario) |
| `--container-prose` | `65ch` | Párrafos |
| `--container-auth` | `28rem` | Formularios de acceso |

Grilla: 4 columnas < 768 px, 8 de 768 a 1023 px, 12 desde 1024 px; gap `clamp(1rem, 0.5rem + 2vw, 2rem)`.

### 3.5 Radios y elevación

| Token | Valor | Uso |
|---|---|---|
| `--radius-card` (existente) | `0.75rem` | Tarjetas, inputs, botones |
| `--radius-panel` | `1.25rem` | Escenario del recorrido, bloques grandes, tarjeta de acceso |
| `--radius-phone` | `2.25rem` | Marco del teléfono simulado |
| `--radius-pill` | `9999px` | Chips de regla, rótulos, toggle de idioma |
| `--shadow-card` (existente) | sin cambio | Tarjetas sobre claro |
| `--shadow-raised` | `0 2px 4px rgb(6 19 31 / 0.08), 0 12px 28px rgb(6 19 31 / 0.12)` | Hover de tarjetas, tarjeta de acceso |
| `--shadow-float` | `0 24px 60px rgb(0 0 0 / 0.35)` | Teléfono y escenario sobre oscuro |

### 3.6 Iconografía

- Set propio, en línea (SVG), grilla de 24 px, trazo 1,75, puntas y uniones redondeadas, `stroke="currentColor"`, sin
  relleno salvo el punto de estado. Vive en `views/landing/icons.tsx` (y se promueve a `components/` si la consola lo
  usa por segunda vez).
- Íconos: documento, documentos (pila), buque, reloj, calendario con flecha (ETA), escudo con check (garantía), candado,
  persona con check (aprobación humana), flecha de traspaso (escalamiento), sobre (email), globo de chat (canal de
  mensajería genérico, **no** el logo de un tercero), lupa sobre documento (lector), engranaje con reglas (política),
  nube (serverless), enlace roto (sin enlaces ajenos), máscara (enmascarado), check, cruz, flecha, menú, idioma.
- Decorativos con `aria-hidden="true"`; si un ícono es el único contenido de un botón, el botón lleva `aria-label`.
- Ningún logo de terceros (ni de AWS ni del canal de mensajería). Logo de Craftech solo en "Powered by Craftech"
  (`public/brand/`).

### 3.7 Componentes de la landing

| Componente | Base existente | Notas |
|---|---|---|
| `Button` variantes `primary-signal`, `ghost-foam`, `link` | `components/Button.tsx` | Alto mínimo 44 px; se agregan variantes, no un botón nuevo |
| `SectionShell` (eyebrow, título, lead, tono `dark`/`light`/`alt`) | `components/Section.tsx` | Tono controla fondo y colores de texto |
| `RuleChip` | `components/RuleChip.tsx` | Variante sobre oscuro |
| `GoalTile` (valor, rótulo, nota, contador) | `components/StatTile.tsx` | Rótulo obligatorio por tipo (§1.7) |
| `WhatsAppPhone`, `EmailThread`, `SceneVisuals` | `views/landing/` | Restyle con los tokens nuevos; mismos datos |
| `Lightbox`, `GalleryProvider`, `MediaFigure` | `views/landing/` | Ver §6 |
| `AuthCard`, `ConsentCheckbox`, `CodeInput`, `PasswordField` | `views/login/form-parts.tsx` | Se mueven a `views/auth/` (§8) |

## 4. Sistema de movimiento

### 4.1 Principios

1. **Con propósito**: cada animación explica algo (qué llega, qué cambia, qué quedó resuelto) o guía la vista al paso
   siguiente. Nada se mueve en loop sin control del visitante.
2. **Solo `transform` y `opacity`** (y `clip-path` en el reveal del escenario, que también compone en GPU). Nunca
   `width`, `height`, `top`, `left`, `box-shadow` ni `filter` animados.
3. **Sin librerías**: CSS scroll-driven animations bajo `@supports (animation-timeline: view())`, con fallback por
   `IntersectionObserver`; View Transitions (`document.startViewTransition`) con fallback de crossfade CSS.
4. **Contenido primero**: el HTML servido es el estado final; la animación parte de él. Sin JS o sin soporte, se ve todo.
5. **Presupuesto**: nunca más de 2 animaciones simultáneas en pantalla; ninguna tarea de main thread > 50 ms por
   animación; `will-change` solo durante la transición y retirado al terminar.

### 4.2 Tokens de movimiento (`@theme`)

| Token | Valor | Uso |
|---|---|---|
| `--ease-out-soft` | `cubic-bezier(0.22, 1, 0.36, 1)` | Entradas y reveals |
| `--ease-in-out-soft` | `cubic-bezier(0.65, 0, 0.35, 1)` | Cambio de visual del recorrido |
| `--ease-snap` | `cubic-bezier(0.2, 0.9, 0.3, 1.2)` | Aparición de burbujas y chips (leve rebote) |
| `--duration-fast` | `150ms` | Hover, tap, foco |
| `--duration-base` | `280ms` | Burbuja, chip, cambio de pestaña |
| `--duration-slow` | `480ms` | Reveal de sección, cambio de visual del recorrido |
| `--duration-counter` | `1200ms` | Contadores |
| `--animate-reveal-up` | `reveal-up var(--duration-slow) var(--ease-out-soft) both` | Keyframes `opacity 0→1`, `translateY(16px)→0` |
| `--animate-bubble-in` | `bubble-in var(--duration-base) var(--ease-snap) both` | Keyframes `opacity 0→1`, `scale(0.96) translateY(6px)→none`, `transform-origin` del lado del emisor |
| `--animate-typing-dot` | `typing-dot 1s ease-in-out infinite` | Tres puntos de "escribiendo" (desfase 0/150/300 ms) |
| `--animate-stage-in` / `--animate-stage-out` | `stage-in var(--duration-slow) var(--ease-in-out-soft) both` | Fallback del cambio de visual: `opacity` + `translateY(12px)` + `scale(0.98)` |

Los `@keyframes` viven dentro de `@theme` como hoy (`scene-in`, `scene-progress`, que se retiran con el rediseño).

### 4.3 Recorrido del producto

**Desktop (≥ 1024 px): scrollytelling con escenario fijo.**

- Layout de dos columnas dentro de `--container-tour`: izquierda, la lista de 8 pasos (cada uno ≈ 70-80 vh de alto,
  texto centrado verticalmente); derecha, el **escenario** `position: sticky; top: calc(var(--header-h) + 2rem)`, alto
  `min(80vh, 44rem)`, con el visual del paso activo.
- Paso activo: `IntersectionObserver` con `rootMargin: "-45% 0px -45% 0px"` sobre cada paso (una sola instancia). El paso
  activo queda con el color pleno del texto y los demás se atenúan por color (`foam-muted`, contraste AA), nunca por
  opacidad (el texto con opacidad 0,45 no pasa AA en axe); su índice se refleja en `aria-current="step"`.
- **Números de paso fijos** (`TourPills`, desde 768 px): los botones `01…08` van en un `<nav>` `position: sticky` justo
  debajo del header (`top: 4,0625 rem`, fondo del propio bloque para que los pasos pasen por debajo), con el paso activo
  relleno y `aria-current="step"`; el navegador los suelta solos cuando termina el último paso (no hay script de
  fijado). Bajo 768 px el carrusel conserva su propio contador "Paso 3 de 8". Solo cambian de color: con reduced motion
  o pausa no se mueve nada.
- Cambio de visual: `document.startViewTransition(() => setActive(i))` con `view-transition-name: tour-stage` en el
  escenario (crossfade + `translateY(12px)` en 480 ms `--ease-in-out-soft`). Sin soporte de View Transitions: el visual
  saliente hace `--animate-stage-out` y el entrante `--animate-stage-in`, superpuestos en una grilla de una celda.
- Dentro del visual, lo que cambia en ese paso se anima con una secuencia corta (≤ 1,5 s): en `delegate` aparece la
  burbuja del botón tocado y luego el chip `CP-HOURS-SUPPLIER` con el horario; en `reader` se revela la fila del peso
  con los dos valores y el badge de observación; en `owner` el responsable pasa de "—" a "Proveedor"; en `eta` las fechas
  "Antes" se desvanecen y entran las de "Ahora" (tachado estático, sin animar `text-decoration`); en `escalation` el
  guardrail aparece como una barrera entre la pregunta y el modelo, y luego el sobre del estudio; en `approval` el botón
  "Aprobar legajo" pasa a "Aprobado por una persona" con un check.
- **Línea de ruta**: una línea punteada vertical (SVG estático, color `harbor-700`) a la izquierda de la lista y, encima,
  una capa de progreso en `signal` que crece con `transform: scaleY()` desde arriba (no `stroke-dashoffset`, que no
  compone en GPU), ligada a `animation-timeline: view()` del contenedor; fallback: `scaleY` = (paso activo + 1) / 8 con
  transición de 480 ms al cambiar el paso activo.
- Navegación por teclado: cada paso es un `<article>` con su `<h3>`; la lista tiene un índice ("Paso 3 de 8") y
  enlaces de salto a cada paso (`<nav aria-label="Pasos del recorrido">`). El escenario es `aria-live="polite"` solo
  con el título del paso activo (no con todo el visual).
- Clic en el escenario o en su botón "Ampliar": abre la galería en la captura real correspondiente cuando existe (§6).

**Tablet (768-1023 px): pasos apilados.** Cada paso es una tarjeta con su visual arriba y el texto abajo; el visual
hace `reveal-up` al entrar; la secuencia interna del paso corre una vez al quedar 50 % visible.

**Mobile (< 768 px): carrusel deslizable.**

- Contenedor con `overflow-x: auto; scroll-snap-type: x mandatory; overscroll-behavior-x: contain`; cada paso
  `scroll-snap-align: center`, ancho `calc(100vw - 2 * var(--spacing-gutter))`; se desliza con el dedo (nativo, sin JS).
  El contenedor tiene `max-width: 100%` y nunca provoca scroll horizontal de la página.
- Paso activo por `IntersectionObserver` con `root` = carrusel y umbral 0,6. Debajo: botones "Paso anterior" y "Paso
  siguiente" (44 × 44 px) que hacen `scrollTo({ behavior })`, y un indicador "Paso 3 de 8" con 8 puntos
  (`aria-hidden`; el texto es el accesible).
- El visual del teléfono se escala para que el paso entero (visual + texto) quepa en una pantalla de 390 × 844 sin
  scroll interno: visual ≤ 56 vh.
- Teclado: el carrusel es `role="region"` con `aria-roledescription="carrusel"`/`"carousel"` y `aria-label`; ← y →
  mueven de paso cuando tiene el foco.

### 4.4 Conversación que se escribe sola (hero)

- Guion: los mensajes reales de `conversation("request")` y `conversation("delegate")` (plantilla de pedido con sus 4
  botones → el importador toca "Los manda el proveedor" → confirmación del contacto → aviso del diferimiento), en ese
  orden.
- Cadencia: mensaje del estudio = indicador "escribiendo" 900 ms → burbuja con `--animate-bubble-in`; toque del
  importador = el botón se resalta 200 ms → burbuja del importador; texto libre del importador (si lo hay) se escribe
  carácter por carácter a 28 ms/carácter, tope 1,2 s por mensaje. Pausa de 1,4 s entre mensajes. Total ≤ 12 s.
- Corre **una vez** al cargar si el hero está visible; al terminar queda el estado final y aparece "Repetir la
  conversación". Se pausa si el hero sale de la vista (`IntersectionObserver`) o la pestaña se oculta
  (`visibilitychange`), y retoma donde quedó.
- El hilo se desplaza solo dentro del teléfono con `transform: translateY` sobre la lista (no `scrollTop` animado).
- Accesibilidad: el teléfono es un `<figure>` con `<figcaption>` (no `role="img"`); la lista de mensajes es
  `aria-hidden` mientras anima, y un bloque visualmente oculto contiene la conversación completa en texto desde el
  inicio (lectores de pantalla leen el final, nunca un texto a medio escribir). Sin `aria-live` que interrumpa.
- Control: el botón global "Pausar animaciones" del header (WCAG 2.2.2) detiene esta secuencia y los carruseles.

### 4.5 Contadores de metas

- Cuentan de 0 al valor en `--duration-counter` con easing `easeOutCubic` por `requestAnimationFrame`, una sola vez,
  cuando la tile queda 50 % visible. "72 h" cuenta 0 → 72; "100 %" cuenta 0 → 100; "El mismo día" no cuenta: entra con
  `reveal-up` y un ícono de reloj en `glass`.
- `font-variant-numeric: tabular-nums` y ancho reservado (`min-width` en `ch`) para que el número no mueva el layout.
- El número animado es `aria-hidden`; el valor final va en texto visualmente oculto desde el inicio.

### 4.6 Reveals y micro-interacciones

| Elemento | Animación | Disparo |
|---|---|---|
| Título, lead y tarjetas de cada sección | `reveal-up`, tarjetas en cascada de 60 ms (máx. 6) | `animation-timeline: view(); animation-range: entry 10% cover 30%` o `IntersectionObserver` (umbral 0,15, una vez) |
| Línea de tiempo del problema | Relleno `scaleX` 0 → 1 con marcas que se encienden | Scroll-driven sobre la sección |
| Tarjeta (hover/foco, puntero fino) | `translateY(-2px)` + cambio de sombra por `opacity` de una capa `::after` con `--shadow-raised` | `:hover` y `:focus-visible` dentro de `@media (hover: hover)` |
| Botón (tap) | `scale(0.98)` 150 ms | `:active` |
| Botón primario (hover) | Flecha interna `translateX(3px)` | `:hover` |
| Chip de regla | `bubble-in` al entrar al escenario | Secuencia del paso |
| Galería (miniatura) | `scale(1.02)` de la imagen dentro de un contenedor con `overflow: hidden` | `:hover` |
| Apertura del lightbox | `opacity` + `scale(0.98 → 1)` 200 ms del `<dialog>`; `::backdrop` en `opacity` | Apertura |
| Header | Al pasar el hero, fondo translúcido con `backdrop-filter` estático (no animado) y borde que aparece por `opacity` | `IntersectionObserver` sobre el hero |

### 4.7 `prefers-reduced-motion: reduce`

| Pieza | Comportamiento reducido |
|---|---|
| Reveals y cascadas | Sin movimiento: contenido visible desde el inicio (las reglas de animación viven dentro de `@media (prefers-reduced-motion: no-preference)`) |
| Recorrido desktop | Mismo layout sticky; el visual cambia sin transición (corte directo); sin línea de ruta animada (se ve completa) |
| Recorrido mobile | Carrusel con `scroll-behavior: auto`; botones saltan sin animar |
| Conversación del hero | Se muestra completa y estática; sin "escribiendo"; sin botón "Repetir" |
| Contadores | Valor final desde el inicio |
| Secuencias internas de cada paso | Estado final del paso |
| Lightbox | Aparece sin escala |
| Scroll suave de anclas | `scroll-behavior: auto` (ya está en `index.css`) |

El botón "Pausar animaciones" produce el mismo estado que `reduce` para la sesión (atributo `data-motion="off"` en
`<html>`, recordado en `sessionStorage` con `try/catch`). Test UI: con `reducedMotion: "reduce"` en Playwright, todo el
texto del recorrido, la conversación completa y los valores finales de las metas están en el DOM y visibles.

## 5. Responsive, accesibilidad y performance

### 5.1 Layouts por ancho

| Sección | 360 px | 390 px | 768 px | 1024 px | 1440 px + |
|---|---|---|---|---|---|
| Header | Wordmark, CTA primario (compacto: "Probar"/"Try"), menú | Igual que 360 | Wordmark, toggle es/en, "Ingresar", "Probar la demo", menú | Igual que 768 (los enlaces siguen en el menú: a 1024 px cinco enlaces más los controles desbordan) | Desde 1280 px: wordmark, los 5 enlaces, toggle, "Ingresar", "Probar la demo", contenido centrado en `--container-content` |
| Hero | Una columna: eyebrow, título, lead, CTAs apilados a ancho completo, trust en lista; teléfono debajo, ancho ≤ 300 px | Igual, teléfono ≤ 320 px | Una columna con CTAs en fila; teléfono centrado ≤ 340 px | Dos columnas 7/5: texto a la izquierda, teléfono a la derecha | Igual, teléfono ≤ 380 px; fondo con grilla a sangre |
| Problema | Tarjetas apiladas; línea de tiempo horizontal compacta (4 marcas) | Igual | 3 tarjetas en 2 + 1 | 3 tarjetas en fila; línea de tiempo a ancho completo | Igual |
| Recorrido | Carrusel (§4.3) | Carrusel | Pasos apilados | Sticky de dos columnas 5/7 | Igual, escenario ≤ 44 rem de alto |
| Por actor | Acordeón (`<details>`) con el primero abierto | Igual | 3 columnas compactas | 3 columnas | Igual |
| Garantías | 1 columna | 1 columna | 2 columnas | 3 columnas | 3 columnas |
| Impacto | 1 columna (tiles horizontales: número a la izquierda) | 2 × 2 | 4 en fila | 4 en fila | 4 en fila |
| Integración | Carriles apilados verticales con flechas hacia abajo; bloque "Para plataformas" debajo, CTA a ancho completo | Igual | Carriles apilados; bloque "Para plataformas" debajo | 4 carriles en fila con flechas horizontales; bloque "Para plataformas" en una banda de dos columnas (texto + lista) | Igual |
| Qué es simulado | Tabla convertida en 4 tarjetas | Igual | 2 × 2 | Tabla de 4 columnas | Igual |
| Preguntas frecuentes | `<details>` a ancho completo, `summary` ≥ 44 px de alto | Igual | Igual, `--container-prose` | Dos columnas de 3 | Igual |
| Galería | 1 columna | 2 columnas | 3 columnas | 3 columnas | 4 columnas |
| CTA final | Botones apilados a ancho completo | Igual | En fila | En fila, bloque "Hablemos" al lado | Igual |
| Pantallas de acceso | Tarjeta a ancho completo con gutter | Igual | Tarjeta centrada `--container-auth` | Dos paneles: marca + beneficios a la izquierda (banda `harbor-950`), formulario a la derecha | Igual |

Reglas: nada de scroll horizontal en ningún ancho (test UI mide `document.documentElement.scrollWidth <=
clientWidth` en 360, 390, 768, 1024 y 1440); objetivos táctiles ≥ 44 × 44 px (incluidos toggle, puntos del carrusel
cuando son botones, enlaces del footer con padding); tipografía fluida con `clamp` (§3.3); imágenes con `max-width:
100%` y `aspect-ratio` declarado; tablas anchas se transforman en tarjetas, nunca se desbordan; textos largos con
`overflow-wrap: anywhere` en direcciones de email del hilo.

### 5.2 Accesibilidad (WCAG 2.2 AA)

- Landmarks: `header` (`banner`), `nav` con `aria-label`, `main` con `id="main"`, cada sección `section` con
  `aria-labelledby` a su `h2`, `footer` (`contentinfo`). Un solo `h1` (título del hero). Enlace "Saltar al contenido"
  como primer foco.
- Idioma: `<html lang="es-AR">` o `lang="en"` según el idioma activo; el botón del toggle lleva `lang` del idioma al
  que cambia; al cambiar, el foco queda en el toggle y se anuncia el cambio con el nuevo `document.title`.
- Títulos de página: "Legajo listo · Agente de coordinación para despachantes de aduana" / "Legajo listo · Coordination
  agent for customs brokers"; en acceso: "Crear cuenta · Legajo listo", "Ingresar · Legajo listo", etc.
- Foco visible: el `:focus-visible` global existente (`outline-2 outline-offset-2`) con color `glass` sobre oscuro y
  `harbor-950` sobre claro (contraste ≥ 3:1 con el fondo); nunca `outline: none` sin reemplazo; el header fijo no tapa
  el elemento enfocado (`scroll-padding-top: var(--header-h)`).
- Teclado: todo operable con Tab, Enter, Espacio, ← → (carrusel y lightbox) y Escape (menú y lightbox); orden de foco
  igual al visual; el menú mobile atrapa el foco solo mientras está abierto y lo devuelve al botón.
- Contraste AA (§3.2); estados nunca solo por color.
- Imágenes: `alt` descriptivo en el idioma de la página (§7.3); ilustraciones decorativas `alt=""`; los visuales del
  recorrido construidos con componentes llevan texto real (se leen como texto, no como imagen).
- Formularios: `label` visible y asociado; errores con `aria-describedby` e `aria-invalid`; resumen de errores al
  enviar, enfocado, con enlaces a cada campo; `autocomplete` correcto (`email`, `new-password`, `current-password`,
  `one-time-code`, `name`, `organization`, `organization-title`); sin límites de tiempo salvo el vencimiento del
  código, que se anuncia.
- Movimiento: §4.7 y botón "Pausar animaciones".
- Zoom del navegador 200 % y reflow a 320 CSS px sin pérdida de contenido.

### 5.3 Performance: presupuesto

| Métrica | Meta | Cómo se mide |
|---|---|---|
| LCP | < 2,5 s en 4G lenta emulada (Lighthouse mobile, `simulate`) sobre `poc` | Lighthouse CI en el job de verificación post-deploy (no bloquea el deploy; falla el check de `qa`) |
| CLS | < 0,05 | Idem |
| INP | < 200 ms | Idem (TBT < 200 ms como proxy) |
| JS propio de landing + acceso | ≤ 90 KB gzip: el chunk de entrada y lo que importa de forma estática, sin la consola (otro chunk) ni el runtime de terceros | `vite build` + script `scripts/landing/bundle-budget.ts` que falla por encima |
| JS de terceros que `/` descarga antes de pintar | ≤ 100 KB gzip: chunks `vendor-react` (React 19, `react-dom`, `scheduler`) y `vendor-data` (zod, tRPC), separados por `packages/web/vite.config.ts` | Idem (el script informa también el total de `/`) |
| CSS total | ≤ 35 KB gzip | Idem |
| Fuente | ≤ 45 KB (`latin` + `latin-ext`) | Idem |
| Imágenes del hero | Ninguna imagen raster: el teléfono es HTML/CSS | — |
| Imágenes bajo el pliegue | AVIF con fallback WebP, `srcset` por ancho (desktop 480, 960, 1440 y 1920; mobile 390 y 780, los de ADR-0016 §4), `sizes` por layout, `loading="lazy"`, `decoding="async"`, `width`/`height` del manifiesto | `render-visuals.ts`/`capture-console.ts` generan las variantes |

Decisión del presupuesto de JS (integración de la etapa A2, 2026-10-02; la confirma `architect`): React 19 solo pesa
unos 66 KB gzip y zod más tRPC unos 31 KB, así que ningún reparto de chunks deja "landing + acceso" en 90 KB contando el
runtime. El presupuesto de 90 KB mide el código propio (el que crece con cada cambio de la landing y del acceso) y el
runtime de terceros tiene su propio tope de 100 KB, que solo cambia con una actualización de dependencias. El medidor
real de la experiencia sigue siendo el LCP de Lighthouse sobre `poc` de la fila de arriba. Al integrar A2: propio 82,4 KB,
terceros 96,5 KB, total 179 KB gzip.

Reglas: el LCP es el `h1` del hero (texto), así que no depende de imágenes; el manifiesto se pide después del primer
render (ya es así); nada de JS bloqueante en `<head>` salvo el módulo de Vite; `preload` solo de la fuente `latin`;
`IntersectionObserver` único por tipo (reveals, recorrido, contadores); el lightbox y la galería se cargan con el primer
scroll a `#gallery` (`import()`); el chunk de la consola nunca se descarga en `/` salvo prefetch en `idle` cuando hay
sesión.

### 5.4 SEO y metadatos (sin nombrar el concurso)

- `<meta name="description">` es/en con la línea de valor; Open Graph (`og:title`, `og:description`, `og:image` =
  render `og-card` 1200 × 630 generado por `render-visuals.ts` con el hero); `twitter:card` `summary_large_image`.
- `<link rel="alternate" hreflang="es-AR" href="/?lang=es">` y `hreflang="en"`; `canonical` a `/`.
- `robots`: landing y legales indexables, siempre (D-11: no hay variante por stage ni por modo). `robots.txt` estático en
  `public/` y `<meta name="robots" content="noindex">` solo en `/signup*`, `/login`, `/forgot*`, `/welcome` y `/app/*`.

### 5.5 Seguridad de la página

- CSP existente sin `unsafe-inline` para scripts; los estilos de animación viven en CSS; los `style` data-driven usan
  variables CSS por atributo (permitido hoy en la consola).
- Enlaces externos ("Hablemos") con `rel="noopener noreferrer"` y `target="_blank"`.
- La landing no carga analytics de terceros. Las UTM que trae el visitante se leen en el cliente solo para adjuntarlas
  al lead al hacer signup (§8.2).

### 5.6 Guards y tests que verifican esta sección

| Test | Qué verifica |
|---|---|
| `npm run lint:neutral-surfaces` (script + tests por palabra) | Vocabulario de §2.0 ausente de las fuentes visibles que enumera ADR-0014 §4 (web, `public/`, copy del BFF, página de carga, emails de cuenta y de lead, plantillas, textos del seed que ve un usuario) y del `dist` de la web; por palabra completa, sin distinguir mayúsculas ni acentos; corre en `ci.yml` y `deploy.yml` junto a `lint:forbidden` |
| `landing.test.ts` | Paridad de claves es/en; ningún tile de impacto sin rótulo y a lo sumo un tile con rótulo "Garantía en código"; números de `#impact` solo de la lista de §1.7 (`72`, `100`), ninguna cifra de días libres ni de USD en la landing y ninguna aparición de "no verificada"/"unverified"; en `#demo`, **ningún servicio o sistema en dos columnas** (intersección vacía de las listas de `demo-columns.ts`) y ni "todos"/"todo" ni "every"/"all" en `demo.columns.real`; ni "tu cuenta de AWS" ni "your AWS account" en ningún texto; mismos tres puntos en `integrations.points` que en §1.8; conversaciones generadas desde `@legajo/bff/copy`; el CTA primario de header, hero y cierre usa `cta.try` ("Probar la demo" / "Try the demo") y ningún texto de la landing ni de las pantallas de acceso dice "Pedir acceso", "Request access", "lista de espera" ni "waitlist" |
| `e2e/landing.spec.ts` | 360/390/768/1024/1440 sin scroll horizontal; orden de las 11 secciones; toggle es/en cambia `lang` y textos; recorrido desktop cambia el visual al scrollear; carrusel mobile con botones; reduced motion (§4.7); CTAs a `/signup`, `/login` y al contacto de Craftech (incluido `utm_content=platform` y `faq`); `#faq` con 6 `<details>` operables con teclado; "Probar la demo" en header, hero y cierre (a `/signup`), `hero.note` visible y `/` sin `<meta name="robots" content="noindex">` |
| `e2e/a11y.spec.ts` | axe-core sobre `/`, `/signup`, `/login`, `/forgot` en es y en (sin violaciones `serious`/`critical`); si agrega `@axe-core/playwright`, se declara con versión exacta |
| `scripts/landing/bundle-budget.ts` | Presupuesto de §5.3 |

## 6. Galería con zoom (lightbox)

Se **reusa** `views/landing/Lightbox.tsx` + `gallery.tsx` + `MediaFigure.tsx` (un `<dialog>` nativo con Escape, foco y
backdrop del navegador; ← → y swipe; clic afuera cierra; botón X). Cambios:

| # | Cambio | Por qué |
|---|---|---|
| G-1 | Botones anterior/siguiente/cerrar de 44 × 44 px, con los íconos del set (§3.6) en vez de `‹ ›`; X arriba a la derecha dentro del área segura (`env(safe-area-inset-*)`) | Objetivos táctiles y notch |
| G-2 | Al cerrar, el foco vuelve a la miniatura que lo abrió (guardar `document.activeElement` al abrir) | Teclado |
| G-3 | `<picture>` con `<source type="image/avif">`, `<source type="image/webp">` y `<img>` PNG de fallback, con `srcset`/`sizes` (§5.3); en el lightbox, `sizes="100vw"` | Performance |
| G-4 | Leyenda = `caption` de la imagen (no el `alt`), más el rótulo de su estado (§2.10: `render`, `capture` de origen `local` o `placeholder`; una `capture` de `poc` no lleva rótulo), más "3 de 12" | El `alt` describe; la leyenda cuenta; mismos rótulos que ADR-0016 §3 |
| G-5 | Precarga de la imagen siguiente y anterior al abrir (`new Image()` con la variante que corresponde) | Navegación sin espera |
| G-6 | Swipe: umbral 48 px, solo `pointerType` táctil o lápiz, con `touch-action: pan-y` sobre la imagen; animación de salida `translateX` + `opacity` 200 ms (sin animación con reduced motion) | Mobile |
| G-7 | Pinch-zoom nativo permitido dentro del dialog (`touch-action: pan-y pinch-zoom`); doble tap no hace nada propio | No pelear con el navegador |
| G-8 | Anuncio accesible del cambio: `aria-live="polite"` en el contador | Lectores de pantalla |
| G-9 | Colores con tokens nuevos: `::backdrop` `harbor-950/90`, controles `foam` sobre `harbor-900` | Identidad |
| G-10 | El lightbox se carga con `import()` al primer uso o al acercarse a `#gallery` | JS inicial |
| G-11 | Items de la galería: las entradas `capture` del manifiesto (§7.4), en el orden de §7.3. Las entradas `render` (cuadro estático de un render animado) no entran a la galería: el botón "Ampliar" del escenario abre la `capture` que figura en su `replacedBy` si ya existe, o el cuadro estático del render con su rótulo. Una entrada `placeholder` puede entrar a la galería con su rótulo, nunca al hero | Una galería de imágenes reales |

Sin librería. Pruebas: `e2e/landing.spec.ts` abre, navega con ← →, con swipe emulado (Playwright `touchscreen`), cierra
con Escape, con X y con clic afuera, y verifica el foco devuelto.

## 7. Plan de capturas

### 7.1 Principios

1. **Todo lo que la landing muestra sale del producto real**: capturas de la consola real (Playwright) o renders
   construidos con los **componentes y textos reales** (`@legajo/bff/copy`, componentes de `views/`). Nunca un mockup
   dibujado a mano ni una función que no existe.
2. Cada render declara en el manifiesto **qué captura real lo reemplaza** (§7.4). Un render es honesto: se rotula
   "Animación con los componentes y textos del producto" (`gallery.renderNote`, §2.10) en la galería y en el escenario.
3. La consola es solo es-AR (CLAUDE.md, idiomas): en la página en, las capturas son las mismas y el `alt` y la leyenda
   en inglés explican lo que se ve. Los renders del recorrido sí cambian de idioma (glosa en inglés de cada texto al
   importador, como hoy).
4. Ningún frame se escribe sin pasar `frame-check.ts` (términos prohibidos de la lista externa **y** vocabulario de
   §2.0).

### 7.2 Pipeline

| Pieza | Hoy | Cambio |
|---|---|---|
| `scripts/landing/capture-console.ts` | 1280 × 800, `--target poc` con la cuenta sintética del rol anterior, o `--target local` | Renombre de la cuenta a `guest-test` y de la variable a `GUEST_TEST_PASSWORD` (solo del entorno, nunca impresa); `--base-url` restringido a `https://legajo.demo.craftech.io` únicamente (ADR-0016 §4; cierra el hallazgo abierto); dos variantes por captura: `desktop` 1440 × 900 y `mobile` 390 × 844, ambas con `deviceScaleFactor: 2`; `--lang` no aplica (consola es-AR) |
| `scripts/landing/captures.json` | 7 capturas con `view`, `open`, `moment` | Lista de §7.3, con `moment` = id de un momento del mundo (§7.2.1) y `variants` |
| `scripts/landing/render-visuals.ts` | `upload-page`, `upload-done` (página real de carga en el servidor local) | Agrega el cuadro estático (`png` de la entrada `render`) de cada render animado del recorrido, en es y en, y la captura `og-card` de la propia landing servida en local (§7.3) |
| `scripts/landing/manifest-file.ts` + `scripts/landing/encode.ts` (nuevo, ADR-0016 §4) | Escribe PNG y actualiza el manifiesto v1 | `encode.ts` genera AVIF (calidad 50) y WebP (calidad 80) en los anchos de §5.3 con `sharp` (versión estable exacta declarada en el WP) y escribe `sources`; `manifest-file.ts` escribe las entradas del manifiesto v2 (§7.4) |
| `scripts/landing/frame-check.ts` | Términos prohibidos | + vocabulario de §2.0 (misma lista que `lint:neutral-surfaces`, importada de un solo módulo) |

#### 7.2.1 Mundo determinista y momentos

- Mundo: la plantilla **`guest`** (renombre de la plantilla curada del rol anterior; mismas operaciones: 4471 como
  historia principal más 4474, 4477, 4478, 4487 y 4488), reloj en pausa el 14/10 10:30, semilla fija.
- **Momentos** (`tests/ui-server/moments/`): estados del mundo con nombre, en el orden del recorrido guiado
  (`views/tour/steps.ts`): `start`, `after-request`, `after-delegate`, `after-supplier-email`, `after-reading`,
  `after-correction`, `after-eta-move`, `after-escalation`, `after-approval`, `after-dispatch`.
  - Mientras la ola 3 no exista: cada momento se arma aplicando al mundo en memoria del servidor local los **eventos
    del escenario** con el Harness guionado del pipeline local (`LF`) donde el pipeline ya existe; y, donde todavía no,
    con filas validadas por los schemas zod de cada entidad y derivadas de la verdad de base del seed. Esas capturas
    salen con `origin: "local"` y la etiqueta "Entorno local, agente guionado" (`gallery.localNote`, §2.10).
  - Con la ola 3 y `SC-24` en verde en `poc`: `capture-console.ts --target poc` después de una corrida real del
    recorrido con `guest-test`; salen con `origin: "poc"` y sin etiqueta.
- Determinismo: `timezoneId: "America/Argentina/Buenos_Aires"`, `locale: "es-AR"`, `page.clock.setFixedTime` en el
  instante real del momento, `reducedMotion: "reduce"`, `await document.fonts.ready`, sin red fuera del objetivo (todo
  request ajeno aborta la corrida). Dos corridas seguidas producen los mismos PNG byte a byte en `--target local`
  (test `capture-determinism` sobre dos ids).

### 7.3 Lista de capturas y renders

**Capturas de la consola** (galería + reemplazo de renders). Todas con variante `desktop` y `mobile`.

| Id | Vista | Momento | Qué se ve | Reemplaza al render |
|---|---|---|---|---|
| `console-operations` | `/app/operations` | `after-correction` | Operaciones del mundo con la 4471 fijada como historia principal, legajo listo para revisión y próximo evento | — |
| `console-simulator` | `/app/simulator` | `after-delegate` | Hilo del importador de la 4471: plantilla de pedido con 4 botones, delegación y aviso de diferimiento, con glosa EN | `hero-conversation`, `tour-request`, `tour-delegate` |
| `console-mailbox` | `/app/mailbox` | `after-correction` | Hilo de la 4471 con el proveedor: pedido en inglés, respuesta con PDFs, pedido de corrección y packing list corregido | `tour-supplier` |
| `console-dossier-reading` | `/app/operations/:id` (4471) | `after-reading` | Documentos con lecturas: certificado válido, packing list con `GROSS_WEIGHT_MISMATCH` y responsable "Proveedor"; pendientes con su motivo | `tour-reader`, `tour-owner` |
| `console-dossier` | `/app/operations/:id` (4471) | `after-correction` | Tres documentos válidos, la observación resuelta por la versión 2 y la línea de tiempo con el email diferido y su regla | `tour-owner` |
| `console-clock` | `/app/clock` | `after-eta-move` | Reloj en pausa y próximos eventos con los hitos reprogramados tras el cambio de ETA | `tour-eta` |
| `console-escalations` | `/app/escalations` | `after-escalation` | Escalamiento de la 4471 por pregunta fuera de alcance, con su motivo | `tour-escalation` |
| `console-mailbox-firm` | `/app/mailbox` (buzón del estudio) | `after-escalation` | Email de escalamiento que recibió el despachante, con estado, intentos y enlace a la consola | `tour-escalation` |
| `console-dossier-approval` | `/app/operations/:id` (4471) | `after-approval` | Legajo aprobado por una persona, con el pedido de ingreso reciente resuelto y la aprobación en la línea de tiempo | `tour-approval` |
| `console-metrics` | `/app/metrics` | `after-dispatch` | KPIs con N, fuente y rótulo; decisiones de política por regla junto a 0 violaciones | — (galería) |
| `console-audit` | `/app/audit` | `after-dispatch` | Bitácora con `DEFER` por `CP-HOURS-SUPPLIER` y `CP-HOURS-AR`, la aprobación del despachante y 0 violaciones | — (galería) |
| `console-tour` | `/app/operations` con el panel Recorrido guiado abierto | `start` | Primer ingreso de un invitado: su mundo en pausa y el panel con el paso 1 | — (galería, y CTA final) |

**Capturas de páginas reales servidas en local** (`render-visuals.ts`, ADR-0016 §4; estado `capture`, origen `local`,
con rótulo "Entorno local, agente guionado" hasta que WP-36 las tome en `poc`): `upload-page` y `upload-done` (página
real de carga, variante `mobile`) y `og-card` (la propia landing servida en local, recortada a 1200 × 630; es una
captura de una página real, como pide ADR-0016 §1 para Open Graph, no un dibujo). `og-card` existe solo en español: el
patrón `src` del manifiesto no lleva idioma y `og:image` es uno solo para las dos versiones.

**Renders animados** (estado `render`: componente vivo en la página + un cuadro estático generado por
`render-visuals.ts`, que es lo que el manifiesto sirve para "Ampliar", para `prefers-reduced-motion` y para la galería
cuando corresponde). Esta tabla es el contenido de `scripts/landing/renders.json` (§7.4):

| Id | Dónde | `component` y `textSources` (reales) | `replacedBy` | `replaceIn` (WP que construye la vista) | `policy` |
|---|---|---|---|---|---|
| `hero-conversation` | Hero | `WhatsAppPhone` + `conversation("request")`, `conversation("delegate")` | `console-simulator` | WP-35 | `zoom` (el render queda como ilustración animada del canal, siempre rotulado "Simulador", y "Ampliar" abre la captura) |
| `tour-request` | Paso 1 | `WhatsAppPhone` + plantilla de pedido (`renderTemplate`) | `console-simulator` | WP-35 | `zoom` |
| `tour-delegate` | Paso 2 | `WhatsAppPhone` + `RuleChip CP-HOURS-SUPPLIER` + `tour.deferral.supplier` | `console-simulator` | WP-35 | `zoom` |
| `tour-supplier` | Paso 3 | `EmailThread` + `supplierEmailEn` + `supplier-replies.json` | `console-mailbox` | WP-35 | `swap` |
| `tour-reader` | Paso 4 | Tarjeta de lectura (`SceneVisuals`) + `OBSERVATION_LABELS` + `READINGS` | `console-dossier-reading` | WP-34 | `swap` |
| `tour-owner` | Paso 5 | `EmailThread` (pedido de corrección) + `WhatsAppPhone` (`conversation("noAction")`) | `console-dossier` | WP-34 | `zoom` |
| `tour-eta` | Paso 6 | Tabla de hitos (`ETA_MILESTONES`) + aviso del nuevo plazo (plantilla real) | `console-clock` | WP-35 | `swap` |
| `tour-escalation` | Paso 7 | `WhatsAppPhone` (`conversation("question")`, respuesta fija del guardrail, plantilla `legajo_escalado`) + asunto real `escalationSubject` | `console-escalations` (y `console-mailbox-firm` como segunda imagen de "Ampliar") | WP-34 | `swap` |
| `tour-approval` | Paso 8 | `ApprovalControls` de `views/dossier` en modo demostración (sin llamadas) + plantilla `legajo_aprobado` | `console-dossier-approval` | WP-34 | `swap` |

`until` de cada render: "`SC-24` en verde en `poc` y `replacedBy` con `capture` de origen `poc` (WP-36)".

Política `swap`: cuando la captura de `replacedBy` tiene `origin: "poc"`, el escenario desktop muestra la captura (con
el render como animación de entrada de 1,5 s si no hay reduced motion), y la entrada `render` sale del manifiesto y de
`renders.json` en el mismo commit (si no, `landing:check` falla). Política `zoom`: el render queda por diseño (el canal
es simulado, o es una vista de dos partes); "Ampliar" abre la captura. Un render `zoom` cuyo `replacedBy` ya es captura
de `poc` **no** hace fallar `landing:check`: la política `zoom` es la excepción declarada a la regla de ADR-0016 §4
"un `render` cuyo `replacedBy` ya existe como `capture` falla".

**Alt y leyendas** (en `copy-es.ts`/`copy-en.ts`, `media.items`):

| Id | alt es-AR | alt en | Leyenda es-AR | Leyenda en |
|---|---|---|---|---|
| `console-operations` | Vista de operaciones con la operación 4471 fijada arriba y su próximo evento | Operations view with operation 4471 pinned at the top and its next event | Operaciones: cada importación con su ETA, el estado del legajo y el próximo evento. | Operations: every import with its ETA, file status and next event. |
| `console-simulator` | Simulador de teléfono con el hilo de WhatsApp del importador de la operación 4471 | Phone simulator with the importer's WhatsApp thread for operation 4471 | Simulador de teléfono: el canal de WhatsApp en modo simulado, con glosa en inglés. | Phone simulator: the WhatsApp channel in simulated mode, with an English gloss. |
| `console-mailbox` | Buzón de la demo con el hilo de emails en inglés entre la operación 4471 y el proveedor | Demo mailbox with the English email thread between operation 4471 and the supplier | Buzón de la demo: emails reales por Amazon SES, en el mismo hilo. | Demo mailbox: real emails through Amazon SES, in one thread. |
| `console-dossier-reading` | Detalle del legajo 4471 con la lectura del packing list que marca una diferencia de peso bruto y el proveedor como responsable | File detail for 4471 with the packing list reading that flags a gross weight difference and the supplier as owner | Lo que encontró el lector y quién tiene que corregirlo. | What the reader found and who must fix it. |
| `console-dossier` | Detalle del legajo 4471 con los tres documentos válidos y la línea de tiempo | File detail for 4471 with all three documents valid and the timeline | El legajo completo, con cada paso y su motivo. | The complete file, with every step and its reason. |
| `console-clock` | Reloj de la demo en pausa con los hitos reprogramados después del cambio de ETA | Paused demo clock with the milestones rescheduled after the ETA change | El reloj de tu demo: la hora simulada avanza con un botón. | Your demo's clock: simulated time moves with a button. |
| `console-escalations` | Vista de escalamientos con el caso de la operación 4471 y su motivo | Escalations view with the case from operation 4471 and its reason | Lo que el agente pasó al estudio, por motivo. | What the agent handed to the firm, by reason. |
| `console-mailbox-firm` | Email de escalamiento recibido por el estudio con el estado del legajo y los intentos | Escalation email received by the firm with the file status and the attempts | El aviso que recibe el despachante, con el contexto. | The notice the broker receives, with the context. |
| `console-dossier-approval` | Legajo 4471 aprobado por el despachante, con la aprobación en la línea de tiempo | File 4471 approved by the broker, with the approval on the timeline | Aprobar es siempre de una persona. | Approving is always a person's call. |
| `console-metrics` | Métricas con el N, la fuente y el rótulo de cada número | Metrics with the N, source and label of every number | Métricas con N, fuente y rótulo: medido, agente guionado o supuesto. | Metrics with N, source and label: measured, scripted agent or assumption. |
| `console-audit` | Bitácora de decisiones con la regla de cada una y cero violaciones | Decision log with the rule behind each one and zero violations | Cada decisión, con la regla que la tomó. | Every decision, with the rule that made it. |
| `console-tour` | Consola del invitado con el panel de recorrido guiado abierto en el primer paso | Guest console with the guided tour panel open on the first step | Tu primer ingreso: el mundo en pausa y el recorrido guiado. | Your first sign-in: the paused world and the guided tour. |
| `upload-page` | Página de carga de documentos de la operación 4471 en un teléfono | Document upload page for operation 4471 on a phone | Link de carga: el importador ve el número de operación y lo que falta, nada más. | Upload link: the importer sees the operation number and what is missing, nothing else. |
| `upload-done` | Confirmación de la carga de documentos en un teléfono | Upload confirmation on a phone | Después de «Listo»: lo recibido y lo que todavía falta. | After "Done": what arrived and what is still missing. |

### 7.4 Manifiesto v2 y manifiesto de renders (contrato único: ADR-0016 §3)

Hay **un solo contrato**, el de ADR-0016 §3, en dos archivos. Esta sección lo repite tal cual y agrega solo dos campos
a `renders.json` (`policy` y `until`), que `architect` suma al ADR para que no haya dos fuentes.

**1. `packages/web/public/landing/manifest.json`** (versión 2; schema zod `.strict()` en
`packages/web/src/views/landing/manifest.ts`): una lista `entries`, una entrada por par (`id`, `viewport`).

```json
{
  "version": 2,
  "entries": [
    {
      "id": "console-dossier-reading",
      "status": "capture",
      "origin": "local",
      "viewport": "desktop",
      "sources": {
        "avif": [{ "src": "/landing/console-dossier-reading/desktop-480.avif", "w": 480 }, { "src": "/landing/console-dossier-reading/desktop-1920.avif", "w": 1920 }],
        "webp": [{ "src": "/landing/console-dossier-reading/desktop-480.webp", "w": 480 }, { "src": "/landing/console-dossier-reading/desktop-1920.webp", "w": 1920 }],
        "png": { "src": "/landing/console-dossier-reading/desktop.png", "w": 2880, "h": 1800 }
      },
      "capturedAt": "2026-10-06",
      "commit": "<sha corto del commit capturado>"
    },
    {
      "id": "tour-reader",
      "status": "render",
      "viewport": "desktop",
      "sources": { "avif": [], "webp": [], "png": { "src": "/landing/tour-reader/desktop.png", "w": 2880, "h": 1800 } },
      "component": "packages/web/src/views/landing/SceneVisuals.tsx#ReaderCard",
      "textSources": ["@legajo/bff/copy#OBSERVATION_LABELS", "views/landing/scenes.ts#READINGS"],
      "replacedBy": "console-dossier-reading",
      "replaceIn": "WP-34"
    }
  ]
}
```

(En el ejemplo, `avif` y `webp` se abrevian a dos anchos; `encode.ts` escribe todos los de §5.3.)

Esquema de una entrada, igual a ADR-0016 §3: `{ id, status, origin?: "poc" | "local", viewport: "desktop" | "mobile",
sources: {avif: [{src, w}], webp: [{src, w}], png: {src, w, h}}, capturedAt?, commit?, component?, textSources?,
replacedBy?, replaceIn? }`. Reglas:

| `status` | Campos obligatorios | Rótulo visible (§2.10) | Dónde puede ir |
|---|---|---|---|
| `capture` | `origin`, `capturedAt`, `commit` | `origin: "poc"`: ninguno; `origin: "local"`: "Entorno local, agente guionado" | Galería, escenario del recorrido, "Ampliar", Open Graph |
| `render` | `component`, `textSources`, `replacedBy`, `replaceIn` | "Animación con los componentes y textos del producto" | Escenario del recorrido y hero (como componente vivo); su `png` es el cuadro estático de "Ampliar" y de reduced motion |
| `placeholder` | `replacedBy`, `replaceIn` | "Imagen provisoria" | Solo si no hay otra salida; **nunca en el hero** ni como `og-card`. Hoy la lista de §7.3 no usa ninguno |

- Un `id` sin entrada no se muestra: la landing oculta el visual y deja el texto del paso.
- `src` valida el patrón `^/landing/[a-z0-9-]+/(desktop|mobile)(-\d+)?\.(avif|webp|png)$`.
- `moment` (momento del mundo) **no** va en el manifiesto: vive en `scripts/landing/captures.json` (§7.2), que es la
  entrada de `capture-console.ts`.
- Una entrada de `captures.json` puede llevar `pending` (texto con el motivo y el WP que lo destraba) cuando la vista
  todavía no se puede capturar porque falta una pieza de otra ola: `capture-console.ts` la saltea, `landing:check` la
  informa como pendiente en vez de exigirla y los renders `zoom` que la nombran en `replacedBy` siguen con su cuadro
  propio. Hoy: `console-simulator`, hasta que WP-33 registre `simulator.*` en `appRouter`; quien lo registra borra
  `pending` y toma la captura con `--target local --only console-simulator`.

**2. `scripts/landing/renders.json`** (fuera de `public/`; es la lista de renders que pidió el CTO): un objeto por render
con los campos de ADR-0016 §3 más `policy` y `until`.

```json
{
  "tour-reader": {
    "component": "packages/web/src/views/landing/SceneVisuals.tsx#ReaderCard",
    "textSources": ["@legajo/bff/copy#OBSERVATION_LABELS", "views/landing/scenes.ts#READINGS"],
    "replacedBy": "console-dossier-reading",
    "replaceIn": "WP-34",
    "reason": "La vista del detalle del legajo todavía no existe en la consola de poc",
    "policy": "swap",
    "until": "SC-24 en verde en poc y console-dossier-reading con origin poc (WP-36)"
  }
}
```

`policy`: `swap` (la captura reemplaza al render como visual principal cuando es de `poc`) o `zoom` (el render queda por
diseño y "Ampliar" abre la captura; §7.3). `until`: criterio de reemplazo en texto, con su escenario y su WP.

**`npm run landing:check`** (ADR-0016 §4, con la excepción de `zoom`): el manifiesto valida con zod; todo `id` que usa
la landing existe con sus archivos; todo `render` del manifiesto figura en `renders.json` con el mismo `component`,
`textSources`, `replacedBy` y `replaceIn`, y viceversa; un render `swap` cuyo `replacedBy` ya es `capture` de origen
`poc` falla (hay que sacarlo); ningún `placeholder` en el hero ni en `og-card`; todo `alt` y toda leyenda existen en
`copy` es y en. `npm run landing:renders` imprime la tabla id → `replacedBy` → estado actual de esa captura →
`policy` → `until`, para el reporte de `qa` y el plan.

Tests (`manifest.test.ts`, `scripts/landing/check.test.ts`): todo render usado por el código (`TOUR_STEPS[].render`,
hero) está en el manifiesto y en `renders.json`; todo `replacedBy` es un id de `MEDIA_IDS`; cada `status` exige sus
campos y rechaza los ajenos; ningún `swap` con captura `origin: "poc"` sigue como visual principal; el
`public/landing/manifest.json` versionado parsea.

## 8. Pantallas de acceso: UX y copy

**Precedencia (D-12).** Esta sección fija **copy y experiencia**. La mecánica (procedimientos, estados, códigos de error,
topes, archivos, secretos y scripts) es la de ADR-0015 y FL-101 a FL-131, con los nombres de `docs/tool-catalog.md`
("Alta pública"), y esta sección la usa sin renombrar nada. **Ningún número de límites se escribe en el copy ni en los
tests**: cada duración, tope o cantidad que aparece en pantalla (`{s}`, `{n}`, `{hours}`, `{HH:MM}`) sale de
`packages/shared/src/guest-limits.ts` o de la respuesta del BFF (`resendAfterSec`, `retryAfterSec`, `attemptsLeft`,
`resetsAtReal`). Si algo de esta sección contradice ADR-0015, es un error de esta sección y prevalece el ADR.

### 8.0 Una sola alta, sin modos (D-11)

No existe un modo de alta pública ni una lista de espera: ningún valor por stage cambia la landing, el alta o el
ingreso. Los deploys de `poc` por CI son por ola, pero la URL no se comparte hasta que el producto completo (olas 3 a 6)
está desplegado y probado; antes de eso, una alta verificada igual crea la cuenta y el lead, y el primer ingreso muestra el
estado honesto (`CAPACITY` o mundo no disponible). Invariantes del alta verificada (ADR-0015 §1 a §3,
FL-101 a FL-104):

- El CTA primario dice siempre **"Probar la demo"** / **"Try the demo"** (punto 5 de la decisión del CTO) y lleva a
  `/signup`. No hay CTA "Pedir acceso" ni una ruta `/signup/waitlisted`.
- Nada se escribe en `Leads` antes de `SIGNUP#.verifiedAt` (ADR-0015 §1.3): ni el lead, ni los consentimientos, ni su
  fecha y versión. Un envío de `/signup` con un email ajeno solo produce, como mucho, el email con el código en el
  buzón de ese tercero (con "Si no lo pediste, ignorá este mensaje") y ningún registro de consentimiento.
- El lead se escribe **solo en `finalizeSignup`**, después de verificar el email con el código; toda alta confirmada
  es un lead. No existe un lead "sin verificar" ni un estado de espera.
- `LeadNotice` sale solo desde `finalizeSignup`: su volumen queda acotado por las altas verificadas, nunca por los
  envíos del formulario.
- Después de `CONFIRMED`, siempre `/login?welcome=1` con el email precargado; al ingresar, `/welcome` pide el mundo
  (§8.5).

**Capacidad.** Hay dos topes y cada uno tiene su lugar:

| Tope | Dónde se ve | Qué pasa con la cuenta y el lead |
|---|---|---|
| Altas nuevas (tope global de `signup.start`/`signup.resend` o disyuntor de reputación abierto) | `CAPACITY` de `signup.start` → estado `signupPaused` de §8.8, en `/signup` | No se crea nada: no hubo verificación |
| Mundos de invitado activos (ADR-0015 §4) | `CAPACITY` de `account.ensureWorld`/`account.world` → "La demo está completa" en `/welcome` (§8.5), por ejemplo en el primer ingreso después de verificar | La cuenta y el lead verificado **ya existen** y no se tocan; no se crea mundo. La pantalla reintenta sola mientras está abierta y el próximo ingreso vuelve a pedir el mundo |

`signup.start` conserva sus respuestas `RATE_LIMITED` y `CAPACITY`; no tiene otra.

Lo que esta decisión le pide a `architect` (fuera de este doc, A-1): sacar de ADR-0015, `docs/build-plan.md`,
`docs/tool-catalog.md`, `docs/flows-catalog.md`, `docs/test-plan.md`, `docs/pending.md` y la infra cualquier rastro del
modo de alta (`PublicSignupMode`, `infra/signup-mode.ts`, `VITE_PUBLIC_SIGNUP_MODE`, la excepción cercada del modo, la
respuesta `WAITLISTED`, `SignupDispatch` de tipo `WAITLIST`, el lead `WAITLIST`/`emailVerified: false`/`waitlistedAt`, el
aviso "Nuevo pedido de acceso", `leads:export --waitlist`, `robots` según el modo, el punto 9 de P-07 y la métrica
`SignupWaitlisted`); dejar el lead siempre `ACTIVE` (o quitar el campo `status` si queda sin uso), y describir en FL-132
el estado `CAPACITY` en el primer ingreso.

### 8.1 Mapa de pantallas y estados

Un solo camino (D-11, §8.0):

```
/ ──"Probar la demo" (<a href>, navegación completa)──▶ GET /signup ── intersticial silencioso de WAF (cookie aws-waf-token)
   signup.form → {formToken}
   envío → signup.start (httpLink sin lotes)
      ├─ CODE_SENT {signupId, resendAfterSec} ──▶ /signup/verify   (misma respuesta en toda rama; SignupDispatch decide después)
      ├─ RATE_LIMITED {retryAfterSec} · CAPACITY · INVALID (solo errores de forma)
      └─ 202 + x-amzn-waf-action: challenge ──▶ guarda campos no secretos ──▶ GET /signup?retry=1 ──▶ pide solo la contraseña
                                                  (si vuelve a pasar: estado challenge, §8.8)
/signup/verify
   signup.resend → CODE_SENT {resendAfterSec} · RATE_LIMITED {retryAfterSec} · EXPIRED
   signup.confirm → CONFIRMED ──▶ /login?welcome=1 (email precargado)
                  → CODE_INVALID {attemptsLeft} · EXPIRED (vencida o 5 errores: empezar de nuevo) · RATE_LIMITED
/login ──SRP──▶ account.session
   ├─ internos, o GUEST con mundo vivo ──▶ /app/operations (recorrido guiado abierto para GUEST)
   ├─ GUEST sin mundo vivo ──▶ /welcome
   │     account.ensureWorld → {state: CREATING} ; account.world cada 2 s:
   │        CREATING ──▶ sigue "Preparando tu mundo"
   │        READY ──▶ refresco de tokens ──▶ /app/operations
   │        EXPIRED ──▶ aviso de una línea + nuevo ensureWorld ──▶ CREATING
   │        CAPACITY ──▶ "La demo está completa" + "Hablemos", sin crear mundo; reintento cada 60 s con la pestaña visible
   │                     y en el próximo ingreso (la cuenta y el lead verificado ya existen)
   │        FAILED ──▶ "No pudimos preparar tu mundo" (el próximo ensureWorld reintenta)
   ├─ UserNotConfirmedException ──▶ /signup/verify (si hay signupId) o /signup con aviso (§8.4)
   └─ "Olvidé mi contraseña" ──▶ /forgot ──▶ /forgot/reset ──▶ /login?reset=1
Consola: 403 GUEST_WORLD_GONE ──▶ /welcome ; QUOTA_EXCEEDED {kind, resetsAtReal} ──▶ QuotaNotice ; account.usage ──▶ UsageIndicator
Consola ── menú de cuenta ── "Cerrar sesión" ──▶ /?signedOut=1
```

Estados del mundo que la pantalla conoce (y solo esos): los de `account.world` en ADR-0015 §4 (`NONE`, `CREATING`,
`READY`, `EXPIRED`, `CAPACITY`, `FAILED`); las cuotas no son un estado del mundo sino `QUOTA_EXCEEDED` en cada
procedimiento; un token cuyo mundo ya no existe recibe `GUEST_WORLD_GONE`. Un error de transporte o 60 s sin salir de
`CREATING` se muestra como `FAILED` (estado de la pantalla, sin cambiar nada en el BFF). Si `docs/tool-catalog.md` todavía
muestra la versión anterior de estos procedimientos, rige el ADR (`architect` lo alinea).

Todas las pantallas de acceso comparten `AuthLayout`: panel de marca (banda `harbor-950`, wordmark, línea de valor,
3 puntos de confianza, "Powered by Craftech") + tarjeta de formulario (`--container-auth`, fondo `white`, `--radius-panel`,
`--shadow-raised`), toggle es/en y enlace "Volver al inicio". En < 1024 px el panel de marca se reduce a una franja con
el wordmark. Viven en `views/auth/` (los componentes de `views/login/` se mueven ahí; el login del estudio con MFA y
cambio de contraseña inicial sigue funcionando igual para roles internos).

### 8.2 Signup (`/signup`)

**Campos** (en este orden):

| Campo | Obligatorio | Tipo / `autocomplete` | Validación en el cliente (zod de `packages/shared/src/signup.ts`, el mismo del BFF) |
|---|---|---|---|
| Email | Sí | `email` / `email`, `inputmode="email"`, `autocapitalize="none"` | Formato de email, ≤ 254 caracteres; se normaliza (trim + minúsculas) |
| Contraseña | Sí | `password` / `new-password`, botón Mostrar/Ocultar | Política del pool (12+, minúscula, mayúscula, número, símbolo, sin espacios en los bordes), con checklist en vivo; una sola fuente con la política del pool (hallazgo abierto `PASSWORD_MIN_LENGTH`) |
| Nombre | No | `text` / `name` | ≤ 80 caracteres, texto plano (ADR-0015 §2) |
| Empresa | No | `text` / `organization` | ≤ 80 caracteres, texto plano |
| Cargo | No | `text` / `organization-title` | ≤ 80 caracteres, texto plano |
| Consentimiento `terms`: términos y privacidad | **Sí** | checkbox **sin tildar** | Tiene que estar tildado para enviar |
| Consentimiento `contact`: contacto de Craftech | No | checkbox **sin tildar**, separado del anterior | Libre |
| Honeypot `website` | — | `text`, fuera de pantalla, `tabindex="-1"`, `aria-hidden`, `autocomplete="off"` | Si viene con valor, el BFF responde el mismo `CODE_SENT` y no crea nada |

Al montar, la pantalla pide `signup.form` y guarda el `formToken` (un envío antes de 3 s o después de 2 h se descarta
en silencio; ADR-0015 §3.1). `/signup` siempre se abre con navegación completa (`<a href>` que el router no intercepta,
desde la landing, `/login` y el recorrido) para que WAF resuelva su desafío silencioso; los `signup.*` van por un
`httpLink` sin lotes; sin SDK de WAF (ADR-0015 §3.3). Si un `signup.*` recibe `202` con `x-amzn-waf-action:
challenge`, la vista guarda en `sessionStorage` los campos no secretos, navega a `/signup?retry=1`, los restaura y pide
solo la contraseña (`signup.retryNotice`). Con el formulario van `consentVersions` (= `LEGAL_VERSIONS` de `packages/shared/src/legal-versions.ts`), `lang`,
y `utm`/`referrer` de `readAttribution()` (`views/landing/utm.ts`).

Nunca más de 3 campos opcionales. Los opcionales se agrupan bajo "Contanos de vos (opcional)" y no bloquean el envío.
Sin confirmación de contraseña (el checklist y "Mostrar" la reemplazan). Botón primario deshabilitado solo mientras se
envía (nunca por validación: los errores se muestran al enviar y al salir de cada campo).

**Copy** (los textos de las dos casillas no se escriben acá: salen de `packages/shared/src/consent-texts.ts`, fuente
única con su versión, WP-52; la tabla muestra el texto vigente para referencia):

| Clave | es-AR | en |
|---|---|---|
| `signup.title` | Probá Legajo listo | Try Legajo listo |
| `signup.lead` | Creá tu cuenta y en un minuto tenés un estudio ficticio propio, con la operación 4471 lista para recorrer. Todo con datos sintéticos. | Create your account and in a minute you get your own fictitious firm, with operation 4471 ready to walk through. All with synthetic data. |
| `signup.email` | Email de trabajo | Work email |
| `signup.emailHint` | Te enviamos un código para verificarlo. | We will send you a code to verify it. |
| `signup.password` | Contraseña | Password |
| `signup.optionalGroup` | Contanos de vos (opcional) | Tell us about you (optional) |
| `signup.name` | Nombre | Name |
| `signup.company` | Empresa | Company |
| `signup.jobTitle` | Cargo | Job title |
| `signup.consentTerms` (de `consent-texts.ts`, con enlaces a `/legal/terms.html` y `/legal/privacy.html`) | Acepto los términos y la política de privacidad. | I accept the terms and the privacy policy. |
| `signup.consentContact` (de `consent-texts.ts`) | Acepto que Craftech me contacte por esta solución. | I agree that Craftech may contact me about this solution. |
| `signup.consentContactHint` | Opcional. Podés retirarlo cuando quieras. | Optional. You can withdraw it at any time. |
| `signup.submit` | Crear cuenta | Create account |
| `signup.submitting` | Enviando… | Sending… |
| `signup.haveAccount` | ¿Ya tenés cuenta? Ingresá | Already have an account? Sign in |
| `signup.syntheticNote` | En la demo operás solo sobre empresas y personas ficticias. No cargues datos reales de tu estudio ni de tus clientes. | In the demo you only work with fictitious companies and people. Do not enter real data about your firm or your clients. |
| `signup.errors.email` | Escribí un email válido. | Enter a valid email. |
| `signup.errors.password` | La contraseña no cumple las reglas de arriba. | The password does not meet the rules above. |
| `signup.errors.tooLong(max)` | Usá como máximo {max} caracteres. | Use at most {max} characters. |
| `signup.errors.consentTerms` | Para crear la cuenta tenés que aceptar los términos y la política de privacidad. | To create the account you need to accept the terms and the privacy policy. |
| `signup.errors.summary(n)` | Revisá {n} campo(s) antes de seguir. | Check {n} field(s) before continuing. |
| `signup.errors.generic` | No pudimos enviar el formulario. Probá de nuevo en unos minutos. | We could not send the form. Try again in a few minutes. |
| `signup.retryNotice` (vuelta de `/signup?retry=1`) | Tuvimos que recargar la página para verificar tu navegador. Tus datos siguen acá: escribí de nuevo la contraseña y enviá. | We had to reload the page to verify your browser. Your details are still here: type your password again and send. |

`{max}` sale del schema de `signup.ts` (80 para los opcionales). `INVALID` del BFF (solo errores de forma) se muestra
con los mismos mensajes por campo. `RATE_LIMITED`, `CAPACITY` y el desafío de WAF usan los estados de §8.8.

**Versiones.** Cada consentimiento guarda `{accepted, at, version, lang}`; `version` es la de `LEGAL_VERSIONS`
(`{terms, privacy, contact}`, formato `AAAA-MM-DD`, `packages/shared/src/legal-versions.ts`), y el lead guarda además
`privacyVersion` junto a `terms` (ADR-0015 §2 y §6). Cambiar un texto de `consent-texts.ts` o de las páginas legales sin
subir su versión hace fallar `legal-versions.test.ts` (WP-52).

**Respuesta que no revela cuentas** (ADR-0015 §1, §1.1 y §1.2; FL-101 y FL-104). `signup.start` responde siempre
`CODE_SENT` (salvo `RATE_LIMITED`, `CAPACITY` o `INVALID`, que no dicen nada de un email), con el mismo trabajo y la
misma duración en toda rama, sin haber llamado a Cognito; `SignupDispatch` decide después, y la pantalla siguiente es
siempre `/signup/verify`:

| Rama (la decide `SignupDispatch`) | Qué pasa | Qué ve el visitante |
|---|---|---|
| `NEW`: email sin usuario, o con un usuario `UNCONFIRMED` sin grupos (se borra y se vuelve a crear con la contraseña nueva) | Cognito envía el código de alta | `/signup/verify` |
| `EXISTING_GUEST`: invitado público confirmado | `ForgotPassword` con `ClientMetadata {intent: "signup-existing", lang}`: llega "Ya tenés una cuenta en Legajo listo" (§8.10) con un código que confirma **la contraseña que acaba de elegir** | `/signup/verify`, igual |
| `INELIGIBLE`: personal interno, cuentas reservadas y cualquier otro caso de ADR-0015 §1.2 | Nada: ningún email, ningún cambio | `/signup/verify`, igual; `verify.existingHint` le dice que ingrese |
| `SUPPRESSED`: honeypot, tiempo, dominio reservado o sin MX, cuota por email, rebote o queja previa | Nada | `/signup/verify`, igual |

En `INELIGIBLE` y `SUPPRESSED`, `signup.confirm` responde `CODE_INVALID` (a los 1.500 ms, como toda respuesta que no es
`CONFIRMED`). Si `SignupDispatch` falla, el visitante no recibe nada y puede usar "Reenviar código".

### 8.3 Verificación por código (`/signup/verify`)

| Elemento | Detalle |
|---|---|
| Código | Un solo `input` (no 6 cajas), `inputmode="numeric"`, `autocomplete="one-time-code"`, `pattern="[0-9]*"`, 6 dígitos; pegar el código completo funciona; se envía solo al completar 6 dígitos o con el botón. `signup.confirm {signupId, code, password}`: la contraseña del formulario se conserva **solo en memoria** del componente entre `/signup` y `/signup/verify` (nunca en `sessionStorage`); si se perdió (recarga), la pantalla pide la contraseña de nuevo en un campo `new-password` |
| Email | Se muestra enmascarado (`j***@d***.com`) con "Cambiar email" (vuelve a `/signup` con los datos, sin la contraseña) |
| Reenvío | `signup.resend {signupId}`. "Reenviar código" deshabilitado durante `resendAfterSec` (la respuesta lo trae; hoy 60 s) con cuenta regresiva visible y anunciada solo al terminar (`aria-live="polite"`). Tope por alta: `RESEND_MAX_PER_SIGNUP` de `guest-limits.ts` (hoy 3, ADR-0015 §3.2); después del último, el botón desaparece y queda `verify.resendExhausted`. `RATE_LIMITED` → `verify.resendWait`. Además rigen, sin aviso propio, las cuotas por destinatario del `CustomMessage` |
| Código errado | `CODE_INVALID {attemptsLeft}` → `verify.errors.invalid`; con `attemptsLeft` ≤ 2 se suma `verify.errors.attemptsLeft(n)` (no distingue errado de vencido, FL-102) |
| Alta cerrada | `EXPIRED` (código o alta vencidos, o el quinto error) → `verify.errors.expired` con el botón "Empezar de nuevo" a `/signup` con los datos (sin la contraseña). No hay "esperá": reintentar el mismo código nunca funciona |
| Rate limit por IP | `RATE_LIMITED {retryAfterSec}` en `signup.confirm` → estado `rateLimited` de §8.8 con los minutos calculados |
| Éxito | `CONFIRMED` → `/login?welcome=1` con el email precargado y `verify.done` (siempre; no hay otra pantalla después de verificar, §8.0) |

| Clave | es-AR | en |
|---|---|---|
| `verify.title` | Revisá tu email | Check your email |
| `verify.lead(email)` | Si el email puede usarse, te enviamos un código de 6 dígitos a {email}. Puede tardar un par de minutos; mirá también en spam. | If the email can be used, we sent a 6-digit code to {email}. It may take a couple of minutes; check your spam folder too. |
| `verify.existingHint` (siempre visible, ADR-0015 §1.2) | Si ya tenés una cuenta, [ingresá](/login). Si te llegó un email de «Ya tenés una cuenta», su código confirma la contraseña que acabás de elegir. | If you already have an account, [sign in](/login). If you got a "You already have an account" email, its code confirms the password you just chose. |
| `verify.code` | Código de verificación | Verification code |
| `verify.password` (solo si se perdió la contraseña) | Volvé a escribir la contraseña que elegiste | Type the password you chose again |
| `verify.submit` | Verificar | Verify |
| `verify.submitting` (toda respuesta que no es `CONFIRMED` tarda 1,5 s) | Verificando… | Verifying… |
| `verify.resend` | Reenviar código | Resend code |
| `verify.resendIn(s)` | Podés pedir otro código en {s} s | You can request another code in {s} s |
| `verify.resent` | Listo: si el email puede usarse, te llega un código nuevo. El anterior ya no vale. | Done: if the email can be used, a new code is on its way. The previous one no longer works. |
| `verify.resendWait(min)` | Esperá {min} min antes de pedir otro código. | Wait {min} min before requesting another code. |
| `verify.resendExhausted` | Ya no podemos reenviar más códigos para esta alta. Revisá spam o empezá de nuevo. | We cannot resend more codes for this sign-up. Check your spam folder or start again. |
| `verify.changeEmail` | Cambiar email | Change email |
| `verify.errors.invalid` | El código no es válido o venció. Revisalo o pedí uno nuevo. | The code is not valid or has expired. Check it or request a new one. |
| `verify.errors.attemptsLeft(n)` | Te quedan {n} intentos. | You have {n} attempts left. |
| `verify.errors.expired` | Esta alta ya no se puede completar: el código venció o hubo demasiados intentos. Empezá de nuevo; te mandamos un código nuevo. | This sign-up can no longer be completed: the code expired or there were too many attempts. Start again and we will send you a new code. |
| `verify.restart` | Empezar de nuevo | Start again |
| `verify.done` | Tu email quedó verificado. Ingresá para preparar tu mundo. | Your email is verified. Sign in to prepare your world. |

### 8.4 Login (`/login`)

| Clave | es-AR | en |
|---|---|---|
| `login.title` | Ingresá a Legajo listo | Sign in to Legajo listo |
| `login.lead` | Con el email de tu cuenta o el usuario que te dieron. | With your account email or the username you were given. |
| `login.login` | Email o usuario | Email or username |
| `login.password` | Contraseña | Password |
| `login.submit` | Ingresar | Sign in |
| `login.submitting` | Ingresando… | Signing in… |
| `login.forgot` | Olvidé mi contraseña | I forgot my password |
| `login.noAccount` (enlace `<a href="/signup">`, navegación completa) | ¿No tenés cuenta? Probá la demo | No account? Try the demo |
| `login.errors.credentials` | El email, el usuario o la contraseña no son correctos. | The email, username or password is not correct. |
| `login.errors.tooMany` | Hiciste muchos intentos. Esperá unos minutos y probá de nuevo. | Too many attempts. Wait a few minutes and try again. |
| `login.errors.unconfirmed` (con `signupId` guardado: va a `/signup/verify` y pide un reenvío) | Falta verificar tu email. Si podemos, te mandamos un código nuevo. | Your email still needs verifying. If we can, we will send you a new code. |
| `login.errors.unconfirmedRestart` (sin `signupId`: va a `/signup` con el email precargado) | Falta verificar tu email. Completá el alta de nuevo y te mandamos un código. | Your email still needs verifying. Complete the sign-up again and we will send you a code. |
| `login.notices.reset` | Listo: tu contraseña cambió. Ingresá con la nueva. | Done: your password changed. Sign in with the new one. |
| `login.notices.sessionExpired` | La sesión venció. Ingresá de nuevo. | Your session expired. Please sign in again. |
| `login.notices.signedOut` | Cerraste sesión. | You signed out. |

Reglas: `PreventUserExistenceErrors = ENABLED` en el cliente del pool (verificarlo en `infra/auth.ts`); el error de
credenciales es el mismo para usuario inexistente y contraseña incorrecta. `UserNotConfirmedException` (Cognito solo
lo devuelve con la contraseña correcta) lleva a `/signup/verify` con un `signup.resend` si la pestaña guarda el
`signupId` de esa alta en `sessionStorage` (con `try/catch`); si no (otro dispositivo, alta vencida), lleva a `/signup` con
el email precargado: un `signup.start` nuevo borra el usuario `UNCONFIRMED` y crea otro (ADR-0015 §1.2). El navegador
nunca llama a `ResendConfirmationCode` directo (FL-106 se alinea a esto). El paso de MFA TOTP y el cambio
de contraseña inicial siguen igual para roles internos y nunca se muestran a `GUEST`. Se elimina el texto actual que
nombra el rol anterior y la frase "Tu usuario lo crea el estudio por invitación".

### 8.5 Preparando tu mundo (`/welcome`) y límites de uso

Mecánica de ADR-0015 §4 (FL-105, FL-109 a FL-111): si `account.session` dice que el `GUEST` no tiene mundo vivo, o un
procedimiento devuelve `GUEST_WORLD_GONE`, la consola va a `/welcome`, que llama a `account.ensureWorld` (responde
`{state: "CREATING"}` en milisegundos) y consulta `account.world` cada 2 s:

| `account.world` | Pantalla | Comportamiento |
|---|---|---|
| `READY` | — | Refresca los tokens y va a `/app/operations` con el panel Recorrido guiado abierto. Las cuentas reservadas (`guest-01..NN`, `guest-test`) tienen cupo fijo: nunca ven `CAPACITY` ni `EXPIRED` |
| `NONE` | "Preparando tu mundo" | Llama a `account.ensureWorld` (una sola vez por visita a la pantalla; el BFF limita los llamados por cuenta) |
| `CREATING` | "Preparando tu mundo" | Sigue consultando cada 2 s. Barra indeterminada (con reduced motion, el texto "Preparando…" sin animación) y la lista `welcome.includes` como **qué vas a encontrar**, sin tildes de progreso (el BFF no informa pasos, y la pantalla no los inventa) |
| `EXPIRED` | "Preparando tu mundo" con `welcome.expired` arriba | Llama a `account.ensureWorld` y sigue como `CREATING` |
| `CAPACITY` | "La demo está completa" | Tope de mundos de invitado activos lleno (ADR-0015 §4), también en el primer ingreso después de verificar. No se crea mundo; la cuenta y el lead verificado ya existen y no cambian. "Probar de nuevo" (primario), "Hablemos" (`welcome.capacity.talk`, §9 con `utm_content=welcome-capacity`) y "Cerrar sesión"; reintento automático cada 60 s mientras la pestaña está visible, y el próximo ingreso vuelve a llamar a `account.ensureWorld`. Sin cuenta regresiva ni hora estimada |
| `FAILED`, error de transporte o 60 s en `CREATING` | "No pudimos preparar tu mundo" | "Probar de nuevo" (nuevo `ensureWorld`: el BFF reintenta) + "Cerrar sesión"; se registra con correlation id, sin email |

`welcome.ttl` va siempre al pie de la pantalla, así cualquiera sabe desde el primer ingreso cuánto dura su mundo. Sus
números (`{inactiveHours}`, `{maxAgeHours}`) salen de `guest-limits.ts` (hoy 24 y 72, ADR-0015 §4).

| Clave | es-AR | en |
|---|---|---|
| `welcome.title` | Preparando tu mundo | Preparing your world |
| `welcome.lead` | Estamos creando tu estudio ficticio con datos sintéticos. Tarda unos segundos. | We are creating your fictitious firm with synthetic data. It takes a few seconds. |
| `welcome.includesTitle` | Qué vas a encontrar | What you will find |
| `welcome.includes` | Tu estudio ficticio · Importadores y proveedores · La operación 4471 y cinco más · El reloj en pausa el 14/10 a las 10:30 | Your fictitious firm · Importers and suppliers · Operation 4471 and five more · The clock paused on 14/10 at 10:30 |
| `welcome.expired(inactiveHours, maxAgeHours)` | Tu mundo anterior se borró: pasaron {inactiveHours} h sin uso o {maxAgeHours} h desde que lo creamos. Te preparamos uno nuevo desde el día 0. | Your previous world was deleted: {inactiveHours} h went by without use, or {maxAgeHours} h since we created it. We are preparing a new one from day 0. |
| `welcome.ttl(inactiveHours, maxAgeHours)` | Tu mundo de demo se borra después de {inactiveHours} h sin uso o a las {maxAgeHours} h de creado. Tu cuenta sigue: al volver, te preparamos uno nuevo. | Your demo world is deleted after {inactiveHours} h without use or {maxAgeHours} h after it was created. Your account stays: when you come back, we prepare a new one. |
| `welcome.capacity.title` | La demo está completa | The demo is full |
| `welcome.capacity.lead` | La demo está completa en este momento. Tu cuenta ya está creada: probá de nuevo más tarde. | The demo is full right now. Your account is already created: try again later. |
| `welcome.capacity.note` | Cuando vuelvas a ingresar, lo intentamos de nuevo. Si querés verlo con alguien del equipo, hablemos. | When you sign in again, we will try again. If you would like to see it with someone from the team, let's talk. |
| `welcome.capacity.talk` | Hablemos | Let's talk |
| `welcome.retry` | Probar de nuevo | Try again |
| `welcome.failed.title` | No pudimos preparar tu mundo | We could not prepare your world |
| `welcome.failed.lead` | Probá de nuevo. Si vuelve a pasar, escribinos desde "Hablemos". | Try again. If it happens again, write to us through "Let's talk". |
| `welcome.signOut` | Cerrar sesión | Sign out |

**Límites de uso en la consola** (`QUOTA_EXCEEDED {kind, resetsAtReal}` en cualquier procedimiento, y `account.usage`
para el indicador). No es un estado del mundo: la consola sigue abierta, `QuotaNotice` muestra el aviso y las acciones
de ese `kind` se deshabilitan con el motivo hasta `resetsAtReal` (mostrado en hora local del navegador, `HH:MM`).
El texto de ventana diaria es el de ADR-0015 §4; el de ventana horaria es su variante (ventana según `guest-limits.ts`):

| Clave | es-AR | en |
|---|---|---|
| `quota.day(what, HH:MM)` | Llegaste al límite de esta demo por hoy ({what}); se renueva a las {HH:MM}. | You reached this demo's limit for today ({what}); it resets at {HH:MM}. |
| `quota.hour(what, HH:MM)` | Llegaste al límite de esta demo por esta hora ({what}); se renueva a las {HH:MM}. | You reached this demo's limit for this hour ({what}); it resets at {HH:MM}. |
| `quota.global(HH:MM)` (`kind: "GLOBAL"`) | La demo llegó a su límite de uso de hoy; se renueva a las {HH:MM}. | The demo reached its usage limit for today; it resets at {HH:MM}. |
| `quota.usage` (título del indicador) | Uso de tu demo | Your demo's usage |
| `quota.kinds.*` (una etiqueta por cada `kind` de `guest-limits.ts`) | turnos del agente · emails salientes · mensajes del simulador · movimientos del reloj · cargas de PDF · operaciones nuevas · reinicios del mundo · reloj en vivo · preparaciones del mundo | agent turns · outgoing emails · simulator messages · clock moves · PDF uploads · new operations · world resets · live clock · world preparations |

Un test (`views/auth/copy.test.ts`) verifica que cada `kind` de `guest-limits.ts` tenga su etiqueta en es y en, y que
ningún texto de §8 contenga un número de límite escrito a mano.

### 8.6 Recuperar contraseña (`/forgot`, `/forgot/reset`)

| Paso | UX |
|---|---|
| `/forgot` | Campo email o usuario; `ForgotPassword` desde el navegador (FL-107). **Cualquier** respuesta que no sea un error de red (éxito, `UserLambdaValidationException` por la cuota de emails de cuenta de ADR-0015 §3.2, `LimitExceededException`) muestra el mismo `forgot.sent` y pasa a `/forgot/reset`; con `PreventUserExistenceErrors` Cognito no revela nada, y la pantalla tampoco |
| `/forgot/reset` | Código (mismo input de §8.3) + contraseña nueva con checklist; reenvío con la misma espera que el alta (`RESEND_WAIT_SECONDS` de `guest-limits.ts`, hoy 60 s); éxito → `/login?reset=1`. El código vence a la hora (§8.10) |
| Cuentas `GUEST` de las instrucciones privadas (`guest-NN`) | Sin email: la recuperación no aplica; el texto general lo cubre ("Si hay una cuenta…") |

| Clave | es-AR | en |
|---|---|---|
| `forgot.title` | Recuperá tu contraseña | Reset your password |
| `forgot.lead` | Escribí el email de tu cuenta y te enviamos un código. | Enter your account email and we will send you a code. |
| `forgot.submit` | Enviar código | Send code |
| `forgot.sent` | Si hay una cuenta con ese dato, te enviamos un código. Puede tardar un par de minutos. | If there is an account with that detail, we sent you a code. It may take a couple of minutes. |
| `reset.title` | Elegí una contraseña nueva | Choose a new password |
| `reset.code` | Código | Code |
| `reset.password` | Contraseña nueva | New password |
| `reset.submit` | Cambiar contraseña | Change password |
| `reset.errors.invalid` | El código no es válido o venció. Pedí uno nuevo. | The code is not valid or has expired. Request a new one. |
| `reset.back` | Volver a ingresar | Back to sign in |

### 8.7 Cerrar sesión

- En el menú de cuenta de la consola (`AccountMenu`): "Cerrar sesión" / "Sign out". Revoca el refresh token
  (`RevokeToken`), borra tokens de `sessionStorage`, cancela refrescos en curso (hallazgo abierto de `tokens.ts`) y va a
  `/?signedOut=1` con el aviso `login.notices.signedOut` en un banner descartable de la landing.
- Cerrar sesión no borra el mundo ni el lead.

### 8.8 Estados globales de acceso

| Estado | Cuándo (ADR-0015 §3) | es-AR | en |
|---|---|---|---|
| `rateLimited` | `RATE_LIMITED {retryAfterSec}` del BFF (por IP, reenvío o confirmación) | Recibimos muchos pedidos seguidos. Probá de nuevo en {min} min. | We received many requests in a row. Try again in {min} min. |
| `rateLimitedEdge` | 403 de WAF (tope por IP de la regla de rate; sin `retryAfterSec`) | Recibimos muchos pedidos seguidos desde tu conexión. Esperá unos minutos y probá de nuevo. | We received many requests in a row from your connection. Wait a few minutes and try again. |
| `challenge` | Segundo `202` con `x-amzn-waf-action: challenge` después de la recarga `/signup?retry=1` (el desafío silencioso no se resolvió; nunca hay rompecabezas ni CAPTCHA) | No pudimos verificar tu navegador: recargá la página o desactivá el bloqueador de contenido. | We could not verify your browser: reload the page or turn off your content blocker. |
| `signupPaused` | `CAPACITY` de `signup.start` o `signup.resend` (tope global de altas nuevas o disyuntor de reputación abierto) | Las altas nuevas están en pausa por un rato. Probá de nuevo más tarde o escribinos desde "Hablemos". | New sign-ups are paused for a while. Try again later or write to us through "Let's talk". |
| `offline` | Sin red | Parece que no hay conexión. Revisala y probá de nuevo. | There seems to be no connection. Check it and try again. |
| `unexpected` | Error no previsto (con correlation id visible) | Algo salió mal. Probá de nuevo. Código de referencia: {id} | Something went wrong. Try again. Reference code: {id} |

`{min}` = `ceil(retryAfterSec / 60)`. Ningún mensaje dice "ese email ya existe", "ese usuario no existe" ni "esa cuenta
no está confirmada" antes de validar la contraseña. Ningún texto de acceso menciona CAPTCHA, rompecabezas ni "confirmá
que sos una persona": el estándar lo prohíbe (ADR-0015 §3.3).

### 8.9 Legales (`/legal/privacy.html`, `/legal/terms.html`)

Páginas estáticas en es y en (una sección por idioma con ancla `#es`/`#en`, o `privacy.en.html`), con el estilo de la
landing, fecha de vigencia y **versión visible arriba**: la de `LEGAL_VERSIONS.privacy` o `LEGAL_VERSIONS.terms`
(`packages/shared/src/legal-versions.ts`, formato `AAAA-MM-DD`). Cada documento tiene su propia versión; no comparten
id con los consentimientos (el consentimiento `terms` guarda la versión de términos y, aparte, `privacyVersion`). El
contenido obligatorio es el de ADR-0015 §8 (siete puntos); esta tabla fija cómo se dice:

| Punto | Contenido |
|---|---|
| Responsable | Craftech: razón social, domicilio y casilla de privacidad `@craftech.io` que decide el CTO (`docs/pending.md` P-06 puntos 1 y 2). Sin esos datos la página no se publica (WP-52) |
| Qué datos | Email, contraseña (la guarda Amazon Cognito con hash; Craftech no la ve ni la almacena), nombre, empresa y cargo si los diste, consentimientos con fecha y versión, idioma, origen de la visita (UTM y sitio de referencia, sin ruta ni parámetros), fechas de alta y último ingreso, estado de rebote o queja de tu email si lo hubiera, IP convertida en un hash no reversible (48 h) y la cookie técnica del filtro de bots (sin seguimiento). Lo que escribís o subís dentro de la demo tiene que ser sintético |
| Finalidad | Darte acceso a la demo; si lo aceptaste, que Craftech te contacte por esta solución. Nunca se venden ni se ceden |
| Base | Tu consentimiento (Ley 25.326, art. 5) |
| Dónde | AWS, región us-east-1 (Estados Unidos), como encargado del tratamiento: transferencia internacional informada |
| Retención | La de ADR-0015 §6: la cuenta y el lead hasta 24 meses desde tu último ingreso (o desde el alta) o hasta que pidas el borrado; el mundo de demo y lo que cargaste en él hasta que vence (sus horas salen de `guest-limits.ts`) o hasta el borrado, con un respaldo técnico que desaparece a más tardar 4 días después; logs 30 días sin datos personales |
| Derechos | Acceso, rectificación, actualización y supresión (Ley 25.326, arts. 14 a 16), gratis; 10 días corridos para acceso y 5 días hábiles para rectificación o supresión; retiro del consentimiento de contacto en cualquier momento sin perder la cuenta; cómo pedirlo: escribiendo a la casilla de privacidad |
| Autoridad | La leyenda de la Agencia de Acceso a la Información Pública como órgano de control (acceso gratuito cada seis meses salvo interés legítimo; facultad de recibir denuncias) |
| Datos de la demo | Todo lo que ves en la demo es sintético; te pedimos no cargar datos reales |

Términos (`LEGAL_VERSIONS.terms`): demo gratuita con datos sintéticos, sin garantía ni SLA, uso aceptable (no cargar
datos personales reales ni de terceros), límites de uso y vencimiento del mundo (sus valores de `guest-limits.ts`),
Craftech puede cerrar cuentas abusivas, propiedad intelectual de Craftech. **Ninguna mención del concurso** (el guard
escanea `public/legal/`).

### 8.10 Emails de acceso y aviso de lead (neutrales, es y en)

**Emails de cuenta** (ADR-0015 §7): los arma el trigger `AuthCustomMessage` con las plantillas de
`packages/bff/src/auth-triggers/messages/` (se mudan desde `infra/auth-email.ts`) en el idioma de `locale` (o
`ClientMetadata.lang`), y los envía Cognito desde `Legajo listo <no-reply@legajo.demo.craftech.io>` con el
configuration set `…-email-poc`. Todas llevan `{####}` en el cuerpo (nunca en el asunto: Cognito reemplaza el código
solo en el cuerpo), "Si no lo pediste, ignorá este mensaje" y el pie
"Legajo listo · Powered by Craftech · datos 100 % sintéticos" con el enlace a la política de privacidad. Sin enlaces
fuera del dominio de la demo, sin nombres de roles, sin vocabulario de §2.0. Las cuotas por destinatario, dominio y
total, el estado de rebote y el disyuntor (ADR-0015 §3.2) pueden hacer que un email no salga: la pantalla nunca lo dice.

| Mensaje | Asunto es-AR | Asunto en | Cuerpo (resumen) |
|---|---|---|---|
| Código de alta (y su reenvío) | Tu código para Legajo listo | Your Legajo listo code | El código, que vence en 24 h, y "Si no lo pediste, ignorá este mensaje" |
| Recuperación de contraseña | Cambiá tu contraseña de Legajo listo | Change your Legajo listo password | El código, que vence en 1 h, y "Si no lo pediste, ignorá este mensaje: tu contraseña no cambia" |
| Ya tenés una cuenta (`intent: "signup-existing"`) | Ya tenés una cuenta en Legajo listo | You already have a Legajo listo account | "Ya tenés una cuenta en Legajo listo; si fuiste vos, usá este código para entrar con la contraseña que acabás de elegir: {####}. Si no lo pediste, ignorá este mensaje: tu contraseña no cambia." |
| Invitación del personal interno (`AdminCreateUser`) | Tu acceso a Legajo listo | Your Legajo listo access | Usuario, contraseña temporal `{####}` y el enlace a `/login`; nunca se envía a un `GUEST` público |

**Aviso de lead a Craftech** (no lo ve el visitante; ADR-0015 §6, FL-115): la Lambda `LeadNotice`, invocada asíncrona
desde `finalizeSignup` (y reintentada por `GUEST_SWEEP`), envía por el cliente único de SES con el perfil de remitente
**`LEAD_NOTICE`**: `From` `avisos@legajo.demo.craftech.io`; destinatarios del secreto **`LeadNoticeTo`** (hasta 3,
separados por coma; valor inicial `disabled`; el operador carga `janu@craftech.io` o la casilla que decida P-06 punto 3;
**ninguna dirección en el código**); cerco: cada destinatario tiene que ser `<local>@craftech.io` exacto, sin
subdominios, y si no, `RECIPIENT_NOT_ALLOWED` y `noticeStatus DISABLED`.

- Asunto: `[Legajo listo] Nuevo registro en la demo` (uno solo: no hay otra variante del aviso).
- Cuerpo en texto plano (es), **el de ADR-0015 §6**: email, nombre, empresa y cargo si los dio, idioma, si aceptó el
  contacto (con su versión), UTM y host del referrer, hora del alta en ART. Nada más.
- **Pendiente P-06 punto 6** (`docs/pending.md`): la recomendación de esta spec es incluir el email solo si la persona
  aceptó el contacto y, si no, la línea "sin consentimiento de contacto: no contactar". Hasta que el CTO decida rige
  el ADR (email siempre); el cambio, si llega, es solo del cuerpo que arma `LeadNotice`.
- El aviso sale solo desde `finalizeSignup`, después de `SIGNUP#.verifiedAt`, nunca al enviar el formulario (§8.0).
  Su volumen queda acotado por las altas verificadas con código (las cuotas de emails de cuenta de ADR-0015 §3.2 lo
  limitan antes que cualquier otra cosa), así que un bot que llena `/signup` no genera avisos. Un alta que después cae
  en `CAPACITY` en `/welcome` ya generó su aviso: es un lead verificado igual que cualquier otro.

### 8.11 Contrato para el build

Esta spec **no** repite valores del contrato de acceso: la tabla anterior de esta sección quedó reemplazada por
ADR-0015, que es la fuente única. Dónde está cada cosa:

| Tema | Fuente |
|---|---|
| Flujo del alta, ticket, `SignupDispatch`, ramas y prueba de verificación | ADR-0015 §1, §1.1 a §1.3 |
| Datos del alta pendiente y consentimientos | ADR-0015 §2 |
| Capas anti abuso, WAF (desafío silencioso sin SDK), OAC, origen verificado, costo de la protección contra bots | ADR-0015 §3.1 y §3.3 |
| Topes (IP, email, dominio, total, reenvío, confirmación, emails de cuenta, disyuntor) | ADR-0015 §3.2 y `packages/shared/src/guest-limits.ts` |
| Mundo de invitado: cupos, arrendamiento, estados de `account.world`, TTL, destrucción, cuotas por mundo y presupuesto global | ADR-0015 §4 y `guest-limits.ts` |
| Tareas programadas (`GUEST_SWEEP`, `IDLE_GUEST_RESET`, `GUEST_DESTROY`) | ADR-0015 §5 |
| Tabla `Leads`, `LeadNotice`, `leads:export`, `leads:optout`, `leads:delete`, retención y PII | ADR-0015 §6 |
| Procedimientos, entradas y salidas | `docs/tool-catalog.md` "Alta pública" (alineado a ADR-0015) |
| Una sola alta sin modos y estado `CAPACITY` en el primer ingreso | §8.0 y §8.5 de esta spec; ADR-0015 §4 (pedido A-1 a `architect`) |

Lo que el copy necesita de `guest-limits.ts` (nombres sugeridos; `typescript-dev` los fija en WP-50 y esta spec se
refiere a ellos por significado): espera entre reenvíos, reenvíos por alta, códigos errados por alta, horas sin uso y
horas de vida de un mundo público, ventanas y topes de cada `kind` de cuota, y el tope de largo de los campos opcionales.

## 9. Destino de "Hablemos"

Verificado el 2026-09-26 sobre la web pública de Craftech:

| Destino | Verificación | Uso |
|---|---|---|
| `https://craftech.io/contact/` | Responde 200; título "Contact - Craftech"; tiene formulario de contacto propio del sitio. `https://craftech.io/es/contact/` sirve la misma página en inglés y `/contacto/` da 404 | **Destino de "Hablemos"** en es y en |
| `mailto:sales@craftech.io` | Dirección publicada en la misma página | Enlace "Contacto" del footer y alternativa textual bajo el CTA final ("o escribinos a sales@craftech.io" / "or write to sales@craftech.io") |

Enlace: `https://craftech.io/contact/?utm_source=legajo-listo&utm_medium=demo&utm_campaign=poc-landing&utm_content=<ubicación>`
con `<ubicación>` ∈ `header`, `closing`, `footer`, `welcome-failed`, `platform` ("Hablemos de integrarlo", bloque
"Para plataformas" de `#integrations`), `faq` (respuesta de costo) y `welcome-capacity` (estado `CAPACITY` de `/welcome`, §8.5); `target="_blank"`, `rel="noopener noreferrer"`,
ícono de enlace externo y texto accesible "(se abre en una pestaña nueva)" / "(opens in a new tab)". La URL vive en una
sola constante (`CRAFTECH_CONTACT_URL` en `views/landing/links.ts`, ADR-0016 §1); un test verifica el formato. Si la página de contacto cambia, se actualiza
esa constante y se vuelve a verificar con `curl -sI`. No se incrusta ningún formulario de terceros en la landing.

## 10. Requisitos que el plan de construcción tiene que reflejar

Todo requisito de acceso de esta tabla usa la mecánica y los nombres de ADR-0015 (D-12); ninguno repite valores.

| # | Requisito | Dueño sugerido | Sección |
|---|---|---|---|
| B-01 | Renombre del rol de prueba a `GUEST` (código, infra, seed, tests, docs; plantilla `guest`, cuentas `guest-NN` y `guest-test`, variable `GUEST_TEST_PASSWORD`) sin cambiar comportamiento | `typescript-dev`, `devops`, `seed-generator`, `qa` | 0.1, 7.2 |
| B-02 | `npm run lint:neutral-surfaces` con tests por palabra, sobre fuentes visibles y `dist`, en `ci.yml` y `deploy.yml` junto a `lint:forbidden`; misma lista importada por `frame-check.ts` | `devops`, `qa` | 2.0, 5.6 |
| B-03 | Tokens nuevos en `@theme` (color, tipografía, espaciado, radios, sombras, movimiento) y fuente de títulos autoalojada declarada en la ola 0 | `typescript-dev` | 3, 4.2 |
| B-04 | Rediseño de `views/landing/` con las **11 secciones** de §1.2 (incluida `#faq`), copy es/en de §2, recorrido sticky/carrusel, conversación que se escribe sola, contadores, reveals, botón "Pausar animaciones" y reduced motion | `typescript-dev` | 1, 2, 4 |
| B-05 | Chunk separado landing + acceso vs consola; presupuesto de §5.3 con `scripts/landing/bundle-budget.ts`; Lighthouse en la verificación post-deploy | `typescript-dev`, `qa` | 5.3 |
| B-06 | Galería: cambios G-1 a G-11 sobre el `Lightbox` existente | `typescript-dev` | 6 |
| B-07 | Pipeline de capturas: variantes desktop/mobile a 2x, AVIF/WebP/PNG con `encode.ts`, momentos deterministas del mundo `guest`, manifiesto v2 de §7.4 (= ADR-0016 §3) y `scripts/landing/renders.json` con `policy` y `until`, `landing:check`, `landing:renders`, `--base-url` solo `https://legajo.demo.craftech.io` | `typescript-dev`, `qa` | 7 |
| B-08 | Pantallas de acceso en `views/auth/` (signup, verify, login, forgot, reset, welcome, logout) es/en, con los estados de §8.1, §8.5 y §8.8 y ningún número de límite escrito a mano | `typescript-dev` | 8.1-8.8 |
| B-09 | Textos de consentimiento en `packages/shared/src/consent-texts.ts` y versiones en `legal-versions.ts` (`AAAA-MM-DD`), con test de huella | `typescript-dev` | 8.2, 8.9 |
| B-10 | Alta de ADR-0015 §1: `signup.form`/`start`/`resend`/`confirm`, `SignupDispatch`, ticket + `AuthPreSignUp`, `AuthCustomMessage` es/en (incluido "ya tenés una cuenta"), `finalizeSignup`, grupo `GUEST` | `typescript-dev`, `devops`, `security` | 8.2, 8.3, 8.10 |
| B-11 | Mundo de invitado de ADR-0015 §4: `account.ensureWorld` + `account.world` (estados `NONE`/`CREATING`/`READY`/`EXPIRED`/`CAPACITY`/`FAILED`), `GUEST_WORLD_GONE`, `account.usage`, `QUOTA_EXCEEDED` | `typescript-dev` | 8.5 |
| B-12 | WAF de ADR-0015 §3.3 (desafío silencioso sin SDK, `/signup` por navegación completa, recarga `/signup?retry=1`), OAC y origen verificado; sin CAPTCHA | `devops`, `security` | 8.1, 8.2, 8.8 |
| B-13 | `Leads`, `LeadNotice` con el perfil `LEAD_NOTICE` y el secreto `LeadNoticeTo` (solo `<local>@craftech.io`, nunca en código), `leads:export`, `leads:optout`, `leads:delete`; email fuera de logs, auditoría y exports de la demo | `devops`, `typescript-dev`, `security` | 8.10 |
| B-14 | Legales es/en con los puntos de §8.9 (ADR-0015 §8) y su versión visible | `architect` (texto), `typescript-dev` (página) | 8.9 |
| B-15 | "Hablemos" a `CRAFTECH_CONTACT_URL` con las ubicaciones de §9; `sales@craftech.io` como alternativa | `typescript-dev` | 9 |
| B-16 | **Una sola alta, sin modos** (D-11, §8.0): ningún `PublicSignupMode`, `VITE_PUBLIC_SIGNUP_MODE`, `/signup/waitlisted`, estado `WAITLISTED` ni variante de copy, CTA o `robots` por stage; CTA primario siempre "Probar la demo"; lead escrito solo en `finalizeSignup` (después de `verifiedAt`), sin campo de estado ni `emailVerified` (ADR-0015 §1.4); `CAPACITY` de `account.world`/`account.ensureWorld` en el primer ingreso con "Hablemos" (`utm_content=welcome-capacity`) sin crear mundo y con reintento en el próximo ingreso (§8.5); URL compartida solo con las olas 3 a 6 desplegadas y probadas | `typescript-dev`, `devops`, operador | 0.3 D-11, 8.0, 8.5 |
| B-17 | Sección `#faq` (§2.13) y bloque "Para plataformas de comercio exterior" (§1.8, §2.8), cada afirmación con su respaldo | `typescript-dev` | 1.8, 2.13 |
| B-18 | Tests: `landing.test.ts` (§5.6, incluidas la intersección vacía de columnas de `#demo`, los números de impacto y la ausencia de "tu cuenta de AWS"), `e2e/landing.spec.ts`, `e2e/auth.spec.ts` (alta → código → ingreso → mundo listo, reenvío con espera y tope, código errado y alta vencida, recuperación, cierre de sesión, capacidad, mundo vencido, cuotas, ningún lead ni aviso antes de verificar, un envío sin verificar no deja registro en `Leads`, `CONFIRMED` siempre a `/login?welcome=1`; capacidad en el primer ingreso: alta → código → ingreso con el tope de mundos lleno → `CAPACITY` sin mundo, con "Hablemos", y cuenta y lead verificado existentes; con cupo, el próximo ingreso llega a `READY`), `e2e/a11y.spec.ts`; verificación a 390 × 844 y 1440 × 900 con capturas revisadas a ojo; flujos en `docs/flows-catalog.md` y la matriz de `docs/test-plan.md` | `qa` | 5.6, 6, 8 |
| B-19 | Reemplazo de renders `swap` por capturas `origin: "poc"` cuando `SC-24` pase en `poc` (WP-36) | `qa`, operador | 7.3 |
| B-20 | Recorrido guiado y README: copy para `GUEST`, sin cuentas asignadas; notas de la submission solo al final del README | `architect`, `typescript-dev` | 0.3 D-09 |

Pedidos a `architect` que salen de esta revisión (docs que esta spec no edita):

| # | Pedido | Docs |
|---|---|---|
| A-1 | Sacar el modo de alta pública de todos los docs (D-11, §8.0): sin `PublicSignupMode`, `infra/signup-mode.ts`, `VITE_PUBLIC_SIGNUP_MODE`, excepción cercada del modo, respuesta `WAITLISTED` de `signup.start`, `SignupDispatch` de tipo `WAITLIST`, lead `WAITLIST`/`emailVerified: false`/`waitlistedAt`, aviso "Nuevo pedido de acceso", `leads:export --waitlist`, `/signup/waitlisted`, CTA "Pedir acceso", `robots` según el modo, P-07 punto 9 ni métrica `SignupWaitlisted`. Lead solo en `finalizeSignup`, siempre `ACTIVE` (o sin campo `status`). `CAPACITY` de `account.world`/`account.ensureWorld` cuando el tope de mundos activos está lleno, sin crear mundo, reintento en el próximo ingreso; FL-132 pasa a describir ese caso en el primer ingreso, con la matriz de `docs/test-plan.md` al día. `signup.start` conserva `RATE_LIMITED` y `CAPACITY` | ADR-0015, `docs/build-plan.md` (WP-48 a WP-51 y operador), `docs/tool-catalog.md`, `docs/flows-catalog.md` (FL-103, FL-105, FL-132), `docs/test-plan.md`, `docs/pending.md` P-07, `CLAUDE.md` |
| A-2 | Sacar de `docs/build-plan.md` la excepción de precedencia de A2 ("donde §8.11 y §10 difieren…"): §8 ya no difiere de ADR-0015 | `docs/build-plan.md` |
| A-3 | Sumar `policy` y `until` a `scripts/landing/renders.json` en ADR-0016 §3, la excepción de `zoom` en `landing:check` (§7.3) y citar los rótulos de §2.10 como fuente | ADR-0016, FL-128, FL-129 |
| A-4 | Alinear en ADR-0016 lo que sigue distinto: recorrido en mobile (< 768 px carrusel; 768–1023 px apilado, §5.1), presupuestos (los de §5.3, más estrictos, como ya dice WP-48) y Open Graph (captura `og-card` de la propia landing, §7.3) | ADR-0016 §1 y §2 |
| A-5 | `robots.txt` estático, landing y legales siempre indexables (FL-125/FL-127, §5.4), y "11 secciones" en WP-48 | `docs/flows-catalog.md`, `docs/build-plan.md` |
| A-6 | FL-102 (se muestran los intentos que quedan cuando son ≤ 2, sin distinguir errado de vencido), FL-106 (sin `signupId`, a `/signup`; el navegador nunca reenvía directo) y la variante horaria del aviso de cuota de ADR-0015 §4 (§8.5) | `docs/flows-catalog.md`, ADR-0015 |
| A-7 | Si se quiere decir "tus datos en tu cuenta de AWS" o citar que el proveedor del modelo no entrena con los datos, primero un ADR de modelo de despliegue o la cita fechada de los términos de Amazon Bedrock | ADR nuevo |
| A-8 | Si se quiere decir "OpenAPI" también para la plataforma de gestión, publicar su contrato en OpenAPI (hoy es una API REST `/v1` con schema zod) | `docs/architecture-integrations.md` §6 |
