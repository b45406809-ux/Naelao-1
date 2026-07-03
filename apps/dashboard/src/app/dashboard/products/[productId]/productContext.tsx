"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { getBuilderProduct } from "@/lib/api";
import type { BuilderProductDetail } from "@/lib/api";

interface ProductContextValue {
  product: BuilderProductDetail | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const ProductContext = createContext<ProductContextValue | null>(null);

export function ProductProvider({
  productId,
  children,
}: {
  productId: string;
  children: React.ReactNode;
}) {
  const [product, setProduct] = useState<BuilderProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProduct(await getBuilderProduct(productId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load product");
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return (
    <ProductContext.Provider value={{ product, loading, error, refetch }}>
      {children}
    </ProductContext.Provider>
  );
}

export function useProduct(): ProductContextValue {
  const ctx = useContext(ProductContext);
  if (!ctx) throw new Error("useProduct must be used within a ProductProvider");
  return ctx;
}
