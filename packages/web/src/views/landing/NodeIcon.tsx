// The icon of a node of the architecture views: the AWS service's official architecture icon (public/landing/aws/)
// or, for the firm's own systems and the parties, an icon of the landing on a tile. Decorative: the name
// next to it says what the node is.
import { type NodeVisual } from "./architecture";
import { Icon } from "./icons";

const SIZES = {
  md: { box: "h-10 w-10", icon: "h-5 w-5", px: 40 },
  sm: { box: "h-8 w-8", icon: "h-4 w-4", px: 32 },
} as const;

interface NodeIconProps {
  readonly visual: NodeVisual;
  readonly size?: keyof typeof SIZES;
  /** Tile colours of a landing icon: over a dark band (default) or over paper. */
  readonly tone?: "dark" | "paper";
}

export function NodeIcon({ visual, size = "md", tone = "dark" }: NodeIconProps) {
  const dimensions = SIZES[size];
  if ("aws" in visual) return <img src={visual.aws} alt="" width={dimensions.px} height={dimensions.px} loading="lazy" decoding="async" className={`${dimensions.box} shrink-0 rounded-md`} />;
  return (
    <span aria-hidden="true" className={`flex ${dimensions.box} shrink-0 items-center justify-center rounded-md ${tone === "dark" ? "bg-harbor-800 text-glass" : "bg-manifest-deep text-glass-ink"}`}>
      <Icon name={visual.icon} className={dimensions.icon} />
    </span>
  );
}
