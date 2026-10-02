// The English gloss of the tour's phones, one choice for the whole tour (on by default on the English
// page). FitToSlot scales a step's visual down to fit its slot, so a control drawn inside the phone
// would shrink under 44 px: inside the tour the phones follow this choice and the toggle lives in the
// step's footer, outside the scaled visual, at its full size. React context, no state library.
import { type ReactNode, createContext, useContext, useMemo, useState } from "react";
import { useLandingCopy, useLandingLang } from "./lang";

interface GlossValue {
  readonly gloss: boolean;
  readonly setGloss: (gloss: boolean) => void;
}

const GlossContext = createContext<GlossValue | undefined>(undefined);

export function GlossProvider({ children }: { readonly children: ReactNode }) {
  const english = useLandingLang()?.lang === "en";
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const gloss = chosen ?? english;
  const value = useMemo(() => ({ gloss, setGloss: setChosen }), [gloss]);
  return <GlossContext.Provider value={value}>{children}</GlossContext.Provider>;
}

/** The tour's choice, or undefined outside the tour (the phone keeps its own toggle). */
export function useSharedGloss(): GlossValue | undefined {
  return useContext(GlossContext);
}

/** "Glosa en inglés": the tour's toggle, 44 × 44 px at least, on the dark band. */
export function GlossToggle() {
  const { phone } = useLandingCopy();
  const shared = useSharedGloss();
  if (!shared) return null;
  return (
    <button
      type="button"
      aria-pressed={shared.gloss}
      title={phone.glossToggle}
      onClick={() => shared.setGloss(!shared.gloss)}
      data-gloss-toggle=""
      className={`inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-pill border px-3 font-semibold ${shared.gloss ? "border-glass bg-glass text-harbor-950" : "border-harbor-700 text-foam hover:border-foam-muted"}`}
    >
      <span className="font-bold">EN</span>
      {phone.glossButton}
    </button>
  );
}
