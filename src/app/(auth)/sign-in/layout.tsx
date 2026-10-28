import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in | Solalyn",
  description: "Sign in to Solalyn staff workspace.",
};

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return children;
}
