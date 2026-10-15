import { WorkerEntrypoint } from "cloudflare:workers";

/** Package hosts reachable from the Tier-6 tool container. Keep this list exact:
 * redirects are returned to the container and must match another intercepted host. */
export const TRUSTED_PACKAGE_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "index.crates.io",
  "static.crates.io",
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
] as const;

export function isTrustedPackageUrl(input: string | URL): boolean {
  try {
    const url = input instanceof URL ? input : new URL(input);
    return url.protocol === "https:" && TRUSTED_PACKAGE_HOSTS.includes(url.hostname as typeof TRUSTED_PACKAGE_HOSTS[number]);
  } catch {
    return false;
  }
}

/** Direct, uncached forwarding for exact package-source hosts. Cloudflare's container
 * interception supplies the network boundary; redirects are left for the container to
 * follow, so a redirect to any unlisted host remains blocked by enableInternet:false. */
export class PackageEgress extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    if (!isTrustedPackageUrl(request.url)) return new Response("package source is not allowed", { status: 403 });
    return fetch(request, { redirect: "manual" });
  }
}
