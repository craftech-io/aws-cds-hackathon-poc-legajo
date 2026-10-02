// The global states of the access screens as one alert (docs/landing-spec.md §8.8): too many requests
// (from the BFF, with its minutes, or from WAF's rate rule), a browser that could not pass the silent
// challenge, sign-ups paused, offline and the unexpected with its reference code. None says whether an
// email or an account exists, and none mentions a puzzle: there is none.
import { contactHref, EXTERNAL_LINK } from "../landing/links";
import { useAuthCopy } from "./AuthLang";
import { ErrorNote } from "./form-parts";

export type AccessState =
  | { readonly kind: "rateLimited"; readonly minutes: number }
  | { readonly kind: "rateLimitedEdge" }
  | { readonly kind: "challenge" }
  | { readonly kind: "signupPaused" }
  | { readonly kind: "offline" }
  | { readonly kind: "unexpected"; readonly reference: string };

export function AccessNotice({ state }: { readonly state: AccessState }) {
  const copy = useAuthCopy();
  switch (state.kind) {
    case "rateLimited":
      return <ErrorNote>{copy.states.rateLimited(state.minutes)}</ErrorNote>;
    case "rateLimitedEdge":
      return <ErrorNote>{copy.states.rateLimitedEdge}</ErrorNote>;
    case "challenge":
      return <ErrorNote>{copy.states.challenge}</ErrorNote>;
    case "offline":
      return <ErrorNote>{copy.states.offline}</ErrorNote>;
    case "unexpected":
      return <ErrorNote>{copy.states.unexpected(state.reference)}</ErrorNote>;
    case "signupPaused":
      return (
        <ErrorNote>
          <p>{copy.states.signupPaused}</p>
          <a href={contactHref("footer")} {...EXTERNAL_LINK} className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
            {copy.states.talk}
            <span className="sr-only"> {copy.layout.newTab}</span>
          </a>
        </ErrorNote>
      );
  }
}
