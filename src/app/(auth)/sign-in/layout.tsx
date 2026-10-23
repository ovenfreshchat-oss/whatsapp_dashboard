import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in | The Oven Fresh",
  description: "Sign in to The Oven Fresh staff workspace.",
};

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return children;
}
