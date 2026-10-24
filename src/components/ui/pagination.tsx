import Link from "next/link";
import styles from "./pagination.module.css";

type PaginationProps = {
  page: number;
  total: number;
  pageSize: number;
  path: string;
  /** Other query values to keep in every link (search text, tab, other lists' pages). */
  query?: Record<string, string | undefined>;
  /** Name of this list's page parameter, so several lists can sit on one page. */
  param?: string;
  label?: string;
};

export function pageFrom(value: string | string[] | undefined): number {
  const parsed = Number.parseInt(Array.isArray(value) ? value[0] : value ?? "1", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function Pagination({ page, total, pageSize, path, query = {}, param = "page", label = "Pages" }: PaginationProps) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (lastPage <= 1) return null;
  const current = Math.min(page, lastPage);
  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
    if (target > 1) params.set(param, String(target));
    const text = params.toString();
    return text ? `${path}?${text}` : path;
  };
  const from = (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  return <nav className={styles.pagination} aria-label={label}>
    {current > 1 ? <Link href={href(current - 1)} scroll={false}>← Previous</Link> : <span aria-disabled="true">← Previous</span>}
    <span className={styles.summary}>{from}–{to} of {total}</span>
    {current < lastPage ? <Link href={href(current + 1)} scroll={false}>Next →</Link> : <span aria-disabled="true">Next →</span>}
  </nav>;
}
