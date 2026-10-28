import ui from "@/components/ui/ui.module.css";
import styles from "./inbox.module.css";

/** Inbox-shaped placeholder: the same two panes, so nothing jumps when the real data arrives. */
export default function InboxLoading() {
  return (
    <div className={styles.content} data-inbox aria-busy="true" aria-label="Loading inbox">
      <section className={styles.layout}>
        <div className={styles.list}>
          <div className={styles.listHeading}><strong>Chats</strong></div>
          <div className={styles.searchWrap}><span className={`${ui.skeleton}`} style={{ height: 38 }} /></div>
          <ul>
            {[0, 1, 2, 3, 4, 5, 6].map((index) => <li key={index} className={styles.skRow}>
              <i className={`${ui.skeleton} ${styles.skAvatar}`} />
              <span><i className={`${ui.skeleton} ${styles.skLine}`} style={{ width: `${60 - index * 4}%` }} /><i className={`${ui.skeleton} ${styles.skLine}`} style={{ width: "85%" }} /></span>
            </li>)}
          </ul>
        </div>
        <div className={`${styles.thread} ${styles.skeletonThread}`}>
          <div className={styles.skHeader}><i className={`${ui.skeleton} ${styles.skAvatar}`} /><span><i className={`${ui.skeleton} ${styles.skLine}`} style={{ width: 140 }} /><i className={`${ui.skeleton} ${styles.skLine}`} style={{ width: 90 }} /></span></div>
          <div className={styles.skBody}>
            {[["in", 55], ["in", 35], ["out", 45], ["in", 60], ["out", 30]].map(([side, w], index) =>
              <i key={index} className={`${ui.skeleton} ${styles.skBubble} ${side === "out" ? styles.skOut : ""}`} style={{ width: `${w}%` }} />)}
          </div>
        </div>
      </section>
    </div>
  );
}
