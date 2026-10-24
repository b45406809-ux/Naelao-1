"use client";

import * as React from "react";

/** Backward-compatible redirect for bookmarks to the retired native business-plugin catalogue. */
export default function PluginsRedirectPage() {
  React.useEffect(() => {
    window.location.replace(window.location.pathname.replace(/\/plugins\/?$/, "/extensions"));
  }, []);
  return <div className="page-view"><p style={{ color: "var(--text3)", fontSize: 13 }}>Opening Extensions…</p></div>;
}
