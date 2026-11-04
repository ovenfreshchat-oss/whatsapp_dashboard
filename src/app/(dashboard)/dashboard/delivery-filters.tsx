"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./dashboard.module.css";

const DAY = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PRESETS = [7, 30, 60, 90] as const;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const todayYmd = () => { const n = new Date(); return ymd(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); };
const label = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3)} ${day.slice(0, 4)}`;
const monthOf = (day: string) => ({ y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)) - 1 });
const shift = (view: { y: number; m: number }, by: number) => {
  const total = view.y * 12 + view.m + by;
  return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
};

/** Cells of one month, Sunday first. Null pads the first week. */
function cells(view: { y: number; m: number }): (string | null)[] {
  const lead = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
  const count = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
  const out: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= count; d++) out.push(ymd(Date.UTC(view.y, view.m, d)));
  return out;
}

type Campaign = { id: string; name: string };

/** Date range picker (presets and a two-month calendar) plus the campaign filter. Applies by changing the page URL. */
export function DeliveryFilters({ from, to, campaignId, campaigns }: {
  from: string; to: string; campaignId: string | null; campaigns: Campaign[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState<string>(from);
  const [draftTo, setDraftTo] = useState<string | null>(to);
  const [hover, setHover] = useState<string | null>(null);
  const [preset, setPreset] = useState<number | "custom">("custom");
  const [view, setView] = useState(() => shift(monthOf(to), -1));
  const today = todayYmd();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  function go(nextFrom: string, nextTo: string, nextCampaign: string | null) {
    const query = new URLSearchParams({ from: nextFrom, to: nextTo });
    if (nextCampaign) query.set("campaign", nextCampaign);
    router.push(`${pathname}?${query.toString()}`, { scroll: false });
  }

  function openPicker() {
    setDraftFrom(from); setDraftTo(to); setHover(null); setPreset("custom"); setView(shift(monthOf(to), -1));
    setOpen(true);
  }

  function applyPreset(days: number) {
    setPreset(days);
    setDraftFrom(ymd(ms(today) - (days - 1) * DAY));
    setDraftTo(today);
    setHover(null);
    setView(shift(monthOf(today), -1));
  }

  function pick(day: string) {
    if (day > today) return;
    setPreset("custom");
    if (draftTo !== null) { setDraftFrom(day); setDraftTo(null); return; }
    if (day < draftFrom) { setDraftTo(draftFrom); setDraftFrom(day); } else setDraftTo(day);
    setHover(null);
  }

  const rangeEnd = draftTo ?? (hover && hover >= draftFrom ? hover : draftFrom);

  function month(offset: number) {
    const shown = shift(view, offset);
    return <div className={styles.calMonth} key={offset}>
      <div className={styles.calMonthHead}>
        {offset === 0 ? <button type="button" className={styles.calNav} onClick={() => setView(shift(view, -1))} aria-label="Previous month"><ChevronLeft size={16} /></button> : <span className={styles.calNavGap} />}
        <strong>{MONTHS[shown.m]} {shown.y}</strong>
        {offset === 1 ? <button type="button" className={styles.calNav} onClick={() => setView(shift(view, 1))} aria-label="Next month"><ChevronRight size={16} /></button> : <span className={styles.calNavGap} />}
      </div>
      <div className={styles.calGrid} role="grid">
        {WEEKDAYS.map((w) => <span key={w} className={styles.calWeekday}>{w}</span>)}
        {cells(shown).map((day, index) => {
          if (!day) return <span key={`e${index}`} />;
          const future = day > today;
          const isStart = day === draftFrom;
          const isEnd = day === rangeEnd;
          const inRange = day >= draftFrom && day <= rangeEnd;
          const cls = [styles.calDay, inRange ? styles.calInRange : "", isStart || (draftTo !== null && isEnd) ? styles.calEdge : "", future ? styles.calFuture : ""].join(" ");
          return <button key={day} type="button" className={cls} disabled={future} onClick={() => pick(day)}
            onMouseEnter={() => { if (draftTo === null) setHover(day); }}
            aria-label={label(day)} aria-pressed={inRange}>{Number(day.slice(8, 10))}</button>;
        })}
      </div>
    </div>;
  }

  return <div className={styles.filterBar} ref={root}>
    <div className={styles.pickerWrap}>
      <span className={styles.filterLabel}>Date range</span>
      <button type="button" className={styles.pickerButton} onClick={() => (open ? setOpen(false) : openPicker())} aria-expanded={open} aria-haspopup="dialog">
        <CalendarDays size={16} aria-hidden="true" />{label(from)} - {label(to)}
      </button>
      {open && <div className={styles.pickerPop} role="dialog" aria-label="Choose a date range">
        <div className={styles.pickerBody}>
          <div className={styles.presetList}>
            {PRESETS.map((days) => <label key={days} className={styles.presetItem}>
              <input type="radio" name="preset" checked={preset === days} onChange={() => applyPreset(days)} />Last {days} days</label>)}
            <label className={styles.presetItem}><input type="radio" name="preset" checked={preset === "custom"} onChange={() => setPreset("custom")} />Custom</label>
          </div>
          <div className={styles.calendars}>{month(0)}{month(1)}</div>
        </div>
        <div className={styles.pickerFoot}>
          <span>{draftTo ? `${label(draftFrom)} - ${label(draftTo)}` : `${label(draftFrom)} - pick an end date`}<small>Dates are in UTC</small></span>
          <div className={styles.pickerActions}>
            <button type="button" className={styles.pickerCancel} onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className={styles.pickerUpdate} disabled={!draftTo}
              onClick={() => { if (draftTo) { setOpen(false); go(draftFrom, draftTo, campaignId); } }}>Update</button>
          </div>
        </div>
      </div>}
    </div>
  </div>;
}
