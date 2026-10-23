"use client";

import { useLinkStatus } from "next/link";

/**
 * Rendered inside a conversation link. While that link is navigating it adds a marker the
 * stylesheet uses to swap the thread pane for a skeleton, so a click answers instantly.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <span data-pending="true" aria-hidden="true" /> : null;
}
