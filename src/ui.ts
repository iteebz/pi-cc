// Pi's UI handle, held in one place.
//
// Every module that needs to tell the user something reaches it through here
// rather than through an import of index.ts — that import would be a cycle, and
// a lazy one inside a function body is the same cycle with the type checking
// switched off.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

let ui: ExtensionUIContext | null = null;

export function setUI(next: ExtensionUIContext | null): void {
  ui = next;
}

export function notify(message: string, level: "info" | "warning" | "error"): void {
  ui?.notify(message, level);
}
