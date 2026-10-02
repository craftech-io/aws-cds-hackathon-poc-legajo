// "Cerraste sesión" above the landing after a sign-out (`/?signedOut=1`, docs/landing-spec.md §8.7,
// FL-108): a notice the visitor can dismiss, in the language the landing opens with. Dismissing it
// drops the parameter from the address, so a reload does not bring it back.
import { useState } from "react";
import { useRouter } from "../../lib/router";
import { SIGNED_OUT_PARAM } from "../../routes";
import { AUTH_COPY } from "./copy";
import { currentLang } from "./lang";
import { isSignedOutLanding } from "./session";

export function SignedOutNotice() {
  const { path, search, navigate } = useRouter();
  const [lang] = useState(() => currentLang(search));
  if (!isSignedOutLanding(search)) return null;
  const copy = AUTH_COPY[lang];
  const dismiss = () => {
    const rest = new URLSearchParams(search);
    rest.delete(SIGNED_OUT_PARAM);
    const query = rest.toString();
    navigate(`${path}${query ? `?${query}` : ""}`, { replace: true });
  };
  return (
    <div role="status" className="flex items-center justify-center gap-3 bg-harbor-900 px-gutter py-2 text-sm text-foam">
      <p>{copy.login.notices.signedOut}</p>
      <button type="button" onClick={dismiss} className="min-h-11 rounded-pill px-3 font-semibold text-glass underline-offset-4 hover:underline">
        {copy.signOut.dismiss}
      </button>
    </div>
  );
}
