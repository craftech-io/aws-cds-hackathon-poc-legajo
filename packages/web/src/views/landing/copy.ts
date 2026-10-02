// Texts of the public landing, in Spanish (Argentina) and English with a switch (docs/design-brief.md
// §7 and §10). Each language lives in its own file with the same type; landing.test.ts checks that
// both carry the same keys and the "what is real and what is simulated" block of §7.2.
import { en } from "./copy-en";
import { es } from "./copy-es";

export type { LandingCopy } from "./copy-es";

export const LANDING_COPY = { es, en } as const;

export type LandingLang = keyof typeof LANDING_COPY;
