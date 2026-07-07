"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { ProductProvider, useProduct } from "./productContext";

const TABS = [
  { label: "Overview", segment: "" },
  { label: "Users", segment: "users" },
  { label: "Analytics", segment: "analytics" },
  { label: "Configuration", segment: "configuration" },
  { label: "Domain", segment: "domain" },
  { label: "Pricing", segment: "pricing" },
  { label: "Agents", segment: "agents" },
  { label: "Activity", segment: "activity" },
  { label: "Local Machine", segment: "local-machine" },
  { label: "Feature Flags", segment: "feature-flags" },
  { label: "Billing", segment: "billing" },
  { label: "Danger Zone", segment: "danger-zone" },
] as const;

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  provisioning: "bg-blue-100 text-blue-700",
  draft: "bg-gray-100 text-gray-500",
  paused: "bg-yellow-100 text-yellow-700",
  suspended: "bg-red-100 text-red-700",
  deleted: "bg-gray-100 text-gray-500",
};

function ProductHeader({ productId }: { productId: string }) {
  const { product, loading, error } = useProduct();
  const pathname = usePathname();
  const base = `/dashboard/products/${productId}`;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-2">
        <Link href="/dashboard/products" className="text-sm text-gray-400 hover:text-gray-600">
          ← Products
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">
              {loading ? "Loading…" : product?.name ?? "Product"}
            </h1>
            {product && (
              <span
                className={`text-xs px-2.5 py-0.5 rounded-full font-medium capitalize ${
                  STATUS_COLORS[product.status] ?? "bg-gray-100 text-gray-500"
                }`}
              >
                {product.status}
              </span>
            )}
          </div>
          {product?.product_slug && (
            <p className="text-gray-500 mt-1 text-sm">{product.product_slug}.naelao.app</p>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6">
          {error}
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {TABS.map((tab) => {
          const href = tab.segment ? `${base}/${tab.segment}` : base;
          const isActive = pathname === href;
          return (
            <Link
              key={tab.label}
              href={href}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                isActive
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function ProductDetailLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ productId: string }>();
  const productId = params.productId;

  return (
    <ProductProvider productId={productId}>
      <ProductHeader productId={productId} />
      <div className="max-w-5xl mx-auto">{children}</div>
    </ProductProvider>
  );
}
