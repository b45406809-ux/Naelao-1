import { notFound } from "next/navigation";
import { ApiError, getProductBySlug } from "@/lib/api";
import { ProductProvider } from "@/lib/product-context";
import { ProductAuthProvider } from "@/lib/auth-provider";

export default async function ProductLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug: string };
}) {
  const product = await getProductBySlug(params.slug).catch(error => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (!product) notFound();

  return (
    <ProductProvider slug={params.slug} product={product}>
      <ProductAuthProvider spaceId={product.space_id}>{children}</ProductAuthProvider>
    </ProductProvider>
  );
}
