import { afterEach, describe, expect, it, vi } from "vitest";
import { productShellDisplay, productShellUrl, shellOrigin } from "../../apps/dashboard/src/lib/product-url";

afterEach(() => vi.unstubAllEnvs());

describe("dashboard product shell links", () => {
  it("builds links only for slugs accepted by the space creation route", () => {
    expect(productShellUrl("acme-tools")).toBe("https://naelao-shell.pages.dev/p/acme-tools");
    expect(productShellDisplay("acme-tools")).toBe("naelao-shell.pages.dev/p/acme-tools");
    expect(productShellUrl("../other")).toBeNull();
    expect(productShellUrl("a")).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_SHELL_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(shellOrigin()).toBe("http://localhost:3100");
  });

  it("normalizes a configured origin and fails closed on non-origin or unsafe values", () => {
    vi.stubEnv("NEXT_PUBLIC_SHELL_URL", "https://shell.example.test///");
    expect(shellOrigin()).toBe("https://shell.example.test");
    expect(productShellUrl("valid-product")).toBe("https://shell.example.test/p/valid-product");

    vi.stubEnv("NEXT_PUBLIC_SHELL_URL", "javascript:alert(1)");
    expect(shellOrigin()).toBe("");
    expect(productShellUrl("valid-product")).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_SHELL_URL", "http://shell.example.test");
    expect(productShellUrl("valid-product")).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_SHELL_URL", "https://user:password@shell.example.test");
    expect(productShellUrl("valid-product")).toBeNull();
  });
});
