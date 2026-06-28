// Product (end-user) view — the Whop-business niches a user can launch.
// v0: one niche is live; the rest are surfaced as "coming soon" so users see the
// roadmap without us building niches no one has asked for yet.
//
// Source of truth: GET /v1/catalog/product  (workers/agents/src/catalog.ts).
// The list below mirrors that endpoint so the page renders without an API round-trip.

type Status = "live" | "coming_soon";
interface Niche { id: string; name: string; description: string; status: Status }

const PRODUCT_NICHES: Niche[] = [
  { id: "ai-microtool-community", name: "AI Micro-Tool + Community", description: "A genuinely functional AI micro-tool bundled with a support community, sold on Whop.", status: "live" },
  { id: "content-engine", name: "Content Engine", description: "Repurpose one piece of content into many, with a community.", status: "coming_soon" },
  { id: "outreach-agency", name: "Outreach Autopilot", description: "Automated outreach tooling + community.", status: "coming_soon" },
  { id: "niche-research", name: "Niche Research", description: "Find underserved niches and offers, with a community.", status: "coming_soon" },
];

export default function ProductCatalogPage() {
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-12">
      <div className="max-w-2xl mx-auto">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Launch a Whop business</h1>
          <p className="mt-2 text-gray-500 text-sm">
            Start with the live niche below. More Whop business types are coming soon.
          </p>
        </header>

        <div className="space-y-3">
          {PRODUCT_NICHES.map((n) => {
            const live = n.status === "live";
            return (
              <div
                key={n.id}
                className={`flex items-center justify-between border rounded-xl p-5 ${live ? "border-indigo-200 bg-white" : "border-gray-200 bg-gray-50 opacity-80"}`}
              >
                <div className="pr-4">
                  <h2 className="font-semibold text-gray-900">{n.name}</h2>
                  <p className="text-sm text-gray-500 mt-0.5">{n.description}</p>
                </div>
                {live ? (
                  <button className="shrink-0 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">
                    Get started
                  </button>
                ) : (
                  <span className="shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-500">
                    Coming soon
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
