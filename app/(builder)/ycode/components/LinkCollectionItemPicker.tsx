'use client';

import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCollectionItemSearch } from '@/hooks/use-collection-item-search';
import LinkItemOptions, { resolveCollectionItemSelectLabel } from './LinkItemOptions';
import type { ReferenceItemOption } from '@/lib/collection-field-utils';

interface LinkCollectionItemPickerProps {
  /** Collection id whose items power the picker; null disables it. */
  collectionId: string | null;
  /** Currently selected value (item id, keyword, or reference value). */
  value: string | null;
  onChange: (value: string) => void;
  /** Dynamic-resolution / reference options. All default to off/empty so the
   *  picker can be used in simpler contexts (e.g. collection field editing). */
  canUseCurrentPageItem?: boolean;
  canUseCurrentCollectionItem?: boolean;
  canUseNextPreviousItem?: boolean;
  referenceItemOptions?: ReferenceItemOption[];
  /** Optional slug field id used as a label fallback after the `name` field */
  slugFieldId?: string | null;
  disabled?: boolean;
}

/**
 * Searchable CMS-item picker used by link settings. Wraps `Select` with the
 * shared `useCollectionItemSearch` hook (preload + debounced server search +
 * lazy hydration of the selected item) and the keyword/reference options
 * defined by `LinkItemOptions`.
 */
export default function LinkCollectionItemPicker({
  collectionId,
  value,
  onChange,
  canUseCurrentPageItem = false,
  canUseCurrentCollectionItem = false,
  canUseNextPreviousItem = false,
  referenceItemOptions = [],
  slugFieldId,
  disabled = false,
}: LinkCollectionItemPickerProps) {
  const {
    search,
    setSearch,
    isSearching,
    items,
    fields,
    resetSearch,
  } = useCollectionItemSearch(collectionId, value);

  // Resolve the trigger label ourselves so it stays visible even when the
  // selected item is filtered out of the dropdown by the active search. We
  // can't pass this through `SelectValue` children — Radix uses that node as
  // a portal target and React warns when we set text content on it.
  const resolvedLabel = resolveCollectionItemSelectLabel(value, items, fields, referenceItemOptions, slugFieldId);

  return (
    <Select
      value={value || ''}
      onValueChange={(next) => {
        onChange(next);
        resetSearch();
      }}
      onOpenChange={(open) => {
        if (!open) resetSearch();
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full">
        {resolvedLabel ? <span className="truncate">{resolvedLabel}</span> : <SelectValue placeholder="Select..." />}
      </SelectTrigger>
      <SelectContent
        searchable
        searchValue={search}
        onSearchChange={setSearch}
        searchLoading={isSearching}
        searchPlaceholder="Search items..."
        className="w-72"
      >
        <LinkItemOptions
          canUseCurrentPageItem={canUseCurrentPageItem}
          canUseCurrentCollectionItem={canUseCurrentCollectionItem}
          canUseNextPreviousItem={canUseNextPreviousItem}
          referenceItemOptions={referenceItemOptions}
          collectionItems={items}
          collectionFields={fields}
          searchValue={search}
          isSearching={isSearching}
          slugFieldId={slugFieldId}
        />
      </SelectContent>
    </Select>
  );
}
