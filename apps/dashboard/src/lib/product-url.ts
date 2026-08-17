// Where a product actually lives, in one place.
//
// The dashboard used to show every product as `{slug}.naelao.app`, in six separate hardcoded
// template strings. No DNS zone for that domain has ever existed on this account, so the address
// a builder was shown — on the wizard, the product list, the product header, and the domain tab —
// could not resolve anywhere. The Product Shell serves every product from one host under a /p/
// path; that is the address to show until a real custom domain is attached.

const DEFAULT_SHELL_ORIGIN = "https://naelao-shell.pages.dev";

/** The shell origin this deployment points at. Configured per environment, since the dashboard
 *  and the shell are separate Pages projects and a self-hosted deployment will use its own. */
export function shellOrigin(): string {
  return process.env["NEXT_PUBLIC_SHELL_URL"]?.replace(/\/+$/, "") || DEFAULT_SHELL_ORIGIN;
}

/** The full sign-in URL for a product, or null when it has no slug yet (in which case there is
 *  genuinely nowhere to send anyone — say so rather than printing a broken link). */
export function productShellUrl(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return `${shellOrigin()}/p/${slug}`;
}

/** The same thing without the scheme, for places that display an address rather than link it. */
export function productShellDisplay(slug: string | null | undefined): string | null {
  const url = productShellUrl(slug);
  return url ? url.replace(/^https?:\/\//, "") : null;
}
