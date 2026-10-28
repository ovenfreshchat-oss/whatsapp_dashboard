import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import {
  conversationTitle,
  formatClock,
  formatDayLabel,
  formatListTime,
  formatPhone,
  sameDay,
  isUuid,
  replyWindow,
  safeTimeZone,
} from "@/server/inbox/format";
import { getThread, listConversations, type InboxMessage } from "@/server/inbox/store";
import { AutoRefresh, MarkRead, MessageList } from "./live";
import { ChatSearch } from "./chat-search";
import { AutoSelectFirst } from "./auto-select";
import { LinkPending } from "./link-pending";
import { ReplyForm } from "./reply-form";
import styles from "./inbox.module.css";

export const metadata: Metadata = {
  title: "WhatsApp inbox | Solalyn",
  description: "Read customer WhatsApp messages and reply within the 24-hour window.",
};

function MediaView({ id, media }: { id: string; media: NonNullable<InboxMessage["media"]> }) {
  const src = `/api/inbox/media/${id}`;
  if (media.kind === "image" || media.kind === "sticker") {
    // eslint-disable-next-line @next/next/no-img-element
    return <a href={src} target="_blank" rel="noreferrer"><img className={styles.mediaImage} src={src} alt={media.kind} loading="lazy" /></a>;
  }
  if (media.kind === "video") return <video className={styles.mediaImage} src={src} controls preload="metadata" />;
  if (media.kind === "audio") return <audio src={src} controls preload="none" />;
  return <a className={styles.mediaFile} href={src} target="_blank" rel="noreferrer">Download {media.filename ?? "file"}</a>;
}

/** Stable light colour per customer so chats are easy to tell apart. */
function avatarStyle(seed: string): { background: string; color: string } {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return { background: `hsl(${hue} 70% 86%)`, color: `hsl(${hue} 45% 26%)` };
}

function Ticks({ status }: { status: string }) {
  const label = status === "read" ? "Read" : status === "delivered" ? "Delivered" : status === "sent" ? "Sent" : status === "failed" ? "Failed" : status === "uncertain" ? "Outcome uncertain" : "Sending";
  if (status === "failed" || status === "uncertain") return <span className={styles.tickFailed} role="img" aria-label={label} title={label}>!</span>;
  if (status === "sending") return <span className={styles.tick} role="img" aria-label={label} title={label}>🕓</span>;
  const double = status === "delivered" || status === "read";
  return <svg className={[styles.tick, status === "read" ? styles.tickRead : ""].join(" ")} viewBox="0 0 18 12" width="16" height="11" role="img" aria-label={label}>
    <title>{label}</title>
    <path d="M1 6.5 4.5 10 11 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    {double && <path d="M7 9.2 7.9 10 14.5 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
  </svg>;
}

function Bubble({ message, timeZone }: { message: InboxMessage; timeZone: string }) {
  const outbound = message.direction === "outbound";
  const placeholder = message.body?.startsWith("[") && message.body.endsWith("]") && message.message_type !== "text";
  return (
    <li className={[styles.bubbleRow, outbound ? styles.rowOut : styles.rowIn].join(" ")}>
      <div className={[styles.bubble, outbound ? styles.bubbleOut : styles.bubbleIn].join(" ")}>
        {message.media && <MediaView id={message.id} media={message.media} />}
        {message.message_type === "reaction" && (
          <p className={styles.bubbleText}>
            {message.reacted?.emoji ? <><span className={styles.reactionBig}>{message.reacted.emoji}</span> Reacted to a message</> : "Removed a reaction"}
          </p>
        )}
        {message.message_type !== "reaction" && !(message.media && placeholder) && (
          <p className={[styles.bubbleText, placeholder ? styles.bubblePlaceholder : ""].filter(Boolean).join(" ")}>
            {message.body ?? "[empty message]"}
          </p>
        )}
        {message.reaction && <span className={styles.reactionBadge}>{message.reaction}</span>}
        <span className={styles.bubbleMeta}>
          {formatClock(message.event_at, timeZone)}
          {outbound && <Ticks status={message.status} />}
        </span>
        {outbound && (message.status === "failed" || message.status === "uncertain") && message.error_summary && (
          <span className={styles.bubbleError}>{message.error_summary}</span>
        )}
      </div>
    </li>
  );
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  const rawSelected = (await searchParams).c;
  const selectedId = typeof rawSelected === "string" && isUuid(rawSelected) ? rawSelected : null;
  const timeZone = safeTimeZone(process.env.INBOX_TIME_ZONE?.trim() || process.env.WHATSAPP_SEND_TIME_ZONE?.trim());

  const [list, thread] = await Promise.all([
    listConversations(),
    selectedId ? getThread(selectedId) : Promise.resolve(null),
  ]);

  const replyWin = thread ? replyWindow(thread.conversation.last_inbound_at) : null;
  let lockReason: string | null = null;
  if (thread && replyWin) {
    if (thread.safety.optedOut) lockReason = "This customer has opted out. Replies are disabled.";
    else if (thread.safety.unavailable) lockReason = "Safety checks are unavailable right now. Refresh to try again.";
    else if (!replyWin.open) lockReason = "The 24-hour reply window has closed. WhatsApp only allows an approved template until the customer writes again.";
  }

  return <>
    <AutoRefresh />
    {!selectedId && list.ready && list.conversations[0] && <AutoSelectFirst conversationId={list.conversations[0].id} />}
    <div className={styles.content} data-inbox data-thread-open={selectedId ? "" : undefined}>
      {!list.ready && <section className={styles.notice}>
        <strong>{list.reason === "not-configured" ? "Meta sender configuration is incomplete." : "Inbox storage is unavailable."}</strong>
        <p>{list.reason === "not-configured"
          ? "Complete the Meta and Supabase server settings to read customer messages."
          : <>Apply <code>drizzle/0006_inbox.sql</code> to the configured Supabase database.</>}</p>
      </section>}

      {list.ready && <section className={[styles.layout, selectedId ? styles.layoutThreadOpen : ""].filter(Boolean).join(" ")} aria-label="Inbox">
        <nav className={styles.list} aria-label="Conversations">
          <div className={styles.listHeading}><strong>Chats</strong><span>{list.total}</span></div>
          <ChatSearch />
          {list.conversations.length === 0 && <p className={styles.empty}>No customer messages yet. They appear here after a customer writes to your WhatsApp number.</p>}
          <ul>
            {list.conversations.map((item) => {
              const active = item.id === selectedId;
              return <li key={item.id} data-search={`${conversationTitle(item.profile_name, item.wa_id)} ${item.wa_id} ${item.last_message_preview ?? ""}`.toLowerCase()}>
                <Link href={`/dashboard/inbox?c=${item.id}`} aria-current={active ? "true" : undefined}
                  className={[styles.listItem, active ? styles.listItemActive : ""].filter(Boolean).join(" ")}>
                  <span className={styles.avatar} style={avatarStyle(item.wa_id)} aria-hidden="true">{conversationTitle(item.profile_name, item.wa_id).replace(/^\+/, "").charAt(0).toUpperCase()}</span>
                  <span className={styles.listBody}>
                    <span className={styles.listTop}>
                      <strong>{conversationTitle(item.profile_name, item.wa_id)}</strong>
                      <time dateTime={item.last_message_at}>{formatListTime(item.last_message_at, timeZone)}</time>
                    </span>
                    <span className={styles.listPreview}>{item.last_message_preview ?? "—"}</span>
                    {(() => {
                      const win = replyWindow(item.last_inbound_at);
                      const red = item.opted_out || !win.open;
                      return <span className={[styles.winTag, red ? styles.winClosed : styles.winOpen].join(" ")}>
                        {item.opted_out ? "Opted out" : win.open ? `Closes in ${win.remainingLabel}` : "Window closed"}
                      </span>;
                    })()}
                  </span>
                  <LinkPending />
                  {item.unread_count > 0 && <span className={styles.unread} aria-label={`${item.unread_count} unread`}>{item.unread_count > 99 ? "99+" : item.unread_count}</span>}
                </Link>
              </li>;
            })}
          </ul>
          {list.total > list.conversations.length && <p className={styles.more}>Showing the {list.conversations.length} most recent conversations.</p>}
        </nav>

        <section className={styles.thread} aria-label="Conversation thread">
          {!selectedId && <p className={styles.placeholder}>Select a conversation to read and reply.</p>}
          {selectedId && !thread && <p className={styles.placeholder}>This conversation could not be loaded. It may not exist, or storage is unavailable.</p>}
          {thread && replyWin && <>
            {thread.conversation.unread_count > 0 && <MarkRead conversationId={thread.conversation.id} seenThrough={thread.conversation.last_message_at} />}
            <header className={styles.threadHeader}>
              <Link href="/dashboard/inbox" className={styles.backToList} aria-label="Back to chats"><ArrowLeft size={24} strokeWidth={2.2} aria-hidden="true" /></Link>
              <span className={[styles.avatar, styles.headerAvatar].join(" ")} style={avatarStyle(thread.conversation.wa_id)} aria-hidden="true">{conversationTitle(thread.conversation.profile_name, thread.conversation.wa_id).replace(/^\+/, "").charAt(0).toUpperCase()}</span>
              <div className={styles.threadTitle}>
                <strong>{conversationTitle(thread.conversation.profile_name, thread.conversation.wa_id)}</strong>
                <span>{formatPhone(thread.conversation.wa_id)}</span>
              </div>
              <span className={[styles.windowPill, replyWin.open && !thread.safety.optedOut ? styles.windowOpen : styles.windowClosed].join(" ")}>
                {thread.safety.optedOut ? "Opted out" : replyWin.open ? `${replyWin.remainingLabel} left to reply` : "Reply window closed"}
              </span>
            </header>
            {thread.truncated && <p className={styles.more}>Showing the latest 200 messages.</p>}
            <MessageList conversationId={thread.conversation.id} className={styles.messages}>
              {thread.messages.map((message, index) => {
                const previous = thread.messages[index - 1];
                const newDay = !previous || !sameDay(previous.event_at, message.event_at, timeZone);
                return <Fragment key={message.id}>
                  {newDay && <li className={styles.daySeparator}><span>{formatDayLabel(message.event_at, timeZone)}</span></li>}
                  <Bubble message={message} timeZone={timeZone} />
                </Fragment>;
              })}
            </MessageList>
            <ReplyForm conversationId={thread.conversation.id} initialToken={randomUUID()} disabledReason={lockReason} />
          </>}
          <div className={styles.skeleton} aria-hidden="true">
            <div className={styles.skHeader}><i className={styles.skAvatar} /><span><i className={styles.skLine} style={{ width: 140 }} /><i className={styles.skLine} style={{ width: 90 }} /></span></div>
            <div className={styles.skBody}>
              {[["in", 55], ["in", 35], ["out", 45], ["in", 60], ["out", 30]].map(([side, w], index) =>
                <i key={index} className={[styles.skBubble, side === "out" ? styles.skOut : ""].join(" ")} style={{ width: `${w}%` }} />)}
            </div>
            <div className={styles.skReply}><i className={styles.skLine} style={{ width: "100%", height: 38 }} /></div>
          </div>
        </section>
      </section>}
    </div>
  </>;
}
