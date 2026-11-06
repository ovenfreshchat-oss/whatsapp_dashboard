import type { ReactNode } from "react";
import { ExternalLink, Phone, Reply } from "lucide-react";
import styles from "./whatsapp-preview.module.css";

export type PreviewButton = { type?: string | null; text?: string | null; url?: string | null; phoneNumber?: string | null };

/** WhatsApp text styling: *bold*, _italic_, ~strikethrough~ and ```monospace```. Rendered as React nodes, never as HTML. */
const STYLE = /(?<![\w*_~])([*_~])(?=\S)(.+?)(?<=\S)\1(?![\w*_~])/g;

export function renderWhatsAppText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const blocks = text.split(/(```[\s\S]+?```)/g);
  blocks.forEach((block, blockIndex) => {
    if (/^```[\s\S]+```$/.test(block)) {
      nodes.push(<code key={`c${blockIndex}`}>{block.slice(3, -3)}</code>);
      return;
    }
    let last = 0;
    for (const match of block.matchAll(STYLE)) {
      const start = match.index ?? 0;
      if (start > last) nodes.push(block.slice(last, start));
      const inner = renderWhatsAppText(match[2]);
      const key = `s${blockIndex}-${start}`;
      nodes.push(match[1] === "*" ? <strong key={key}>{inner}</strong>
        : match[1] === "_" ? <em key={key}>{inner}</em> : <s key={key}>{inner}</s>);
      last = start + match[0].length;
    }
    if (last < block.length) nodes.push(block.slice(last));
  });
  return nodes;
}

function ButtonIcon({ type }: { type?: string | null }) {
  if (type === "PHONE_NUMBER") return <Phone size={15} aria-hidden="true" />;
  if (type === "URL") return <ExternalLink size={15} aria-hidden="true" />;
  return <Reply size={15} aria-hidden="true" />;
}

/** How a template looks in WhatsApp: image on top, message, footer, then one row per button. */
export function WhatsAppPreview({ headerImageUrl, headerImageMissing, headerVideoUrl, headerVideoMissing, headerText, body, footer, buttons = [] }: {
  headerImageUrl?: string | null;
  /** The template has an image header but no picture is chosen yet. */
  headerImageMissing?: boolean;
  /** A video header: the link to play, or a note that none is chosen yet. */
  headerVideoUrl?: string | null;
  headerVideoMissing?: boolean;
  headerText?: string | null;
  body: string;
  footer?: string | null;
  buttons?: PreviewButton[];
}) {
  const shown = buttons.filter((button) => button.text || button.type);
  return <div className={styles.phone} role="group" aria-label="Message preview">
    <div className={styles.bubble}>
      {headerImageUrl && /* eslint-disable-next-line @next/next/no-img-element */
        <img className={styles.image} src={headerImageUrl} alt="Message header" />}
      {!headerImageUrl && headerImageMissing && <div className={styles.imageMissing}>Image header</div>}
      {headerVideoUrl && <video className={styles.image} src={headerVideoUrl} controls preload="metadata" playsInline aria-label="Message header video" />}
      {!headerVideoUrl && headerVideoMissing && <div className={styles.imageMissing}>▶ Video header</div>}
      {headerText && <p className={styles.headerText}>{renderWhatsAppText(headerText)}</p>}
      <p className={styles.body}>{renderWhatsAppText(body)}</p>
      {footer && <p className={styles.footer}>{footer}</p>}
    </div>
    {shown.map((button, index) => <div className={styles.button} key={index}>
      <ButtonIcon type={button.type} />{button.text || (button.type === "PHONE_NUMBER" ? "Call phone number" : "Button")}
    </div>)}
  </div>;
}
