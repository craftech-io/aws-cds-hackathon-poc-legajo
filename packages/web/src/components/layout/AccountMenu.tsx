// The account menu of the header: change the password and turn on the verification code for
// brokers and analysts, sign out for everyone. A guest never sees the password change nor TOTP (it
// changes its password only through recovery, ADR-0015 §1; the BFF refuses both as well); it sees the
// usage of its demo instead (UsageIndicator). Signing out revokes the refresh token and lands on the
// landing's "Cerraste sesión" (FL-108).
import { useEffect, useId, useRef, useState } from "react";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { UsageIndicator } from "./UsageIndicator";

const ITEM_CLASS = "block w-full rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-paper";

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
        className="rounded-md border border-mist bg-white px-3 py-2 text-sm font-semibold text-navy hover:bg-paper"
        onClick={() => setOpen((value) => !value)}
      >
        {copy.account.menu}
      </button>
      {open ? (
        <div id={menuId} className="absolute right-0 z-30 mt-2 w-60 rounded-card border border-mist bg-white p-1.5 shadow-card">
          {principal.isGuest ? null : (
            <>
              <button type="button" className={ITEM_CLASS} onClick={choose(() => openPrompt("changePassword"))}>
                {copy.account.changePassword}
              </button>
              <button type="button" className={ITEM_CLASS} onClick={choose(() => openPrompt("enrollTotp"))}>
                {copy.account.totp}
              </button>
            </>
          )}
          {principal.isGuest ? <UsageIndicator /> : null}
          <button type="button" className={ITEM_CLASS} onClick={choose(signOut)}>
            {copy.app.signOut}
          </button>
        </div>
      ) : null}
    </div>
  );
}
