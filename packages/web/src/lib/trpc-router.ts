// Router type the console is written against: the real `AppRouter` of the BFF
// (packages/bff/src/routers/index.ts). The import is type-only, so nothing of the BFF reaches the
// bundle; the Node reference is needed only because the type checker walks the BFF sources
// behind that type, which use Node globals (Buffer, process) the browser program does not declare.
/// <reference types="node" />
import type { AppRouter } from "@legajo/bff";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type { AppRouter };

/** What each procedure answers, e.g. `RouterOutputs["operations"]["list"]`. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** What each procedure takes, e.g. `RouterInputs["dossier"]["approve"]`. */
export type RouterInputs = inferRouterInputs<AppRouter>;
