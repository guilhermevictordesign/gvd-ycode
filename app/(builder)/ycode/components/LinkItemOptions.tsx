'use client';

import { SelectItem, SelectSeparator } from '@/components/ui/select';
import type { CollectionItemWithValues, CollectionField } from '@/types';
import type { ReferenceItemOption } from '@/lib/collection-field-utils';
import { COLLECTION_ITEM_KEYWORDS } from '@/lib/link-utils';

interface CollectionItemSelectOptionsProps {
  canUseCurrentPageItem: boolean;
  canUseCurrentCollectionItem: boolean;
  /**
   * Show "Next item" / "Previous item" entries. Only meaningful when the link
   * targets the same dynamic page that's being edited (so the navigation makes
   * sense relative to the current item). Caller is responsible for that gating.
   */
  canUseNextPreviousItem?: boolean;
  referenceItemOptions: ReferenceItemOption[];
  collectionItems: CollectionItemWithValues[];
  /** Fields for the linked page's collection, used to derive display names */
  collectionFields: CollectionField[];
  /** Optional search string to filter visible options by their display label */
  searchValue?: string;
  /** When true, a debounced server search is in flight; show a loading state instead of "No items" */
  isSearching?: boolean;
  /** Optional slug field id used as a label fallback after the `name` field */
  slugFieldId?: string | null;
}

/**
 * Resolve a CMS item's display label using its `name` field, then an optional
 * `slug` field, then the first stored value, then the raw id. Exported so the
 * link selectors can render the trigger label even when the selected item is
 * filtered out of the visible list.
 */
export function getCollectionItemDisplayName(
  item: CollectionItemWithValues,
  collectionFields: CollectionField[],
  slugFieldId?: string | null
): string {
  const nameField = collectionFields.find(f => f.key === 'name');
  if (nameField && item.values[nameField.id]) return item.values[nameField.id];
  if (slugFieldId && item.values[slugFieldId]) return item.values[slugFieldId];
  const values = Object.values(item.values);
  return values[0] || item.id;
}

/**
 * Resolve the trigger label for any value the CMS item picker can hold:
 * concrete item ids, dynamic-resolution keywords, or reference-field options.
 * Returns null when the value cannot be resolved (e.g. unknown id).
 */
export function resolveCollectionItemSelectLabel(
  value: string | null | undefined,
  collectionItems: CollectionItemWithValues[],
  collectionFields: CollectionField[],
  referenceItemOptions: ReferenceItemOption[],
  slugFieldId?: string | null
): string | null {
  if (!value) return null;
  switch (value) {
    case COLLECTION_ITEM_KEYWORDS.CURRENT_PAGE: return 'Current page item';
    case COLLECTION_ITEM_KEYWORDS.CURRENT_COLLECTION: return 'Current collection item';
    case COLLECTION_ITEM_KEYWORDS.PREVIOUS_ITEM: return 'Previous item';
    case COLLECTION_ITEM_KEYWORDS.NEXT_ITEM: return 'Next item';
  }
  const refOption = referenceItemOptions.find(opt => opt.value === value);
  if (refOption) return refOption.label;
  const item = collectionItems.find(i => i.id === value);
  if (item) return getCollectionItemDisplayName(item, collectionFields, slugFieldId);
  return null;
}

/**
 * Shared SelectContent items for CMS item pickers used in link settings.
 * Renders dynamic-resolution keywords ("Current page item", "Current collection
 * item", "Next item", "Previous item"), reference-field options, and the
 * concrete item list.
 *
 * When `searchValue` is provided, options are filtered case-insensitively by
 * their visible label.
 */
export default function LinkItemOptions({
  canUseCurrentPageItem,
  canUseCurrentCollectionItem,
  canUseNextPreviousItem = false,
  referenceItemOptions,
  collectionItems,
  collectionFields,
  searchValue,
  isSearching = false,
  slugFieldId,
}: CollectionItemSelectOptionsProps) {
  const query = searchValue?.trim().toLowerCase() ?? '';
  const matches = (label: string) => !query || label.toLowerCase().includes(query);

  const showCurrentPageItem = canUseCurrentPageItem && matches('Current page item');
  const showCurrentCollectionItem = canUseCurrentCollectionItem && matches('Current collection item');
  const showPreviousItem = canUseNextPreviousItem && matches('Previous item');
  const showNextItem = canUseNextPreviousItem && matches('Next item');
  const filteredReferenceOptions = referenceItemOptions.filter(opt => matches(opt.label));
  const filteredItems = collectionItems.filter(item => matches(getCollectionItemDisplayName(item, collectionFields, slugFieldId)));

  const hasSpecialOptions =
    showCurrentPageItem ||
    showCurrentCollectionItem ||
    showPreviousItem ||
    showNextItem ||
    filteredReferenceOptions.length > 0;
  const hasAnyResults = hasSpecialOptions || filteredItems.length > 0;

  if (!hasAnyResults) {
    return (
      <div className="px-2 py-4 text-center text-xs text-muted-foreground">
        {isSearching ? 'Searching...' : (query ? 'No items found' : 'No items available')}
      </div>
    );
  }

  return (
    <>
      {showCurrentPageItem && (
        <SelectItem value={COLLECTION_ITEM_KEYWORDS.CURRENT_PAGE}>
          <div className="flex items-center gap-2">Current page item</div>
        </SelectItem>
      )}
      {showCurrentCollectionItem && (
        <SelectItem value={COLLECTION_ITEM_KEYWORDS.CURRENT_COLLECTION}>
          <div className="flex items-center gap-2">Current collection item</div>
        </SelectItem>
      )}
      {showPreviousItem && (
        <SelectItem value={COLLECTION_ITEM_KEYWORDS.PREVIOUS_ITEM}>
          <div className="flex items-center gap-2">Previous item</div>
        </SelectItem>
      )}
      {showNextItem && (
        <SelectItem value={COLLECTION_ITEM_KEYWORDS.NEXT_ITEM}>
          <div className="flex items-center gap-2">Next item</div>
        </SelectItem>
      )}
      {filteredReferenceOptions.map((opt) => (
        <SelectItem key={opt.value} value={opt.value}>
          <div className="flex items-center gap-2">{opt.label}</div>
        </SelectItem>
      ))}
      {hasSpecialOptions && filteredItems.length > 0 && <SelectSeparator />}
      {filteredItems.map((item) => (
        <SelectItem key={item.id} value={item.id}>
          {getCollectionItemDisplayName(item, collectionFields, slugFieldId)}
        </SelectItem>
      ))}
    </>
  );
}
