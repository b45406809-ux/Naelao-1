import type * as React from "react";

/** Apply native button keyboard activation to an element that uses role="button". */
export function activateOnKeyboard(
  event: Pick<React.KeyboardEvent, "key" | "preventDefault">,
  activate: () => void,
): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}
