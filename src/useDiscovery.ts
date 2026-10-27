import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDiscoveryDetails, searchDiscoveryPage, type DiscoveryCategory, type DiscoveryResult, type SearchBounds } from './discoveryData';

export type DiscoveryScope = 'destination' | 'area';
type SearchInput = { query: string; category: DiscoveryCategory; bounds?: SearchBounds };
type SearchSession = {
  version: number;
  input: SearchInput;
  nextPageToken?: string;
  consumedTokens: Set<string>;
  pageCount: number;
  loadingMore: boolean;
};
// A defensive ceiling only: Google's current result limit is lower than this.
const MAX_SEARCH_PAGES = 20;
const isOffline = () => typeof navigator !== 'undefined' && !navigator.onLine;

/** Keep enriched cards already on screen when a later page overlaps. */
function appendUnique(current: DiscoveryResult[], incoming: DiscoveryResult[]): DiscoveryResult[] {
  const ids = new Set(current.map(result => result.place.id));
  const googleIds = new Set(current.map(result => result.place.googlePlaceId).filter(Boolean));
  const merged = [...current];
  for (const result of incoming) {
    if (ids.has(result.place.id) || (result.place.googlePlaceId && googleIds.has(result.place.googlePlaceId))) continue;
    ids.add(result.place.id);
    if (result.place.googlePlaceId) googleIds.add(result.place.googlePlaceId);
    merged.push(result);
  }
  return merged;
}

/** The session outlives the mobile list, detail sheet and map; it is never serialized. */
export function useDiscovery(tripId: string, destination: string) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<DiscoveryCategory>('all');
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<DiscoveryResult | null>(null);
  const [scope, setScope] = useState<DiscoveryScope>('destination');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
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
  const pagination = useRef<SearchSession | null>(null);
  const identity = JSON.stringify([tripId, destination]);
  const currentIdentity = useRef(identity);
  const mounted = useRef(true);
  // Invalidate requests during render, before a new trip's effects can run.
  if (currentIdentity.current !== identity) {
    currentIdentity.current = identity;
    searchVersion.current += 1; detailVersion.current += 1;
    pagination.current = null;
  }

  useEffect(() => {
    mounted.current = true;
    searchVersion.current += 1; detailVersion.current += 1;
    setQuery(''); setCategory('all'); setResults([]); setSelectedResult(null);
    setScope('destination'); setLoading(false); setError(''); setSearched(false);
    setDetailsLoading(false); setDetailsError(''); setResultsKey(''); setScrollTop(0);
    setHasMore(false); setLoadingMore(false); setMoreError('');
    bounds.current = undefined; lastSearch.current = null; pagination.current = null;
    return () => { mounted.current = false; searchVersion.current += 1; detailVersion.current += 1; pagination.current = null; };
  }, [tripId, destination]);

  const runSearch = useCallback(async (input: SearchInput) => {
    if (!mounted.current || currentIdentity.current !== identity) return;
    const version = ++searchVersion.current;
    detailVersion.current += 1;
    const submitted = { ...input, bounds: input.bounds ? { ...input.bounds } : undefined };
    pagination.current = null;
    setHasMore(false); setLoadingMore(false); setMoreError('');
    lastSearch.current = submitted;
    bounds.current = submitted.bounds;
    setScope(submitted.bounds ? 'area' : 'destination');
    setLoading(true); setError(''); setSearched(true); setSelectedResult(null);
    setDetailsLoading(false); setDetailsError('');
    if (isOffline()) { setLoading(false);setError('Live search needs a connection. Choose from your saved Ideas.');return; }
    try {
      const page = await searchDiscoveryPage(submitted.query, destination, submitted.category, submitted.bounds);
      if (!mounted.current || version !== searchVersion.current || currentIdentity.current !== identity) return;
      pagination.current = { version, input: submitted, nextPageToken: page.nextPageToken, consumedTokens: new Set(), pageCount: 1, loadingMore: false };
      setHasMore(Boolean(page.nextPageToken));
      setResults(appendUnique([], page.results)); setScrollTop(0);
      setResultsKey(`${tripId}:${version}`);
    } catch {
      if (mounted.current && version === searchVersion.current && currentIdentity.current === identity) setError('Places could not load. Your itinerary is safe. Check your connection and try again.');
    } finally {
      if (mounted.current && version === searchVersion.current && currentIdentity.current === identity) setLoading(false);
    }
  }, [destination, tripId, identity]);

  const loadMore = useCallback(async () => {
    if (!mounted.current || currentIdentity.current !== identity) return;
    const session = pagination.current;
    if (!session?.nextPageToken || session.loadingMore || session.version !== searchVersion.current) return;
    if (isOffline()) { setMoreError('Connect to load more places. Your current results are still here.'); return; }
    const token = session.nextPageToken;
    // This ref changes synchronously so double taps cannot send duplicate requests.
    session.loadingMore = true;
    setLoadingMore(true); setMoreError('');
    const isCurrent = () => mounted.current && currentIdentity.current === identity && pagination.current === session && session.version === searchVersion.current;
    try {
      const { input } = session;
      const page = await searchDiscoveryPage(input.query, destination, input.category, input.bounds, token);
      if (!isCurrent()) return;
      session.consumedTokens.add(token);
      session.pageCount += 1;
      session.nextPageToken = page.nextPageToken && !session.consumedTokens.has(page.nextPageToken) && session.pageCount < MAX_SEARCH_PAGES ? page.nextPageToken : undefined;
      setResults(current => appendUnique(current, page.results));
      setHasMore(Boolean(session.nextPageToken));
    } catch {
      if (isCurrent()) setMoreError('More places could not load. Check your connection and try again.');
    } finally {
      if (isCurrent()) { session.loadingMore = false; setLoadingMore(false); }
    }
  }, [destination, identity]);

  const select = useCallback(async (result: DiscoveryResult) => {
    if (!mounted.current || currentIdentity.current !== identity) return;
    const version = ++detailVersion.current;
    setSelectedResult(result); setDetailsError('');
    if (!result.place.googlePlaceId || isOffline()) { setDetailsLoading(false); return; }
    setDetailsLoading(true);
    try {
      const detail = await fetchDiscoveryDetails(result.place.googlePlaceId);
      if (!mounted.current || version !== detailVersion.current || currentIdentity.current !== identity) return;
      setSelectedResult(detail);
      setResults(current => current.map(item => item.place.googlePlaceId === detail.place.googlePlaceId ? detail : item));
    } catch {
      if (mounted.current && version === detailVersion.current && currentIdentity.current === identity) setDetailsError('More details could not load. You can still save or add this place.');
    } finally {
      if (mounted.current && version === detailVersion.current && currentIdentity.current === identity) setDetailsLoading(false);
    }
  }, [identity]);

  const back = useCallback(() => {
    if (!mounted.current || currentIdentity.current !== identity) return;
    detailVersion.current += 1;
    setSelectedResult(null); setDetailsLoading(false); setDetailsError('');
  }, [identity]);

  return {
    query, setQuery, category, results, selectedResult, scope, loading, error, searched,
    hasMore, loadingMore, moreError, loadMore,
    detailsLoading, detailsError, resultsKey, scrollTop, setScrollTop, select, back,
    search: () => runSearch({ query, category, bounds: bounds.current }),
    indoorIdeas: () => {if (!mounted.current || currentIdentity.current !== identity) return Promise.resolve();setQuery('');setCategory('indoor');return runSearch({query:'',category:'indoor',bounds:bounds.current});},
    changeCategory: (next: DiscoveryCategory) => { if (!mounted.current || currentIdentity.current !== identity) return Promise.resolve();setCategory(next); return runSearch({ query, category: next, bounds: bounds.current }); },
    searchArea: (area: SearchBounds) => runSearch({ query, category, bounds: area }),
    backToDestination: () => runSearch({ query, category }),
    retry: () => lastSearch.current ? runSearch(lastSearch.current) : Promise.resolve(),
    retryDetails: () => selectedResult ? select(selectedResult) : Promise.resolve(),
  };
}
