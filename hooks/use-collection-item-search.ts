import { useEffect, useMemo, useState } from 'react';
import { useDebounce } from '@/hooks/use-debounce';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import type { CollectionField, CollectionItemWithValues } from '@/types';

const SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UseCollectionItemSearchResult {
  /** Current (uncontrolled) search input value */
  search: string;
  setSearch: (value: string) => void;
  /** True while a debounced server search is in flight */
  isSearching: boolean;
  /** Items from the store (preloaded + any merged search results) */
  items: CollectionItemWithValues[];
  /** Collection fields from the store */
  fields: CollectionField[];
  /** Resolve a human-readable label for an item using the `name` field, with fallbacks */
  getItemLabel: (item: CollectionItemWithValues) => string;
  /** Clear the search input */
  resetSearch: () => void;
}

/**
 * Provide a searchable collection-item list backed by `useCollectionsStore`.
 * The preloaded items (first page) are returned immediately; typing triggers
 * a debounced server search that merges results into the store so links can
 * resolve items beyond the initial preload window.
 *
 * When `selectedId` is a concrete item id that isn't in the preloaded set,
 * it is fetched and merged so the picker's trigger can display its label.
 */
export function useCollectionItemSearch(
  collectionId: string | null | undefined,
  selectedId?: string | null
): UseCollectionItemSearchResult {
  const itemsByCollection = useCollectionsStore((s) => s.items);
  const fieldsByCollection = useCollectionsStore((s) => s.fields);
  const searchAndMergeItems = useCollectionsStore((s) => s.searchAndMergeItems);
  const ensureItemLoaded = useCollectionsStore((s) => s.ensureItemLoaded);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
  const [isSearching, setIsSearching] = useState(false);

  const items = useMemo(
    () => (collectionId ? itemsByCollection[collectionId] || [] : []),
    [collectionId, itemsByCollection]
  );
  const fields = useMemo(
    () => (collectionId ? fieldsByCollection[collectionId] || [] : []),
    [collectionId, fieldsByCollection]
  );

  const trimmedSearch = debouncedSearch.trim();

  useEffect(() => {
    if (!collectionId || !trimmedSearch) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    searchAndMergeItems(collectionId, trimmedSearch, SEARCH_LIMIT)
      .finally(() => {
        if (!cancelled) setIsSearching(false);
      });

    return () => { cancelled = true; };
  }, [collectionId, trimmedSearch, searchAndMergeItems]);

  // Hydrate the selected item when it isn't part of the preloaded set so the
  // trigger can render its label without the user opening the dropdown first.
  // Skips dynamic-resolution keywords / reference-prefixed values, which are
  // not concrete item ids.
  const isConcreteItemId = !!selectedId && UUID_RE.test(selectedId);
  const hasSelectedItemInStore = isConcreteItemId
    && items.some((item) => item.id === selectedId);
  useEffect(() => {
    if (!collectionId || !isConcreteItemId || hasSelectedItemInStore) return;
    ensureItemLoaded(collectionId, selectedId as string);
  }, [collectionId, selectedId, isConcreteItemId, hasSelectedItemInStore, ensureItemLoaded]);

  const getItemLabel = useMemo(() => {
    const nameField = fields.find((f) => f.key === 'name');
    return (item: CollectionItemWithValues): string => {
      if (nameField) {
        const nameValue = item.values?.[nameField.id];
        if (nameValue !== null && nameValue !== undefined && String(nameValue).trim() !== '') {
          return String(nameValue);
        }
      }
      const firstValue = Object.values(item.values || {})[0];
      return (firstValue && String(firstValue)) || `Item ${item.id.slice(0, 8)}`;
    };
  }, [fields]);

  return {
    search,
    setSearch,
    isSearching,
    items,
    fields,
    getItemLabel,
    resetSearch: () => setSearch(''),
  };
}
