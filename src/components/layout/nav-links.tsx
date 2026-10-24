"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./dashboard-shell.module.css";

type Item = { href: string; icon: string; label: string; short?: string; match: string[]; adminOnly?: boolean };

const ITEMS: Item[] = [
  { href: "/dashboard", icon: "⌂", label: "Dashboard", match: [] },
  { href: "/dashboard/contacts", icon: "◎", label: "Contacts", match: ["/dashboard/contacts", "/dashboard/opt-outs"], adminOnly: true },
  { href: "/dashboard/campaigns", icon: "▦", label: "Campaigns", match: ["/dashboard/campaigns"], adminOnly: true },
  { href: "/dashboard/inbox", icon: "✉", label: "Inbox", match: ["/dashboard/inbox"], adminOnly: true },
  { href: "/dashboard/meta", icon: "⚙", label: "WhatsApp setup", short: "Setup", match: ["/dashboard/meta"], adminOnly: true },
];

function isActive(item: Item, pathname: string) {
  if (item.href === "/dashboard") return pathname === "/dashboard";
  return item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Highlights the tapped item immediately, before the next page has loaded, so a click always
 * feels instant. The highlight follows the real URL once navigation finishes.
 */
export function NavLinks({ showAdminLinks }: { showAdminLinks: boolean }) {
  const pathname = usePathname();
  const [clicked, setClicked] = useState<string | null>(null);
  useEffect(() => setClicked(null), [pathname]);
  const current = clicked ?? pathname;

  return <>
    {ITEMS.filter((item) => showAdminLinks || !item.adminOnly).map((item) => {
      const active = isActive(item, current);
      return <Link
        key={item.href}
        href={item.href}
        className={[styles.navItem, active ? styles.navItemActive : ""].filter(Boolean).join(" ")}
        aria-current={active ? "page" : undefined}
        onClick={() => setClicked(item.href)}
      >
        <span className={styles.navIcon} aria-hidden="true">{item.icon}</span>
        {item.short
          ? <><span className={styles.labelFull}>{item.label}</span><span className={styles.labelShort}>{item.short}</span></>
          : <span>{item.label}</span>}
      </Link>;
    })}
  </>;
}
