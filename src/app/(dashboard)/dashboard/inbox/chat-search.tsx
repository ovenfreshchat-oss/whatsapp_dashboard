"use client";

import { useRef } from "react";
import styles from "./inbox.module.css";

/** Filters the already-loaded chat list by name, number or last message. */
export function ChatSearch() {
  const ref = useRef<HTMLInputElement>(null);
  function filter(value: string) {
    const query = value.trim().toLowerCase();
    const list = ref.current?.closest("nav")?.querySelectorAll<HTMLLIElement>("li[data-search]");
    list?.forEach((item) => { item.hidden = query !== "" && !(item.dataset.search ?? "").includes(query); });
  }
  return <div className={styles.searchWrap}>
    <input ref={ref} type="search" className={styles.search} placeholder="Search chats" aria-label="Search chats" onChange={(event) => filter(event.target.value)} />
  </div>;
}
