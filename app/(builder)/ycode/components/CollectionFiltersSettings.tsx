'use client';

/**
 * Collection Filters Settings Component
 *
 * Settings panel for filtering collection items based on field values.
 * Unlike conditional visibility (which hides rendered layers), filters
 * reduce the dataset before items are rendered - filtering at the data level.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import debounce from 'lodash.debounce';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import SettingsPanel from './SettingsPanel';
import type {
  Layer,
  CollectionField,
  CollectionFieldType,
  VisibilityCondition,
  VisibilityConditionGroup,
  ConditionalVisibility,
  VisibilityOperator,
} from '@/types';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { collectionsApi } from '@/lib/api';
import {
  getFieldIcon,
  getOperatorsForFieldType,
  operatorRequiresValue,
  operatorRequiresItemSelection,
  operatorRequiresSecondValue,
  findDisplayField,
  getItemDisplayName,
  COMPARE_OPERATORS,
  DATE_PRESET_OPTIONS,
  isDatePreset,
  isDateFieldType,
  SELF_OPERATORS,
} from '@/lib/collection-field-utils';
import { clampDateInputValue } from '@/lib/date-format-utils';
import { getCollectionVariable, isInputInsideFilter, resolveFilterInputId, findLayerById } from '@/lib/layer-utils';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { CollectionItemWithValues } from '@/types';

interface CollectionFiltersSettingsProps {
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  collectionId: string;
}

// Groups scalar field types that are mutually comparable, so a "current page
// field" binding only offers fields whose value format matches the condition's
// field (e.g. a text field can bind to another text-like field, not a date).
const SCALAR_FIELD_GROUP: Partial<Record<CollectionFieldType, string>> = {
  number: 'number',
  count: 'number',
  date: 'date',
  date_only: 'date',
  boolean: 'boolean',
  color: 'text',
  text: 'text',
  rich_text: 'text',
  email: 'text',
  phone: 'text',
};

const getScalarFieldGroup = (type?: CollectionFieldType): string | undefined =>
  type ? SCALAR_FIELD_GROUP[type] : undefined;

/**
 * Best-effort singularization of a collection name for "Current X" labels
 * (e.g. "Tags" -> "Tag", "Categories" -> "Category"). Handles the common
 * English plural endings; leaves anything it doesn't recognize untouched.
 */
const singularizeCollectionName = (name: string): string => {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, 'y');
  if (/(sses|shes|ches|xes|zes)$/i.test(name)) return name.replace(/es$/i, '');
  if (/s$/i.test(name) && !/ss$/i.test(name)) return name.replace(/s$/i, '');
  return name;
};

/**
 * Reference Items Selector Component
 * Multi-select dropdown for selecting collection items for is_one_of/is_not_one_of operators
 */
function ReferenceItemsSelector({
  collectionId,
  value,
  onChange,
  currentPageItem,
  currentPageBinding,
}: {
  collectionId: string;
  value: string; // JSON array of item IDs
  onChange: (value: string) => void;
  /** When provided, renders a "Current page item" entry above the items list. */
  currentPageItem?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  /**
   * When provided, renders a "Current {collection}" entry that binds the value
   * to the current dynamic page item (the "Current Category/Tag" pattern).
   */
  currentPageBinding?: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CollectionItemWithValues[]>([]);
  const [loading, setLoading] = useState(false);

  // Get the collection info and fields from the store
  const { collections, fields } = useCollectionsStore();
  const collection = collections.find(c => c.id === collectionId);
  /* eslint-disable-next-line react-hooks/exhaustive-deps -- collectionFields derived from store */
  const collectionFields = fields[collectionId] || [];

  // Find the title/name field for display
  const displayField = useMemo(() => findDisplayField(collectionFields), [collectionFields]);

  // Parse selected IDs from JSON value
  const selectedIds = useMemo(() => {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [value]);

  // Get display name for an item
  const getDisplayName = useCallback(
    (item: CollectionItemWithValues) => getItemDisplayName(item, displayField),
    [displayField]
  );

  // Fetch items when dropdown opens
  useEffect(() => {
    if (open && collectionId) {
      const fetchItems = async () => {
        setLoading(true);
        try {
          const response = await collectionsApi.getItems(collectionId, { limit: 100 });
          if (!response.error) {
            setItems(response.data?.items || []);
          }
        } catch (err) {
          console.error('Failed to load items:', err);
        } finally {
          setLoading(false);
        }
      };
      fetchItems();
    }
  }, [open, collectionId]);

  // Toggle item selection
  const handleToggle = (itemId: string) => {
    const newSelectedIds = selectedIds.includes(itemId)
      ? selectedIds.filter(id => id !== itemId)
      : [...selectedIds, itemId];
    onChange(JSON.stringify(newSelectedIds));
  };

  // Get display text for closed state
  const getDisplayText = () => {
    const bindingCount = currentPageBinding?.checked ? 1 : 0;
    const totalCount = selectedIds.length + (currentPageItem?.checked ? 1 : 0) + bindingCount;
    if (totalCount === 0) return 'Select items...';

    const labels: string[] = [];
    if (currentPageBinding?.checked) labels.push(currentPageBinding.label);
    if (currentPageItem?.checked) labels.push('Current page item');
    for (const id of selectedIds) {
      const item = items.find(i => i.id === id);
      if (item) labels.push(getDisplayName(item));
    }

    if (labels.length > 0 && labels.length <= 2) return labels.join(', ');
    return `${totalCount} item${totalCount !== 1 ? 's' : ''} selected`;
  };

  if (!collectionId) {
    return <div className="text-xs text-muted-foreground">No collection linked</div>;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="input"
          size="sm"
          className="w-full justify-between font-normal"
        >
          <span className="truncate text-xs">{getDisplayText()}</span>
          <Icon name="chevronDown" className="size-2.5 opacity-50 ml-2" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-50 max-h-60 overflow-y-auto" align="start">
        {currentPageBinding && (
          <DropdownMenuCheckboxItem
            checked={currentPageBinding.checked}
            onCheckedChange={(checked) => currentPageBinding.onChange(checked === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {!currentPageBinding.checked && (
              <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <Icon name="database" className="size-2.5 opacity-60" />
              </span>
            )}
            {currentPageBinding.label}
          </DropdownMenuCheckboxItem>
        )}
        {currentPageItem && (
          <DropdownMenuCheckboxItem
            checked={currentPageItem.checked}
            onCheckedChange={(checked) => currentPageItem.onChange(checked === true)}
            onSelect={(e) => e.preventDefault()}
          >
            Current page item
          </DropdownMenuCheckboxItem>
        )}
        {(currentPageBinding || currentPageItem) && items.length > 0 && (
          <DropdownMenuSeparator />
        )}
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Spinner />
          </div>
        ) : items.length === 0 && !currentPageItem ? (
          <div className="text-center py-4 text-xs text-muted-foreground">
            No items in this collection
          </div>
        ) : (
          items.map((item) => {
            const isSelected = selectedIds.includes(item.id);
            return (
              <DropdownMenuCheckboxItem
                key={item.id}
                checked={isSelected}
                onCheckedChange={() => handleToggle(item.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {getDisplayName(item)}
              </DropdownMenuCheckboxItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function CollectionFiltersSettings({
  layer,
  onLayerUpdate,
  collectionId,
}: CollectionFiltersSettingsProps) {
  const [isOpen, setIsOpen] = useState(true);

  // Get fields from the collections store
  const { collections, fields: allFields, loadFields } = useCollectionsStore();
  const fields = allFields[collectionId] || [];

  // Element picker and layer access for filter input linking
  const startElementPicker = useEditorStore((state) => state.startElementPicker);
  const stopElementPicker = useEditorStore((state) => state.stopElementPicker);
  const currentPageId = useEditorStore((state) => state.currentPageId);
  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const pages = usePagesStore((state) => state.pages);
  const draftsByPageId = usePagesStore((state) => state.draftsByPageId);
  const allLayers = useMemo(() => {
    if (!currentPageId) return [];
    const draft = draftsByPageId[currentPageId];
    return draft ? draft.layers : [];
  }, [currentPageId, draftsByPageId]);

  // Dynamic page context: when editing a dynamic CMS page (not a component), the
  // page is bound to a collection whose current item provides "Current
  // {collection}" filter values (the "Current Category/Tag" pattern).
  const currentPage = useMemo(
    () => pages.find((page) => page.id === currentPageId) || null,
    [pages, currentPageId]
  );
  const isDynamicPage = !editingComponentId && !!currentPage?.is_dynamic;
  const pageCollectionId = isDynamicPage ? currentPage?.settings?.cms?.collection_id : undefined;
  const pageCollectionName = useMemo(
    () => collections.find((c) => c.id === pageCollectionId)?.name || 'page',
    [collections, pageCollectionId]
  );
  // Singular form for "Current X" labels (e.g. "Tags" page -> "Current Tag").
  const pageCollectionNameSingular = useMemo(
    () => singularizeCollectionName(pageCollectionName),
    [pageCollectionName]
  );
  const pageCollectionFields = useMemo(
    () => (pageCollectionId ? allFields[pageCollectionId] || [] : []),
    [pageCollectionId, allFields]
  );

  // Load fields if not already loaded
  useEffect(() => {
    if (collectionId && fields.length === 0) {
      loadFields(collectionId);
    }
  }, [collectionId, fields.length, loadFields]);

  // Load the dynamic page collection's fields (for current-page field binding)
  useEffect(() => {
    if (pageCollectionId && (allFields[pageCollectionId]?.length ?? 0) === 0) {
      loadFields(pageCollectionId);
    }
  }, [pageCollectionId, allFields, loadFields]);

  // Get current collection variable
  const collectionVariable = layer ? getCollectionVariable(layer) : null;

  // Initialize groups from layer data (filters are stored in collection.filters)
  const groups: VisibilityConditionGroup[] = useMemo(() => {
    return collectionVariable?.filters?.groups || [];
  }, [collectionVariable?.filters]);

  // Helper to update layer with new filter groups (immediate - for dropdown selections)
  const updateGroups = useCallback((newGroups: VisibilityConditionGroup[]) => {
    if (!layer || !collectionVariable) return;

    const filters: ConditionalVisibility = {
      groups: newGroups,
    };

    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        collection: {
          ...collectionVariable,
          filters: newGroups.length > 0 ? filters : undefined,
        },
      },
    });
  }, [layer, collectionVariable, onLayerUpdate]);

  // Store the latest updateGroups in a ref to avoid stale closures in debounced function
  const updateGroupsRef = useRef(updateGroups);
  updateGroupsRef.current = updateGroups;

  // Track the current layer ID to detect layer changes
  const currentLayerIdRef = useRef(layer?.id);

  // Create a stable debounced function for text inputs
  const debouncedUpdateGroupsRef = useRef(
    debounce((newGroups: VisibilityConditionGroup[]) => {
      updateGroupsRef.current(newGroups);
    }, 150)
  );

  // Cancel pending debounced calls when layer changes to prevent stale updates
  useEffect(() => {
    if (currentLayerIdRef.current !== layer?.id) {
      debouncedUpdateGroupsRef.current.cancel();
      currentLayerIdRef.current = layer?.id;
    }
  }, [layer?.id]);

  // Cleanup on unmount
  useEffect(() => {
    const debouncedFn = debouncedUpdateGroupsRef.current;
    return () => {
      debouncedFn.cancel();
    };
  }, []);

  // Debounced update for text/number inputs
  const debouncedUpdateGroups = useCallback((newGroups: VisibilityConditionGroup[]) => {
    debouncedUpdateGroupsRef.current(newGroups);
  }, []);

  if (!layer || !collectionVariable) {
    return null;
  }

  // Build a fresh "self" condition (filters by the item's own ID).
  const buildSelfCondition = (id: string): VisibilityCondition => ({
    id,
    source: 'self',
    operator: 'is_one_of',
    value: '[]',
    includesCurrentPageItem: true,
  });

  // Handle adding a new condition group for a collection field
  const handleAddFieldConditionGroup = (field: CollectionField) => {
    const newCondition: VisibilityCondition = {
      id: `${Date.now()}-1`,
      source: 'collection_field',
      fieldId: field.id,
      fieldType: field.type,
      referenceCollectionId: field.reference_collection_id || undefined,
      operator: getOperatorsForFieldType(field.type)[0].value,
      value: (field.type === 'reference' || field.type === 'multi_reference') ? '[]' : field.type === 'boolean' ? 'true' : '',
    };

    const newGroup: VisibilityConditionGroup = {
      id: Date.now().toString(),
      conditions: [newCondition],
    };

    updateGroups([...groups, newGroup]);
  };

  const handleAddSelfConditionGroup = () => {
    const newGroup: VisibilityConditionGroup = {
      id: Date.now().toString(),
      conditions: [buildSelfCondition(`${Date.now()}-1`)],
    };
    updateGroups([...groups, newGroup]);
  };

  // Handle adding a condition to an existing group (OR logic)
  const handleAddConditionFromOr = (groupId: string, field: CollectionField) => {
    const newGroups = groups.map(group => {
      if (group.id === groupId) {
        const newCondition: VisibilityCondition = {
          id: `${groupId}-${Date.now()}`,
          source: 'collection_field',
          fieldId: field.id,
          fieldType: field.type,
          referenceCollectionId: field.reference_collection_id || undefined,
          operator: getOperatorsForFieldType(field.type)[0].value,
          value: (field.type === 'reference' || field.type === 'multi_reference') ? '[]' : field.type === 'boolean' ? 'true' : '',
        };
        return {
          ...group,
          conditions: [...group.conditions, newCondition],
        };
      }
      return group;
    });
    updateGroups(newGroups);
  };

  const handleAddSelfConditionFromOr = (groupId: string) => {
    const newGroups = groups.map(group => {
      if (group.id === groupId) {
        return {
          ...group,
          conditions: [...group.conditions, buildSelfCondition(`${groupId}-${Date.now()}`)],
        };
      }
      return group;
    });
    updateGroups(newGroups);
  };

  // Handle removing a condition
  const handleRemoveCondition = (groupId: string, conditionId: string) => {
    const newGroups = groups.map(group => {
      if (group.id === groupId) {
        const newConditions = group.conditions.filter(c => c.id !== conditionId);
        if (newConditions.length === 0) {
          return null;
        }
        return {
          ...group,
          conditions: newConditions,
        };
      }
      return group;
    }).filter((group): group is VisibilityConditionGroup => group !== null);
    updateGroups(newGroups);
  };

  const patchCondition = (
    groupId: string,
    conditionId: string,
    patch: Partial<VisibilityCondition>,
    debounced = false,
  ) => {
    const newGroups = groups.map(group => {
      if (group.id !== groupId) return group;
      return {
        ...group,
        conditions: group.conditions.map(c =>
          c.id === conditionId ? { ...c, ...patch } : c
        ),
      };
    });
    if (debounced) {
      debouncedUpdateGroups(newGroups);
    } else {
      updateGroups(newGroups);
    }
  };

  const handleOperatorChange = (groupId: string, conditionId: string, operator: VisibilityOperator) => {
    const needsSecondValue = operatorRequiresSecondValue(operator);
    const existing = groups.find(g => g.id === groupId)?.conditions.find(c => c.id === conditionId);
    // `is between` has no preset options, so drop a stale preset value carried
    // over from a single-bound operator.
    const value = operatorRequiresValue(operator)
      ? (needsSecondValue && isDatePreset(existing?.value) ? '' : existing?.value)
      : undefined;
    // Current-page binding is only supported for single-bound operators; drop it
    // when switching to a two-bound operator (e.g. date `is between`).
    const dropCurrentPage = needsSecondValue && existing?.valueMode === 'current_page';
    patchCondition(groupId, conditionId, {
      operator,
      value,
      value2: needsSecondValue ? existing?.value2 : undefined,
      inputLayerId2: needsSecondValue ? existing?.inputLayerId2 : undefined,
      valueMode: dropCurrentPage ? 'static' : existing?.valueMode,
      currentPageFieldId: dropCurrentPage ? undefined : existing?.currentPageFieldId,
    });
  };

  const handleValueChange = (groupId: string, conditionId: string, value: string) => {
    patchCondition(groupId, conditionId, { value }, true);
  };

  const handleValue2Change = (groupId: string, conditionId: string, value2: string) => {
    patchCondition(groupId, conditionId, { value2 }, true);
  };

  const handleCompareOperatorChange = (groupId: string, conditionId: string, compareOperator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte') => {
    patchCondition(groupId, conditionId, { compareOperator });
  };

  const handleCompareValueChange = (groupId: string, conditionId: string, compareValue: number) => {
    patchCondition(groupId, conditionId, { compareValue }, true);
  };

  // Get field name by ID
  const getFieldName = (fieldId: string): string => {
    const field = fields?.find(f => f.id === fieldId);
    return field?.name || 'Unknown field';
  };

  // Get field type by ID
  const getFieldType = (fieldId: string): CollectionFieldType | undefined => {
    const field = fields?.find(f => f.id === fieldId);
    return field?.type;
  };

  const handlePickInputForCondition = (groupId: string, conditionId: string, origin?: { x: number; y: number }) => {
    startElementPicker(
      (layerId: string) => {
        const resolvedId = resolveFilterInputId(layerId, allLayers);
        patchCondition(groupId, conditionId, {
          inputLayerId: resolvedId,
          value: undefined,
          valueMode: 'static',
          currentPageFieldId: undefined,
        });
        stopElementPicker();
      },
      (layerId: string) => isInputInsideFilter(layerId, allLayers),
      origin
    );
  };

  const handlePickSecondInputForCondition = (groupId: string, conditionId: string, origin?: { x: number; y: number }) => {
    startElementPicker(
      (layerId: string) => {
        const resolvedId = resolveFilterInputId(layerId, allLayers);
        patchCondition(groupId, conditionId, { inputLayerId2: resolvedId, value2: undefined });
        stopElementPicker();
      },
      (layerId: string) => isInputInsideFilter(layerId, allLayers),
      origin
    );
  };

  const handleUnlinkInput = (groupId: string, conditionId: string) => {
    patchCondition(groupId, conditionId, { inputLayerId: undefined });
  };

  const handleUnlinkSecondInput = (groupId: string, conditionId: string) => {
    patchCondition(groupId, conditionId, { inputLayerId2: undefined });
  };

  // Get linked input display name
  const getLinkedInputName = (inputLayerId: string): string => {
    const inputLayer = findLayerById(allLayers, inputLayerId);
    if (!inputLayer) return `Unknown input [${inputLayerId}]`;
    const layerName = inputLayer.customName || inputLayer.name || 'Input';
    return `${layerName} [${inputLayerId}]`;
  };

  // Render the dropdown content for adding conditions
  const renderAddConditionDropdown = (
    onFieldSelect: (field: CollectionField) => void,
    onSelfSelect: () => void,
  ) => (
    <DropdownMenuContent align="end" className="max-h-75! overflow-y-auto">
      <DropdownMenuLabel className="text-xs text-muted-foreground">Item</DropdownMenuLabel>
      <DropdownMenuItem onClick={onSelfSelect} className="flex items-center gap-2">
        <Icon name="database" className="size-3 opacity-60" />
        Item ID
      </DropdownMenuItem>

      {fields && fields.length > 0 && (
        <>
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Collection Fields
          </DropdownMenuLabel>
          {fields.map((field) => (
            <DropdownMenuItem
              key={field.id}
              onClick={() => onFieldSelect(field)}
              className="flex items-center gap-2"
            >
              <Icon name={getFieldIcon(field.type)} className="size-3 opacity-60" />
              {field.name}
            </DropdownMenuItem>
          ))}
        </>
      )}
    </DropdownMenuContent>
  );

  // Get reference collection ID from condition or look it up from field
  const getReferenceCollectionId = (condition: VisibilityCondition): string | undefined => {
    if (condition.referenceCollectionId) {
      return condition.referenceCollectionId;
    }
    // Fallback: look up from field
    if (condition.fieldId) {
      const field = fields?.find(f => f.id === condition.fieldId);
      return field?.reference_collection_id || undefined;
    }
    return undefined;
  };

  // Render a single condition
  // Render a `source: 'self'` condition (filter the collection by item identity).
  const renderSelfCondition = (
    condition: VisibilityCondition,
    group: VisibilityConditionGroup,
    index: number,
  ) => (
    <React.Fragment key={condition.id}>
      {index > 0 && (
        <li className="flex items-center gap-2 h-6">
          <Label variant="muted" className="text-[10px]">Or</Label>
          <hr className="flex-1" />
        </li>
      )}
      <li className="*:w-full flex flex-col gap-2">
        <header className="flex items-center gap-1.5">
          <div className="size-5 flex items-center justify-center rounded-[6px] bg-secondary/50 hover:bg-secondary">
            <Icon name="database" className="size-2.5 opacity-60" />
          </div>
          <Label variant="muted" className="truncate">Item ID</Label>
          <span
            role="button"
            tabIndex={0}
            className="ml-auto -my-1 -mr-0.5 shrink-0 p-0.5 rounded-sm opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
            onClick={() => handleRemoveCondition(group.id, condition.id)}
          >
            <Icon name="x" className="size-2.5" />
          </span>
        </header>

        <Select
          value={condition.operator}
          onValueChange={(value) => patchCondition(group.id, condition.id, { operator: value as VisibilityOperator })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {SELF_OPERATORS.map((op) => (
                <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <ReferenceItemsSelector
          collectionId={collectionId}
          value={condition.value || '[]'}
          onChange={(value) => handleValueChange(group.id, condition.id, value)}
          currentPageItem={{
            checked: !!condition.includesCurrentPageItem,
            onChange: (checked) => patchCondition(group.id, condition.id, { includesCurrentPageItem: checked }),
          }}
        />
      </li>
    </React.Fragment>
  );

  const renderCondition = (condition: VisibilityCondition, group: VisibilityConditionGroup, index: number) => {
    if (condition.source === 'self') {
      return renderSelfCondition(condition, group, index);
    }
    const fieldType = condition.fieldType || getFieldType(condition.fieldId || '');
    const icon = getFieldIcon(fieldType);
    const displayName = getFieldName(condition.fieldId || '');
    const referenceCollectionId = getReferenceCollectionId(condition);
    const isCurrentPageMode = condition.valueMode === 'current_page';
    // 'contains exactly' compares against a single current-page id, which can never
    // match a real multi-reference set, so hide it while bound to the current item.
    const operators = isCurrentPageMode
      ? getOperatorsForFieldType(fieldType).filter((op) => op.value !== 'contains_exactly')
      : getOperatorsForFieldType(fieldType);
    // A reference field can bind to "Current {collection}" only when its target
    // collection matches the dynamic page's collection (so the page item is a
    // valid member of the compared set).
    const canBindReferenceToCurrentPage = isDynamicPage
      && !!pageCollectionId
      && referenceCollectionId === pageCollectionId;
    // Scalar fields can bind to a value-compatible field on the current page item.
    const compatiblePageFields = isDynamicPage
      ? pageCollectionFields.filter(
        (f) => !!getScalarFieldGroup(f.type) && getScalarFieldGroup(f.type) === getScalarFieldGroup(fieldType)
      )
      : [];
    // Date fields use a dropdown for value mode; the "Filter form input" option
    // is the only place that reveals the link-to-input target icon. Falls back
    // to a linked input for conditions saved before `dateInput` existed.
    const isDateInputMode = isDateFieldType(fieldType)
      && (condition.dateInput === true || !!condition.inputLayerId);
    // Same mode tracking for the second bound (`is_between`).
    const isDateInputMode2 = isDateFieldType(fieldType)
      && (condition.dateInput2 === true || !!condition.inputLayerId2);

    return (
      <React.Fragment key={condition.id}>
        {index > 0 && (
          <li className="flex items-center gap-2 h-6">
            <Label variant="muted" className="text-[10px]">Or</Label>
            <hr className="flex-1" />
          </li>
        )}

        <li className="*:w-full flex flex-col gap-2">
          <header className="flex items-center gap-1.5">
            <div className="size-5 flex items-center justify-center rounded-[6px] bg-secondary/50 hover:bg-secondary">
              <Icon name={icon} className="size-2.5 opacity-60" />
            </div>
            <Label variant="muted" className="truncate">{displayName}</Label>

            <span
              role="button"
              tabIndex={0}
              className="ml-auto -my-1 -mr-0.5 shrink-0 p-0.5 rounded-sm opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
              onClick={() => handleRemoveCondition(group.id, condition.id)}
            >
              <Icon name="x" className="size-2.5" />
            </span>
          </header>

          {/* Operator Select */}
          <Select
            value={condition.operator}
            onValueChange={(value) => handleOperatorChange(group.id, condition.id, value as VisibilityOperator)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {operators.map((op) => (
                  <SelectItem key={op.value} value={op.value}>
                    {op.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {/* Value Input(s) based on operator */}
          {condition.operator === 'item_count' && (
            <div className="flex gap-2">
              <Select
                value={condition.compareOperator || 'eq'}
                onValueChange={(value) => handleCompareOperatorChange(group.id, condition.id, value as any)}
              >
                <SelectTrigger className="w-1/2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {COMPARE_OPERATORS.map((op) => (
                      <SelectItem key={op.value} value={op.value}>
                        {op.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Input
                type="number"
                placeholder="0"
                value={condition.compareValue ?? ''}
                onChange={(e) => handleCompareValueChange(group.id, condition.id, parseInt(e.target.value) || 0)}
                className="w-1/2"
              />
            </div>
          )}

          {/* Reference/Multi-reference items selector (with element picker support) */}
          {operatorRequiresItemSelection(condition.operator) && referenceCollectionId && (
            <>
              {condition.inputLayerId ? (
                <div className="flex items-center gap-1">
                  <Input value={getLinkedInputName(condition.inputLayerId)} disabled />
                  <div className="shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="secondary" onClick={() => handleUnlinkInput(group.id, condition.id)}>
                          <Icon name="x" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Unlink filter input</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <div className="flex-1">
                    <ReferenceItemsSelector
                      collectionId={referenceCollectionId}
                      value={condition.value || '[]'}
                      onChange={(value) => handleValueChange(group.id, condition.id, value)}
                      currentPageBinding={canBindReferenceToCurrentPage ? {
                        label: `Current ${pageCollectionNameSingular}`,
                        checked: isCurrentPageMode,
                        onChange: (checked) => patchCondition(group.id, condition.id, {
                          valueMode: checked ? 'current_page' : 'static',
                          // 'contains exactly' against a single current-page id can never
                          // match — the intent is "contains the current item".
                          ...(checked && condition.operator === 'contains_exactly'
                            ? { operator: 'contains_all_of' as VisibilityOperator }
                            : {}),
                        }),
                      } : undefined}
                    />
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        onClick={(e) => {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          handlePickInputForCondition(group.id, condition.id, {
                            x: rect.left + rect.width / 2,
                            y: rect.top + rect.height / 2,
                          });
                        }}
                      >
                        <Icon name="crosshair" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Link to filter input</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </>
          )}

          {operatorRequiresValue(condition.operator) && condition.operator !== 'item_count' && !operatorRequiresItemSelection(condition.operator) && (
            <>
              {condition.inputLayerId ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={getLinkedInputName(condition.inputLayerId)}
                    disabled
                  />
                  <div className="shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="secondary" onClick={() => handleUnlinkInput(group.id, condition.id)}>
                          <Icon name="x" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Unlink filter input</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ) : isCurrentPageMode ? (
                <div className="flex items-center gap-1">
                  <div className="flex-1">
                    <Select
                      value={condition.currentPageFieldId || ''}
                      onValueChange={(v) => patchCondition(group.id, condition.id, { currentPageFieldId: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={`Current ${pageCollectionNameSingular} field...`} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {compatiblePageFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              <span className="flex items-center gap-2">
                                <Icon name={getFieldIcon(f.type)} className="size-3 opacity-60" />
                                {f.name}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        onClick={() => patchCondition(group.id, condition.id, { valueMode: 'static', currentPageFieldId: undefined })}
                      >
                        <Icon name="x" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Use static value</TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <div className="flex-1">
                    {fieldType === 'boolean' ? (
                      <Select
                        value={condition.value || 'true'}
                        onValueChange={(value) => handleValueChange(group.id, condition.id, value)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="true">True</SelectItem>
                            <SelectItem value="false">False</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : isDateFieldType(fieldType) ? (
                      <div className="flex flex-col gap-1.5">
                        <Select
                          value={isDatePreset(condition.value) ? condition.value : (isDateInputMode ? '_input' : '_custom')}
                          onValueChange={(v) => {
                            if (v === '_input') {
                              patchCondition(group.id, condition.id, { dateInput: true, value: '' });
                            } else if (v === '_custom') {
                              patchCondition(group.id, condition.id, { dateInput: false, value: '' });
                            } else {
                              patchCondition(group.id, condition.id, { dateInput: false, value: v });
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="_custom">Custom date</SelectItem>
                              {/* Presets resolve to a single day/range, so they only
                                  apply to single-bound operators — not `is between`. */}
                              {!operatorRequiresSecondValue(condition.operator) && DATE_PRESET_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                              ))}
                              <SelectItem value="_input">Filter form input</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {!isDatePreset(condition.value) && !isDateInputMode && (
                          <Input
                            type="date"
                            value={condition.value || ''}
                            onChange={(e) => patchCondition(group.id, condition.id, { value: clampDateInputValue(e.target.value) })}
                          />
                        )}
                      </div>
                    ) : fieldType === 'number' ? (
                      <Input
                        type="number"
                        placeholder="Enter value..."
                        value={condition.value || ''}
                        onChange={(e) => handleValueChange(group.id, condition.id, e.target.value)}
                      />
                    ) : (
                      <Input
                        placeholder="Enter value..."
                        value={condition.value || ''}
                        onChange={(e) => handleValueChange(group.id, condition.id, e.target.value)}
                      />
                    )}
                  </div>
                  {(!isDateFieldType(fieldType) || isDateInputMode) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="secondary"
                          onClick={(e) => {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            handlePickInputForCondition(group.id, condition.id, {
                              x: rect.left + rect.width / 2,
                              y: rect.top + rect.height / 2,
                            });
                          }}
                        >
                          <Icon name="crosshair" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Link to filter input</TooltipContent>
                    </Tooltip>
                  )}
                  {!isDateFieldType(fieldType) && !operatorRequiresSecondValue(condition.operator) && compatiblePageFields.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="secondary"
                          onClick={() => patchCondition(group.id, condition.id, {
                            valueMode: 'current_page',
                            currentPageFieldId: compatiblePageFields[0]?.id,
                          })}
                        >
                          <Icon name="database" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Use current {pageCollectionNameSingular} field</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}

              {/* Second value for date between — mirrors the primary date UI:
                  a Custom date / Filter form input select, with the date input
                  (custom) or the link-to-input target icon (input mode). */}
              {operatorRequiresSecondValue(condition.operator) && (
                <>
                  <Label variant="muted" className="text-[10px] text-center">and</Label>
                  {condition.inputLayerId2 ? (
                    <div className="flex items-center gap-1">
                      <Input
                        value={getLinkedInputName(condition.inputLayerId2)}
                        disabled
                      />
                      <div className="shrink-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="secondary" onClick={() => handleUnlinkSecondInput(group.id, condition.id)}>
                              <Icon name="x" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Unlink second filter input</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <div className="flex-1 flex flex-col gap-1.5">
                        <Select
                          value={isDateInputMode2 ? '_input' : '_custom'}
                          onValueChange={(v) => {
                            if (v === '_input') {
                              patchCondition(group.id, condition.id, { dateInput2: true, value2: '' });
                            } else {
                              patchCondition(group.id, condition.id, { dateInput2: false, value2: '' });
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="_custom">Custom date</SelectItem>
                              <SelectItem value="_input">Filter form input</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {!isDateInputMode2 && (
                          <Input
                            type="date"
                            value={condition.value2 || ''}
                            onChange={(e) => patchCondition(group.id, condition.id, { value2: clampDateInputValue(e.target.value) })}
                          />
                        )}
                      </div>
                      {isDateInputMode2 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="secondary"
                              onClick={(e) => {
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                handlePickSecondInputForCondition(group.id, condition.id, {
                                  x: rect.left + rect.width / 2,
                                  y: rect.top + rect.height / 2,
                                });
                              }}
                            >
                              <Icon name="crosshair" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Link second filter input</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </li>
      </React.Fragment>
    );
  };

  return (
    <SettingsPanel
      title="Filters"
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
      action={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="xs">
              <Icon name="plus" />
            </Button>
          </DropdownMenuTrigger>
          {renderAddConditionDropdown(handleAddFieldConditionGroup, handleAddSelfConditionGroup)}
        </DropdownMenu>
      }
    >
      <div className="flex flex-col gap-3">
        {groups.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">
            No filters set. Click + to add a filter.
          </div>
        ) : (
          groups.map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              {groupIndex > 0 && (
                <div className="flex items-center gap-2 py-1">
                  <hr className="flex-1" />
                  <Label variant="muted" className="text-[10px]">And</Label>
                  <hr className="flex-1" />
                </div>
              )}
              <div className="flex flex-col bg-muted rounded-lg">
                <ul className="p-2 flex flex-col gap-2">
                  {group.conditions.map((condition, index) =>
                    renderCondition(condition, group, index)
                  )}

                  <li className="flex items-center gap-2 h-6">
                    <Label variant="muted" className="text-[10px]">Or</Label>
                    <hr className="flex-1" />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost" size="xs"
                          className="size-5"
                        >
                          <div>
                            <Icon name="plus" className="size-2.5!" />
                          </div>
                        </Button>
                      </DropdownMenuTrigger>
                      {renderAddConditionDropdown(
                        (field) => handleAddConditionFromOr(group.id, field),
                        () => handleAddSelfConditionFromOr(group.id),
                      )}
                    </DropdownMenu>
                  </li>
                </ul>
              </div>
            </React.Fragment>
          ))
        )}
      </div>
    </SettingsPanel>
  );
}
