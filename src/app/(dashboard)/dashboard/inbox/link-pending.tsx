"use client";

import { useLinkStatus } from "next/link";
import { Spinner } from "@/components/ui/spinner";

/**
 * Rendered inside a conversation link. While that link is navigating it adds a marker the
 * stylesheet uses to highlight the chat straight away and, only if loading is slow, show a
 * skeleton in the thread pane. The small spinner covers phones, where the thread pane is hidden.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <span data-pending="true" role="status" aria-label="Opening chat" style={{ flex: "none", color: "var(--faint)" }}><Spinner size={16} /></span> : null;
}
