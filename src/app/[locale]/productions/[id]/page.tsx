import { ProductionDetail } from "@/features/productions/components/ProductionDetail";

export default async function ProductionDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <ProductionDetail id={id} />;
}
