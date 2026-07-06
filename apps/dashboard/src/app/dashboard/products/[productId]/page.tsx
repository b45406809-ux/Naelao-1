"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getBuilderProductAnalytics } from "@/lib/api";
import type { BuilderProductAnalytics } from "@/lib/api";
import { useProduct } from "./productContext";

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

export default function ProductOverviewPage() {
  const { product, loading } = useProduct();
  const params = useParams<{ productId: string }>();
  const [analytics, setAnalytics] = useState<BuilderProductAnalytics | null>(null);

  useEffect(() => {
    getBuilderProductAnalytics(params.productId).then(setAnalytics).catch(() => setAnalytics(null));
  }, [params.productId]);

  if (loading) return <div className="text-center py-12 text-gray-400">Loading…</div>;
  if (!product) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard label="Daily active users" value={String(analytics?.dau ?? "—")} />
        <StatCard label="Monthly active users" value={String(analytics?.mau ?? "—")} />
        <StatCard label="Total users" value={String(analytics?.total_users ?? "—")} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Details</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">SpaceType</dt>
            <dd className="text-gray-900 font-medium mt-0.5">{product.spacetype_id}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Created</dt>
            <dd className="text-gray-900 font-medium mt-0.5">
              {new Date(product.created_at).toLocaleDateString()}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Sign-in provider</dt>
            <dd className="text-gray-900 font-medium mt-0.5">
              {product.product_config.authProvider?.provider ?? "naelao-native"}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Pricing model</dt>
            <dd className="text-gray-900 font-medium mt-0.5 capitalize">
              {product.product_config.pricingConfig?.model ?? "free"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex gap-3 text-sm">
        <Link href={`/dashboard/products/${params.productId}/configuration`} className="text-brand-600 hover:underline">
          Edit configuration →
        </Link>
        <Link href={`/dashboard/products/${params.productId}/analytics`} className="text-brand-600 hover:underline">
          Full analytics →
        </Link>
      </div>

      {/* WS-5.3: a product IS a space (same row, same id — builder-routes.ts's GET
         /builder/products/:id reads straight from the `spaces` table) — these per-space admin
         tools (KB, commerce, connectors, credentials, eval, onboarding, sessions, webhooks) are
         real and still only live under the legacy /dashboard/spaces/:id/* routes; folded in here
         instead of duplicated, so a builder never needs the separate spaces list to reach them. */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Advanced Space Tools</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
          {[
            { label: "Knowledge Base", segment: "kb" },
            { label: "Commerce", segment: "commerce" },
            { label: "Connectors", segment: "connectors" },
            { label: "Credentials", segment: "credentials" },
            { label: "Evaluations", segment: "eval" },
            { label: "Onboarding", segment: "onboarding" },
            { label: "Sessions", segment: "sessions" },
            { label: "Webhooks", segment: "webhooks" },
          ].map((tool) => (
            <Link
              key={tool.segment}
              href={`/dashboard/spaces/${params.productId}/${tool.segment}`}
              className="text-brand-600 hover:underline"
            >
              {tool.label} →
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
