"use client";

import { useEffect, useState } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, Megaphone, MessageSquare, PlugZap, UserPlus, Loader2, Ellipsis, type LucideIcon } from "lucide-react";
import { usePageLoading } from "./page-loading";
import styles from "./dashboard-shell.module.css";

type Item = { href: string; icon: LucideIcon; label: string; short?: string; match: string[]; access?: "work" | "admin"; /** Stays in the phone tab bar; the rest move under "More". */ primary?: boolean };

const ITEMS: Item[] = [
  { primary: true, href: "/dashboard", icon: LayoutDashboard, label: "Dashboard", match: [] },
  { primary: true, href: "/dashboard/contacts", icon: Users, label: "Contacts", match: ["/dashboard/contacts", "/dashboard/opt-outs"], access: "work" },
  { primary: true, href: "/dashboard/campaigns", icon: Megaphone, label: "Campaigns", match: ["/dashboard/campaigns", "/dashboard/templates"], access: "work" },
  { primary: true, href: "/dashboard/inbox", icon: MessageSquare, label: "Inbox", match: ["/dashboard/inbox"], access: "work" },
  { href: "/dashboard/meta", icon: PlugZap, label: "WhatsApp setup", short: "Setup", match: ["/dashboard/meta"], access: "admin" },
  { href: "/dashboard/users/new", icon: UserPlus, label: "Team", match: ["/dashboard/users"], access: "admin" },
];

function isActive(item: Item, pathname: string) {
  if (item.href === "/dashboard") return pathname === "/dashboard";
  return item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Swaps the icon for a spinner while this link's page is loading, so every tap gets an answer. */
function NavIcon({ icon: Icon, busy = false }: { icon: LucideIcon; busy?: boolean }) {
  const { pending: linkPending } = useLinkStatus();
  const pending = linkPending || busy;
  return <span className={styles.navIcon} aria-hidden="true">
    {pending ? <Loader2 size={20} className={styles.navSpin} /> : <Icon size={20} strokeWidth={1.9} />}
  </span>;
}

/**
 * Highlights the tapped item immediately, before the next page has loaded, so a click always
 * feels instant. The highlight follows the real URL once navigation finishes.
 */
/** On a phone the bar holds this many tabs; anything beyond it goes under "More". */
const PHONE_TAB_LIMIT = 5;

export function NavLinks({ isAdmin, canWork }: { isAdmin: boolean; canWork: boolean }) {
  const pathname = usePathname();
  const [clicked, setClicked] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setClicked(null); setMoreOpen(false); }, [pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && (event.target as Element | null)?.closest("[data-more-root]")) return;
      setMoreOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("mousedown", close); };
  }, [moreOpen]);
  const current = clicked ?? pathname;
  const pageLoading = usePageLoading();

  const items = ITEMS.filter((item) => !item.access || (item.access === "admin" ? isAdmin : canWork));
  const useMore = items.length > PHONE_TAB_LIMIT;
  const overflow = useMore ? items.filter((item) => !item.primary) : [];
  const overflowActive = overflow.some((item) => isActive(item, current));
  const linkProps = (item: Item) => {
    const active = isActive(item, current);
    return {
      href: item.href,
      "aria-current": active ? ("page" as const) : undefined,
      title: item.label,
      onClick: () => setClicked(item.href),
      className: [styles.navItem, active ? styles.navItemActive : ""].filter(Boolean).join(" "),
    };
  };

  return <>
    {items.map((item) => {
      const props = linkProps(item);
      if (useMore && !item.primary) props.className = `${props.className} ${styles.navOverflow}`;
      return <Link key={item.href} {...props}>
        <NavIcon icon={item.icon} busy={pageLoading && isActive(item, current)} />
        {item.short
          ? <><span className={styles.labelFull}>{item.label}</span><span className={styles.labelShort}>{item.short}</span></>
          : <span className={styles.label}>{item.label}</span>}
      </Link>;
    })}
    {useMore && <div className={styles.moreRoot} data-more-root>
      <button type="button" className={[styles.navItem, styles.moreButton, overflowActive || moreOpen ? styles.navItemActive : ""].filter(Boolean).join(" ")}
        aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => setMoreOpen((open) => !open)}>
        <span className={styles.navIcon} aria-hidden="true"><Ellipsis size={20} strokeWidth={1.9} /></span>
        <span className={styles.labelShort}>More</span>
      </button>
      {moreOpen && <div className={styles.moreMenu} role="menu" aria-label="More sections">
        {overflow.map((item) => {
          const props = linkProps(item);
          const Icon = item.icon;
          return <Link key={item.href} {...props} role="menuitem" className={[styles.moreItem, isActive(item, current) ? styles.moreItemActive : ""].filter(Boolean).join(" ")}>
            <Icon size={20} strokeWidth={1.9} aria-hidden="true" />{item.label}
          </Link>;
        })}
      </div>}
    </div>}
  </>;
}
