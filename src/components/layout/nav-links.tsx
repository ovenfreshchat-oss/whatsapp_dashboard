"use client";

import { useEffect, useState } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, Megaphone, MessageSquare, PlugZap, Loader2, type LucideIcon } from "lucide-react";
import styles from "./dashboard-shell.module.css";

type Item = { href: string; icon: LucideIcon; label: string; short?: string; match: string[]; adminOnly?: boolean };

const ITEMS: Item[] = [
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard", match: [] },
  { href: "/dashboard/contacts", icon: Users, label: "Contacts", match: ["/dashboard/contacts", "/dashboard/opt-outs"], adminOnly: true },
  { href: "/dashboard/campaigns", icon: Megaphone, label: "Campaigns", match: ["/dashboard/campaigns", "/dashboard/templates"], adminOnly: true },
  { href: "/dashboard/inbox", icon: MessageSquare, label: "Inbox", match: ["/dashboard/inbox"], adminOnly: true },
  { href: "/dashboard/meta", icon: PlugZap, label: "WhatsApp setup", short: "Setup", match: ["/dashboard/meta"], adminOnly: true },
];

function isActive(item: Item, pathname: string) {
  if (item.href === "/dashboard") return pathname === "/dashboard";
  return item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Swaps the icon for a spinner while this link's page is loading, so every tap gets an answer. */
function NavIcon({ icon: Icon }: { icon: LucideIcon }) {
  const { pending } = useLinkStatus();
  return <span className={styles.navIcon} aria-hidden="true">
    {pending ? <Loader2 size={20} className={styles.navSpin} /> : <Icon size={20} strokeWidth={1.9} />}
  </span>;
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
        title={item.label}
        onClick={() => setClicked(item.href)}
      >
        <NavIcon icon={item.icon} />
        {item.short
          ? <><span className={styles.labelFull}>{item.label}</span><span className={styles.labelShort}>{item.short}</span></>
          : <span className={styles.label}>{item.label}</span>}
      </Link>;
    })}
  </>;
}
