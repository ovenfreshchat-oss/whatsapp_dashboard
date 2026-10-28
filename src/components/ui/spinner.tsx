import { Loader2 } from "lucide-react";

/** Small spinning indicator for buttons and inline loading states. */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span role={label ? "status" : undefined} aria-label={label} style={{ display: "inline-flex", lineHeight: 0 }}>
      <Loader2 size={size} aria-hidden="true" style={{ animation: "spin .8s linear infinite" }} />
    </span>
  );
}
