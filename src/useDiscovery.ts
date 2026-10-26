import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDiscoveryDetails, searchDiscovery, type DiscoveryCategory, type DiscoveryResult, type SearchBounds } from './discoveryData';

export type DiscoveryScope = 'destination' | 'area';
type SearchInput = { query: string; category: DiscoveryCategory; bounds?: SearchBounds };

/** The session outlives the mobile list, detail sheet and map; it is never serialized. */
export function useDiscovery(tripId: string, destination: string) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<DiscoveryCategory>('all');
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<DiscoveryResult | null>(null);
  const [scope, setScope] = useState<DiscoveryScope>('destination');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [resultsKey, setResultsKey] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const searchVersion = useRef(0);
  const detailVersion = useRef(0);
  const bounds = useRef<SearchBounds | undefined>(undefined);
  const lastSearch = useRef<SearchInput | null>(null);

  useEffect(() => {
    searchVersion.current += 1; detailVersion.current += 1;
    setQuery(''); setCategory('all'); setResults([]); setSelectedResult(null);
    setScope('destination'); setLoading(false); setError(''); setSearched(false);
    setDetailsLoading(false); setDetailsError(''); setResultsKey(''); setScrollTop(0);
    bounds.current = undefined; lastSearch.current = null;
    return () => { searchVersion.current += 1; detailVersion.current += 1; };
  }, [tripId, destination]);

  const runSearch = useCallback(async (input: SearchInput) => {
    const version = ++searchVersion.current;
    detailVersion.current += 1;
    const submitted = { ...input, bounds: input.bounds ? { ...input.bounds } : undefined };
    lastSearch.current = submitted;
    bounds.current = submitted.bounds;
    setScope(submitted.bounds ? 'area' : 'destination');
    setLoading(true); setError(''); setSearched(true); setSelectedResult(null);
    setDetailsLoading(false); setDetailsError('');
    try {
      const found = await searchDiscovery(submitted.query, destination, submitted.category, submitted.bounds);
      if (version !== searchVersion.current) return;
      setResults(found); setScrollTop(0);
      setResultsKey(`${tripId}:${version}`);
    } catch {
      if (version === searchVersion.current) setError('Places could not load. Your itinerary is safe. Check your connection and try again.');
    } finally {
      if (version === searchVersion.current) setLoading(false);
    }
  }, [destination, tripId]);

  const select = useCallback(async (result: DiscoveryResult) => {
    const version = ++detailVersion.current;
    setSelectedResult(result); setDetailsError('');
    if (!result.place.googlePlaceId) { setDetailsLoading(false); return; }
    setDetailsLoading(true);
    try {
      const detail = await fetchDiscoveryDetails(result.place.googlePlaceId);
      if (version !== detailVersion.current) return;
      setSelectedResult(detail);
      setResults(current => current.map(item => item.place.googlePlaceId === detail.place.googlePlaceId ? detail : item));
    } catch {
      if (version === detailVersion.current) setDetailsError('More details could not load. You can still save or add this place.');
    } finally {
      if (version === detailVersion.current) setDetailsLoading(false);
    }
  }, []);

  const back = useCallback(() => {
    detailVersion.current += 1;
    setSelectedResult(null); setDetailsLoading(false); setDetailsError('');
  }, []);

  return {
    query, setQuery, category, results, selectedResult, scope, loading, error, searched,
    detailsLoading, detailsError, resultsKey, scrollTop, setScrollTop, select, back,
    search: () => runSearch({ query, category, bounds: bounds.current }),
    changeCategory: (next: DiscoveryCategory) => { setCategory(next); return runSearch({ query, category: next, bounds: bounds.current }); },
    searchArea: (area: SearchBounds) => runSearch({ query, category, bounds: area }),
    backToDestination: () => runSearch({ query, category }),
    retry: () => lastSearch.current ? runSearch(lastSearch.current) : Promise.resolve(),
    retryDetails: () => selectedResult ? select(selectedResult) : Promise.resolve(),
  };
}
