import { CharactersLibrary } from "@/features/library/components/CharactersLibrary";

export default function CharactersPage() {
    // The route is dynamic (workspace guard), so useSearchParams inside the library
    // needs no Suspense boundary; a streaming boundary could insert a late duplicate.
    return <CharactersLibrary />;
}
