// The account menu of the header (FL-108): who is signed in (read from the session, so it shows at
// once: name and email, then role and firm; a guest sees only its role and firm, never its email nor
// its internal username, ADR-0014 §2), then what the account can do: change the password and
// turn on the verification code for brokers and analysts; a guest never sees either (it changes its
// password only through recovery, ADR-0015 §1; the BFF refuses both as well) and sees the usage of its
// trial firm instead (UsageIndicator). Everyone picks the console's language here ("Español | English",
// ADR-0020): it applies at once and is kept with the account. Signing out, for everyone, closes the menu:
// it revokes the refresh token and lands on the landing's "Cerraste sesión".
import type { Language } from "@legajo/shared";
import { useEffect, useId, useRef, useState } from "react";
import { useConsoleLang } from "../../context/ConsoleLangContext";
import { useFirm } from "../../context/FirmContext";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { displayNameOf } from "../../lib/auth-claims";
import { LANGUAGE_NAMES } from "../../lib/console-lang";
import { FilterPills } from "../FilterPills";
import { UsageIndicator } from "./UsageIndicator";

const ITEM_CLASS = "flex min-h-11 w-full items-center rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-paper";

const LANGUAGE_OPTIONS = (["es", "en"] as const satisfies readonly Language[]).map((value) => ({ value, label: LANGUAGE_NAMES[value] }));

/** "Idioma: Español | English": each name in its own language, whatever the console reads now. */
function LanguageChoice() {
  const { lang, setLang } = useConsoleLang();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-mist px-3 py-2">
      <span className="text-sm text-ink">{copy.account.language}</span>
      <FilterPills label={copy.account.language} options={LANGUAGE_OPTIONS} value={lang} onChange={setLang} variant="segmented" />
    </div>
  );
}

function Identity() {
  const principal = usePrincipal();
  const { firmName } = useFirm();
  const name = displayNameOf(principal);
  return (
    <div className="border-b border-mist px-3 pt-2 pb-3">
      {name ? <p className="truncate font-semibold text-navy">{name}</p> : null}
      {!principal.isGuest && principal.email && principal.email !== name ? <p className="truncate text-xs text-slate">{principal.email}</p> : null}
      <p className="mt-1 text-xs text-slate">
        {principal.role ? copy.roles[principal.role] : "—"}
        {firmName ? ` · ${firmName}` : null}
      </p>
    </div>
  );
}

export function AccountMenu() {
  const principal = usePrincipal();
  const { signOut, openPrompt } = useSession();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        className="inline-flex min-h-11 items-center rounded-md border border-mist bg-white px-3 py-2 text-sm font-semibold text-navy hover:bg-paper"
        onClick={() => setOpen((value) => !value)}
      >
        {copy.account.menu}
      </button>
      {open ? (
        <div id={menuId} className="absolute right-0 z-30 mt-2 w-72 rounded-card border border-mist bg-white p-1.5 shadow-card">
          <Identity />
          {principal.isGuest ? null : (
            <div className="border-b border-mist py-1">
              <button type="button" className={ITEM_CLASS} onClick={choose(() => openPrompt("changePassword"))}>
                {copy.account.changePassword}
              </button>
              <button type="button" className={ITEM_CLASS} onClick={choose(() => openPrompt("enrollTotp"))}>
                {copy.account.totp}
              </button>
            </div>
          )}
          <LanguageChoice />
          {principal.isGuest ? <UsageIndicator /> : null}
          <div className="pt-1">
            <button type="button" className={`${ITEM_CLASS} font-semibold text-danger`} onClick={choose(signOut)}>
              {copy.app.signOut}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
