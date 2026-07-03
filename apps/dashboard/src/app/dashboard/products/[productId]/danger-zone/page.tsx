"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { updateBuilderProduct, deleteBuilderProduct } from "@/lib/api";
import { ConfirmByTypingDialog } from "@/components/ConfirmByTypingDialog";
import { useProduct } from "../productContext";

export default function ProductDangerZonePage() {
  const params = useParams<{ productId: string }>();
  const router = useRouter();
  const { product, loading, refetch } = useProduct();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  async function toggleStatus() {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      const nextStatus = product.status === "paused" ? "active" : "paused";
      await updateBuilderProduct(params.productId, { status: nextStatus });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteBuilderProduct(params.productId);
      router.push("/dashboard/products");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  }

  if (loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;

  const isPaused = product.status === "paused";

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>
      )}

      <div className="border border-yellow-200 bg-yellow-50 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-1">
          {isPaused ? "Resume this product" : "Pause this product"}
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          {isPaused
            ? "Restores access for all end users."
            : "Temporarily blocks end-user access. Data is preserved and this is fully reversible."}
        </p>
        <button
          type="button"
          onClick={() => void toggleStatus()}
          disabled={busy}
          className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {busy ? "Working…" : isPaused ? "Resume product" : "Pause product"}
        </button>
      </div>

      <div className="border border-red-200 bg-red-50 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Delete this product</h2>
        <p className="text-sm text-gray-600 mb-4">
          Permanently removes end-user access. This cannot be undone.
        </p>
        <button
          type="button"
          onClick={() => setShowDelete(true)}
          disabled={busy}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Delete product
        </button>
      </div>

      {showDelete && (
        <ConfirmByTypingDialog
          title="Delete product"
          description={`This permanently removes "${product.name}" and blocks all end-user access. This cannot be undone.`}
          confirmText={product.name}
          actionLabel="Delete permanently"
          busy={busy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </div>
  );
}
