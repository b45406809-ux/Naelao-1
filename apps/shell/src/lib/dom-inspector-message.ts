export interface DomInspectionMessage {
  type: "AVOS_DOM_CLICK";
  selector: string;
  tag: string;
  text: string;
}

/** The iframe has an opaque origin, so authenticate its WindowProxy, not event.origin. */
export function isTrustedDomInspectionMessage(
  source: unknown,
  data: unknown,
  trustedSources: readonly unknown[]
): data is DomInspectionMessage {
  if (source === null || source === undefined || !trustedSources.includes(source)) return false;
  if (!data || typeof data !== "object") return false;
  const message = data as Record<string, unknown>;
  return message.type === "AVOS_DOM_CLICK"
    && typeof message.selector === "string"
    && message.selector.length > 0
    && message.selector.length <= 512
    && typeof message.tag === "string"
    && /^[a-z][a-z0-9-]{0,31}$/.test(message.tag)
    && typeof message.text === "string"
    && message.text.length <= 80;
}
