import { Suspense } from "react";
import { ProductionsBoard } from "@/features/productions/components/ProductionsBoard";

export default function ProductionsPage() {
    return <Suspense fallback={null}><ProductionsBoard /></Suspense>;
}
