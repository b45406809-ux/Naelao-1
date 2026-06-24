import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Naelao Space",
  description: "AI-powered conversational space",
};

export default function SpaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {children}
    </>
  );
}
