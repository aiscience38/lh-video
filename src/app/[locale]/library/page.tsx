import { Suspense } from "react";
import { LibraryOverview } from "@/features/library/components/LibraryOverview";

export default function LibraryPage() {
    return <Suspense fallback={null}><LibraryOverview /></Suspense>;
}
