---
status: accepted
---

# Idioma de la consola y preferencia por usuario

Pedido del CTO (2026-10-06): la consola autenticada (todo `/app`) se usa en español rioplatense y en inglés, con un selector en el menú "Mi cuenta", el idioma del navegador como valor inicial y la elección guardada por usuario en el servidor. Complementa a ADR-0008, que fijaba la consola en español: ahora la consola es es-AR **y** en; el importador sigue recibiendo español y el proveedor inglés (esos textos salen del BFF y no se traducen).

## Decisiones

1. **Qué idioma abre.** En este orden: la preferencia de la cuenta (`account.preferences`, una vez que carga), el idioma que el visitante eligió en la landing o en las pantallas de acceso (`legajo.lang` en `localStorage`, el mismo que ya usan), el del navegador (`navigator.languages`: español si alguno es `es*`, inglés si no; `lib/preferred-lang.ts`). Si la persona elige uno en el menú antes de que el servidor conteste, la respuesta tardía no lo pisa.
2. **Dónde se guarda: `Runtime/ACCOUNT#<sub>` / `PREFS`**, una fila por `sub` de Cognito, entidad `AccountPreferences` `{sub, language: "es" | "en"}`, sin TTL y sin sello de mundo. Se escribe con `account.setLanguage` (zod `.strict()`, solo `"es" | "en"`) y se lee con `account.preferences` (`{language: "es" | "en" | null}`; `null` mientras nunca eligió). Ambos son `accountProcedure`: un `GUEST` con o sin mundo pasa con el token verificado (como `guestBootstrapProcedure`), el personal del estudio pasa por la puerta de `firmProcedure` (un broker inactivo se rechaza). El `sub` sale siempre del token, nunca del input. Ningún email en la fila ni en los logs (`account.language_set` registra solo el idioma).
3. **Invitados.** Los mundos de invitado se destruyen y se vuelven a crear (vencen a las 24 h sin uso o a las 72 h de creados, y el reinicio los reconstruye), y su fila `BROKER#brk-guest-<nn>` nace con cada mundo. Por eso la preferencia **no** vive en la fila del broker ni en nada con `clockId`: vive en la cuenta, igual que el arrendamiento `GUESTWORLD#<sub>`, y sobrevive a `destroyWorld`, a "Reiniciar demo" y al mundo siguiente. `leads:delete` y el retiro por retención la borran junto con la cuenta (`leads/delete.ts`).
4. **Mecanismo de textos.** Cada módulo de `copy/` escribe su español como fuente (`const es = {…} as const`), deriva su forma (`Widen<typeof es>`) y escribe el inglés con `satisfies`, de modo que una clave que falta, que sobra o con otro tipo no compila; exporta `localized({ es, en })` (`copy/localized.ts`): un objeto con la forma del español cuyos textos son accesores que leen `activeLang()` (`lib/console-lang.ts`). Las vistas siguen leyendo `copy.seccion.titulo` sin cambios. `ConsoleLangProvider` fija `activeLang()` antes de renderizar la consola y la **remonta** cuando cambia (`key={lang}`): todo texto se vuelve a leer sin que ningún componente se suscriba. Las claves abiertas (`Record<string, string>`) y la aridad de las funciones las compara `copy/localized.test.ts` sobre todos los diccionarios registrados.
5. **Fechas y números.** `lib/format.ts` conserva la zona de Buenos Aires y la regla de no usar los datos de `Intl`; la forma sale del copy: español `mié 14/10 10:30` y `12.480,5`, inglés `Wed 14 Oct 10:30` y `12,480.5`.
6. **Lo que no se traduce**: lo que viene de los datos o del agente (mensajes al importador en español, emails al proveedor en inglés, nombres del seed, valores del lector).
7. **Recorrido guiado.** Pierde su selector propio y lee el idioma de la consola (`steps.ts` conserva sus textos bilingües, que también usan el README y `SC-24`).
8. **Palabras vedadas.** El inglés pasa `lint:neutral-surfaces` y refleja las elecciones del español: "Demo clock", "Phone simulator" y "Demo mailbox" son la traducción fiel de los nombres que el español ya permite dentro de la consola.

## Considered options

- **Atributo `language` en la fila `BROKER#` del usuario.** Gratis para el personal, pero la fila de un invitado se borra y se recrea con cada mundo (ADR-0015 §4): habría que copiarla en cada creación y perderla en cada destrucción.
- **Tabla nueva `Preferences`.** Más infra (spec de tablas, IAM por rol, `iam-capabilities`) para una fila de dos campos; `Runtime` ya guarda por cuenta el arrendamiento y es lo que el `Bff` ya linkea.
- **Atributo de Cognito (`custom:language`).** Habría que sumar la escritura (`AdminUpdateUserAttributes` al rol del BFF) y el valor viajaría en el token de 15 min: un cambio no se vería hasta refrescarlo.
- **Hook por módulo (`useDossierCopy()`) en lugar de accesores.** Tipado y explícito, pero toca unos 60 archivos (vistas, modelos y sus pruebas, que reciben el copy por parámetro) por el mismo resultado; la remontada de un árbol que se renderiza otra vez desde cero es igual de barata.
- **Un diccionario plano con claves (`t("clave")`).** Pierde el tipado por forma que ya tiene el copy y obliga a reescribir cada uso.

## Consequences

- Cambiar de idioma remonta la consola: se pierde el estado local de lo que esté abierto (un cajón, un borrador) y las vistas vuelven a cargar. Es una acción rara y deliberada.
- Un texto leído a un `const` en el nivel del módulo del archivo (`const LABEL = copy.x.y` con un string) queda en el idioma del momento de la carga; el copy se lee dentro del render o de la función que lo usa, o se captura el objeto (`copy.nav.groups`), que sí sigue al idioma. La revisión de módulos lo buscó y no dejó ninguno.
- Mientras el módulo de la consola está montado, `activeLang()` vale lo que muestra; al desmontarse (cerrar sesión) vuelve a `es`, de modo que la landing y las pantallas de acceso, que llevan su propio idioma, nunca leen el de la consola. Las pruebas de Node y de los specs leen español salvo que fijen `setActiveLang`.
- Si guardar con la cuenta falla, la elección sigue vigente en ese navegador y un aviso lo dice; no se reintenta solo.
- La prueba: `routers/account-preferences.test.ts` y `worlds/guest-worlds.test.ts` (FL-133, U), `language.spec.ts` (FL-133, UI) y los `*.test.ts` de paridad de copy.
