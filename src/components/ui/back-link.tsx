import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import styles from "./back-link.module.css";

/** One back link for every screen: a real left-arrow icon, large enough to tap. */
export function BackLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return <Link href={href} className={[styles.backLink, className].filter(Boolean).join(" ")}>
    <ArrowLeft size={20} strokeWidth={2.4} aria-hidden="true" />
    <span>{children}</span>
  </Link>;
}
