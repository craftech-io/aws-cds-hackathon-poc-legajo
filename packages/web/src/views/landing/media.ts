// The landing's pictures at run time: public/landing/manifest.json (version 2, manifest.ts) read once per
// visit after the first render and parsed with zod, so a picture changes without touching code. If the
// manifest cannot be read the landing simply shows no pictures and says so where the gallery would be.
import { useEffect, useState } from "react";
import { fetchWithRetry } from "../../lib/http";
import { LandingManifest } from "./manifest";

export const MANIFEST_URL = "/landing/manifest.json";

export type MediaState = { readonly status: "loading" } | { readonly status: "ready"; readonly manifest: LandingManifest } | { readonly status: "unavailable" };

let cached: Promise<LandingManifest> | undefined;

function loadManifest(): Promise<LandingManifest> {
  cached ??= fetchWithRetry(MANIFEST_URL, { headers: { accept: "application/json" } }, { attempts: 2, timeoutMs: 8_000 })
    .then(async (response) => {
      if (!response.ok) throw new Error(`manifest answered ${response.status}`);
      return LandingManifest.parse(await response.json());
    })
    .catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
  return cached;
}

export function useLandingMedia(): MediaState {
  const [state, setState] = useState<MediaState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    loadManifest().then(
      (manifest) => active && setState({ status: "ready", manifest }),
      () => active && setState({ status: "unavailable" }),
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}
