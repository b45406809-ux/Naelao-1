"use client";

import * as React from "react";
import { TopBar } from "@naelao/ui";
import { useProductAuth } from "@/lib/auth-provider";

export default function HomePage() {
  const { session } = useProductAuth();

  return (
    <>
      <TopBar variant="home" />
      <div className="home-view">
        <h1>Welcome{session ? "" : " back"}</h1>
        <p className="sub">Chat, projects, and threads land in the next build phase.</p>
        <div className="input-wrap">
          <div className="input-container">
            <div className="input-top">
              <textarea className="msg-input" placeholder="Chat is coming soon…" disabled rows={1} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
