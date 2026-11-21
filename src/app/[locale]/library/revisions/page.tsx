import { Suspense } from "react";
import { RevisionCompare } from "@/features/library/components/revisions/RevisionCompare";

export default function RevisionsPage() {
    return <Suspense fallback={null}><RevisionCompare /></Suspense>;
}
