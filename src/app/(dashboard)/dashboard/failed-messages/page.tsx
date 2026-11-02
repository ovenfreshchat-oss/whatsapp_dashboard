import { redirect } from "next/navigation";

/** Failed messages now live inside each campaign (Campaigns > campaign > Failed messages). */
export default function FailedMessagesMovedPage() {
  redirect("/dashboard/campaigns");
}
