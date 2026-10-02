// The access screens' texts by language. The Spanish deck (copy-es.ts) fixes the shape; the English
// deck has to match it key by key (the type checker refuses a missing or extra key, copy.test.ts
// the rest). Outside an access page (the console's prompts) the Spanish deck is the default.
import type { Language } from "@legajo/shared";
import { AUTH_EN } from "./copy-en";
import { AUTH_ES } from "./copy-es";

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : { readonly [K in keyof T]: Widen<T[K]> };

export type AuthCopy = Widen<typeof AUTH_ES>;

export type AuthLang = Language;

export const AUTH_COPY: Readonly<Record<AuthLang, AuthCopy>> = { es: AUTH_ES, en: AUTH_EN };

/** Digits of a verification or reset code (Cognito's, not a limit of the demo). */
export const CODE_DIGITS = 6;
