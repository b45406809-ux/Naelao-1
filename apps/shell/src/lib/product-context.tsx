"use client";

import * as React from "react";
import type { ProductBySlug } from "./api";

export interface ProductContextValue extends ProductBySlug {
  slug: string;
}

const ProductContext = React.createContext<ProductContextValue | null>(null);

export function ProductProvider({
  slug,
  product,
  children,
}: {
  slug: string;
  product: ProductBySlug;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ slug, ...product }), [slug, product]);
  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}

export function useProduct(): ProductContextValue {
  const ctx = React.useContext(ProductContext);
  if (!ctx) throw new Error("useProduct must be used within a ProductProvider");
  return ctx;
}
