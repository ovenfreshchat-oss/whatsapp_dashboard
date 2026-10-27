"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** On desktop, open the first chat when none is chosen. Phones keep the chat list. */
export function AutoSelectFirst({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  useEffect(() => {
    if (window.matchMedia("(min-width: 701px)").matches) {
      router.replace(`/dashboard/inbox?c=${conversationId}`);
    }
  }, [conversationId, router]);
  return null;
}
