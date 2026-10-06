// Renders one remote state: a quiet placeholder while the first answer arrives, the previous data
// (marked as updating) during a reload, the error notice on failure and `children(data)` otherwise.
import type { ReactNode } from "react";
import { dataCopy } from "../copy/console-data";
import type { RemoteState } from "../lib/use-remote";
import { ApiErrorNotice } from "./ApiErrorNotice";
import { Spinner } from "./Spinner";

interface RemoteBlockProps<T> {
  readonly state: RemoteState<T>;
  readonly onRetry?: () => void;
  /** What an idle state shows (nothing selected yet); nothing by default. */
  readonly idle?: ReactNode;
  readonly children: (data: T) => ReactNode;
}

export function LoadingBlock({ label = dataCopy.loading }: { readonly label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 rounded-card border border-mist bg-white px-6 py-8 text-sm text-slate shadow-card">
      <span className="text-cyan-deep">
        <Spinner size="md" />
      </span>
      {label}
    </div>
  );
}

// Ready data and a reload of it render inside the same wrapper, so a reload never remounts what the
// view shows (a form keeps what was typed and the outcome of its last action).
function DataFrame({ busy, children }: { readonly busy: boolean; readonly children: ReactNode }) {
  return (
    <div aria-busy={busy} className="relative">
      {busy ? (
        <span role="status" className="absolute top-2 right-2 z-10 inline-flex items-center gap-2 rounded-pill border border-mist bg-white px-3 py-1 text-xs text-slate shadow-card">
          <span className="text-cyan-deep">
            <Spinner />
          </span>
          {dataCopy.updating}
        </span>
      ) : null}
      <div className={`transition-opacity ${busy ? "opacity-60" : ""}`}>{children}</div>
    </div>
  );
}

export function RemoteBlock<T>({ state, onRetry, idle = null, children }: RemoteBlockProps<T>) {
  switch (state.status) {
    case "idle":
      return <>{idle}</>;
    case "loading":
      if (state.previous === undefined) return <LoadingBlock />;
      return <DataFrame busy>{children(state.previous)}</DataFrame>;
    case "error":
      return <ApiErrorNotice error={state.error} {...(onRetry ? { onRetry } : {})} />;
    case "ready":
      return <DataFrame busy={false}>{children(state.data)}</DataFrame>;
  }
}
