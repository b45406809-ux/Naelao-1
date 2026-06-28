// Builder / dev roadmap — founder-only view of Naelao's space types & templates.
// v0 ships exactly one niche live (Launchpad → Whop Businesses); everything else
// is surfaced as "coming soon". This is a read-only roadmap, not a config system —
// new niches ship as code when demand is proven.
//
// Source of truth: GET /v1/catalog/dev  (workers/agents/src/catalog.ts).
// The lists below mirror that endpoint so the page renders without an API round-trip.

type Status = "live" | "coming_soon";
interface Entry { id: string; name: string; description: string; status: Status }

const SPACE_TYPES: Entry[] = [
  { id: "launchpad", name: "Launchpad", description: "Autonomous agent that builds and runs a business for you — and (later) lets builders build their own.", status: "live" },
  { id: "workers", name: "Workers", description: "A virtual workforce of task-running agents.", status: "coming_soon" },
  { id: "sites", name: "Sites", description: "Agent-managed content sites and CMS.", status: "coming_soon" },
  { id: "enterprise", name: "Enterprise", description: "Org-level sub-spaces, roles, and orchestration.", status: "coming_soon" },
  { id: "studio", name: "Studio", description: "Creative production environment.", status: "coming_soon" },
  { id: "developer", name: "Developer", description: "Warm containers, live preview, build sandboxes.", status: "coming_soon" },
];

const TEMPLATES: Entry[] = [
  { id: "whop-businesses", name: "Whop Businesses", description: "AI-built micro-tool + community, sold on Whop, run by a script-first agent loop.", status: "live" },
  { id: "whop-courses", name: "Whop Courses", description: "Agent-run course + community product.", status: "coming_soon" },
  { id: "whop-saas", name: "Whop SaaS", description: "Agent-run micro-SaaS sold on Whop.", status: "coming_soon" },
];

function StatusBadge({ status }: { status: Status }) {
  return status === "live" ? (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">Live</span>
  ) : (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Coming soon</span>
  );
}

function CatalogCard({ entry }: { entry: Entry }) {
  const dimmed = entry.status === "coming_soon";
  return (
    <div className={`border rounded-xl p-4 ${dimmed ? "border-gray-200 bg-gray-50 opacity-80" : "border-brand-200 bg-white"}`}>
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-semibold text-gray-900">{entry.name}</h3>
        <StatusBadge status={entry.status} />
      </div>
      <p className="text-sm text-gray-500">{entry.description}</p>
    </div>
  );
}

export default function CatalogPage() {
  return (
    <main className="max-w-4xl mx-auto px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Roadmap</h1>
        <p className="mt-1 text-gray-500 text-sm">
          Naelao ships one niche at a time. Launchpad → Whop Businesses is live today; the rest are coming soon and will ship as builders ask for them.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Space types</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {SPACE_TYPES.map((e) => <CatalogCard key={e.id} entry={e} />)}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Launchpad templates</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {TEMPLATES.map((e) => <CatalogCard key={e.id} entry={e} />)}
        </div>
      </section>
    </main>
  );
}
