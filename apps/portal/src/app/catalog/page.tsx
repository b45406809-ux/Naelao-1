const PRODUCT_SHELL_URL = process.env.NEXT_PUBLIC_PRODUCT_SHELL_URL ?? "https://app.naelao.com";

/** The former Whop-business niche catalog and its BusinessDO onboarding were retired. Keep this
 * old URL honest: it must not fall back to stale cards or send users into the retired launch page. */
export default function ProductCatalogPage() {
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-12">
      <section className="max-w-2xl mx-auto rounded-xl border border-gray-200 bg-white p-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">This business catalog has moved</h1>
        <p className="mt-3 text-sm leading-6 text-gray-600">
          The former Whop business catalog and its launch flow are retired. Its old sample listings
          are not current Naelao templates and cannot be installed from this page.
        </p>
        <a href={PRODUCT_SHELL_URL} className="mt-6 inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">
          Open your Naelao workspace
        </a>
      </section>
    </main>
  );
}
