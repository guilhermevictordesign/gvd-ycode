'use client';

/**
 * Link Settings Component
 *
 * Settings panel for layer links (URL, email, phone, asset, page, field).
 * Can also be used in standalone mode for component variables.
 */

import React, { useState, useCallback, useMemo } from 'react';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import Icon, { type IconProps } from '@/components/ui/icon';
import SettingsPanel from './SettingsPanel';
import RichTextEditor from './RichTextEditor';
import { filterFieldGroupsByType, flattenFieldGroups, LINK_FIELD_TYPES, buildReferenceItemOptions } from '@/lib/collection-field-utils';
import { generateLinkHref } from '@/lib/link-utils';
import LinkCollectionItemPicker from './LinkCollectionItemPicker';
import { FieldSelectDropdown, type FieldGroup, type FieldSourceType } from './CollectionFieldSelector';
import ComponentVariableLabel, { VARIABLE_TYPE_ICONS } from './ComponentVariableLabel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Layer, CollectionField, Collection, Page, LinkSettings as LinkSettingsType, LinkType, LinkSettingsValue } from '@/types';
import {
  createDynamicTextVariable,
  getDynamicTextContent,
} from '@/lib/variable-utils';
import { usePagesStore } from '@/stores/usePagesStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { ASSET_CATEGORIES, getAssetIcon } from '@/lib/asset-utils';
import { toast } from 'sonner';
import { pagesApi } from '@/lib/api';
import { canLayerHaveLink, getCollectionVariable, findLayersWithAnchorId } from '@/lib/layer-utils';
import { getLayerIcon, getLayerName } from '@/lib/layer-display-utils';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import PageSelector from './PageSelector';

// Re-export LinkSettingsValue from types for convenience
export type { LinkSettingsValue } from '@/types';

// Layer mode props - for editing layer links
interface LayerModeProps {
  mode?: 'layer';
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  value?: never;
  onChange?: never;
}

// Standalone mode props - for component variables
interface StandaloneModeProps {
  mode: 'standalone';
  value: LinkSettingsValue | null | undefined;
  onChange: (value: LinkSettingsValue | null) => void;
  layer?: never;
  onLayerUpdate?: never;
}

// Common props for both modes
interface CommonProps {
  /** Field groups with labels and sources for inline variable selection */
  fieldGroups?: FieldGroup[];
  allFields?: Record<string, CollectionField[]>;
  collections?: Collection[];
  isLockedByOther?: boolean;
  isInsideCollectionLayer?: boolean; // Whether fields come from a collection layer (vs page fields)
  onOpenVariablesDialog?: (variableId?: string) => void;
  /** When true, standalone mode uses grid-cols-3 layout with labels on the left (like layer mode) */
  gridLayout?: boolean;
  /** Label for the link type selector row when using gridLayout in standalone mode */
  typeLabel?: string;
  /** Restrict which link types are available (e.g., ['page', 'url']) */
  allowedTypes?: (LinkType | 'none')[];
  /** When true, hides the behavior section (open in new tab, no follow, etc.) */
  hideBehavior?: boolean;
}

type LinkSettingsProps = (LayerModeProps | StandaloneModeProps) & CommonProps;

export default function LinkSettings(props: LinkSettingsProps) {
  const {
    fieldGroups,
    allFields,
    collections,
    isLockedByOther,
    isInsideCollectionLayer = false,
    onOpenVariablesDialog,
    gridLayout,
    typeLabel,
    allowedTypes,
    hideBehavior,
  } = props;

  // Determine mode
  const isStandaloneMode = props.mode === 'standalone';

  // Standalone mode uses stacked layout by default, grid layout when gridLayout prop is set
  const useStackedLayout = isStandaloneMode && !gridLayout;

  // Mode-specific props
  const layer = isStandaloneMode ? null : props.layer;
  const onLayerUpdate = isStandaloneMode ? undefined : props.onLayerUpdate;
  const standaloneValue = isStandaloneMode ? props.value : undefined;
  const standaloneOnChange = isStandaloneMode ? props.onChange : undefined;

  const [isOpen, setIsOpen] = useState(true);

  // Stores
  const pages = usePagesStore((state) => state.pages);
  const draftsByPageId = usePagesStore((state) => state.draftsByPageId);
  const currentPageId = useEditorStore((state) => state.currentPageId);
  const openFileManager = useEditorStore((state) => state.openFileManager);
  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const getAsset = useAssetsStore((state) => state.getAsset);
  const getComponentById = useComponentsStore((state) => state.getComponentById);
  const addLinkVariable = useComponentsStore((state) => state.addLinkVariable);
  const updateTextVariable = useComponentsStore((state) => state.updateTextVariable);

  // Get component variables for link linking (when editing a component in layer mode)
  const editingComponent = !isStandaloneMode && editingComponentId ? getComponentById(editingComponentId) : undefined;
  const componentVariables = editingComponent?.variables || [];
  // Filter to only link-type variables
  const linkComponentVariables = componentVariables.filter(v => v.type === 'link');

  // Get current link settings (from layer or standalone value)
  const linkSettings = isStandaloneMode ? standaloneValue : layer?.variables?.link;
  const linkType = linkSettings?.type || 'none';

  // Get linked link variable ID from layer (stored in linkSettings with a variable_id)
  const linkedLinkVariableId = !isStandaloneMode && linkSettings ? (linkSettings as any).variable_id : undefined;
  const linkedLinkVariable = linkComponentVariables.find(v => v.id === linkedLinkVariableId);

  // Get effective link settings - use variable's default value when linked
  const linkedVariableDefaultValue = linkedLinkVariable?.default_value as LinkSettingsValue | undefined;
  const effectiveLinkSettings = linkedLinkVariable ? linkedVariableDefaultValue : linkSettings;
  const effectiveLinkType = effectiveLinkSettings?.type || 'none';

  // Get current values based on link type
  const urlValue = useMemo(() => {
    if (linkSettings?.url) {
      return getDynamicTextContent(linkSettings.url);
    }
    return '';
  }, [linkSettings?.url]);

  const emailValue = useMemo(() => {
    if (linkSettings?.email) {
      return getDynamicTextContent(linkSettings.email);
    }
    return '';
  }, [linkSettings?.email]);

  const phoneValue = useMemo(() => {
    if (linkSettings?.phone) {
      return getDynamicTextContent(linkSettings.phone);
    }
    return '';
  }, [linkSettings?.phone]);

  const assetId = linkSettings?.asset?.id || null;
  const pageId = linkSettings?.page?.id || null;
  const collectionItemId = linkSettings?.page?.collection_item_id || null;
  const fieldId = linkSettings?.field?.data?.field_id || null;
  const anchorLayerId = linkSettings?.anchor_layer_id || '';

  // Get link behavior from link settings
  const target = linkSettings?.target || '_self';
  const download = linkSettings?.download || false;
  const rel = linkSettings?.rel || '';

  // Get the selected page
  const selectedPage = useMemo(() => {
    if (!pageId) return null;
    return pages.find((p) => p.id === pageId) || null;
  }, [pageId, pages]);

  // Get layers for anchor selection based on link type
  const anchorLayers = useMemo(() => {
    let targetPageId: string | null = null;

    if (linkType === 'page' && pageId) {
      targetPageId = pageId;
    } else if (linkType === 'url' && currentPageId) {
      targetPageId = currentPageId;
    }

    if (!targetPageId) return [];

    const draft = draftsByPageId[targetPageId];
    if (!draft || !draft.layers) return [];

    return findLayersWithAnchorId(draft.layers);
  }, [linkType, pageId, currentPageId, draftsByPageId]);

  // Check if selected page is dynamic
  const isDynamicPage = selectedPage?.is_dynamic || false;

  // Check if the current page is dynamic
  const currentPage = currentPageId ? pages.find(p => p.id === currentPageId) : null;
  const isCurrentPageDynamic = currentPage?.is_dynamic || false;

  // "Current page item" only makes sense when both pages use the same collection
  const currentPageCollectionId = currentPage?.settings?.cms?.collection_id || null;
  const targetPageCollectionId = selectedPage?.settings?.cms?.collection_id || null;
  const canUseCurrentPageItem = isDynamicPage && isCurrentPageDynamic
    && !!currentPageCollectionId && currentPageCollectionId === targetPageCollectionId;

  // Next/previous navigation only makes sense when the link points back at the
  // same dynamic page the user is editing — that's the only context where
  // "previous" / "next" relative to the current item is well-defined.
  const canUseNextPreviousItem = isDynamicPage && isCurrentPageDynamic && !!pageId && pageId === currentPageId;

  // Check if the layer itself is a collection layer
  const isCollectionLayer = !!(layer && getCollectionVariable(layer));

  // Filter fieldGroups for CMS field link: link, email, phone, image (mailto:/tel: added at render for email/phone)
  // Keep groups separate for organized dropdown display
  const linkFieldGroups = useMemo(
    () => filterFieldGroupsByType(fieldGroups, LINK_FIELD_TYPES, { excludeMultipleAsset: true }),
    [fieldGroups]
  );

  // Flatten field groups for field lookup
  const linkFields = useMemo(
    () => flattenFieldGroups(linkFieldGroups),
    [linkFieldGroups]
  );

  // Check if we have collection fields available (from collection layer context)
  // Show current-collection option when inside a collection layer OR when the layer IS a collection layer
  const collectionGroup = fieldGroups?.find(g => g.source === 'collection');
  const hasCollectionFields = !!(collectionGroup && collectionGroup.fields.length > 0 && isInsideCollectionLayer);
  const canUseCurrentCollectionItem = hasCollectionFields || isCollectionLayer;

  // Find reference fields that point to the target page's collection
  const referenceItemOptions = useMemo(
    () => buildReferenceItemOptions(isDynamicPage, targetPageCollectionId, fieldGroups),
    [isDynamicPage, targetPageCollectionId, fieldGroups]
  );

  // Get collection ID from dynamic page settings
  const pageCollectionId = selectedPage?.settings?.cms?.collection_id || null;

  const collectionPickerId = isDynamicPage ? pageCollectionId : null;

  // Check if link settings should be disabled due to nesting restrictions
  const linkNestingIssue = useMemo(() => {
    if (!layer || !currentPageId) return null;

    const draft = draftsByPageId[currentPageId];
    if (!draft || !draft.layers) return null;

    // Check if layer can have a layer-level link (includes rich text links check)
    const { canHaveLinks, issue } = canLayerHaveLink(layer, draft.layers);

    // Only show issue if there's no existing link (allow editing existing links)
    if (!canHaveLinks && issue && linkType === 'none') {
      return issue;
    }

    return null;
  }, [layer, currentPageId, draftsByPageId, linkType]);

  // Link type options for the dropdown
  const linkTypeOptions = useMemo<
    Array<
      | { value: LinkType | 'none'; label: string; icon: string; disabled?: boolean }
      | { type: 'separator' }
    >
  >(() => {
    const allOptions: Array<
      | { value: LinkType | 'none'; label: string; icon: string; disabled?: boolean }
      | { type: 'separator' }
    > = [
      { value: 'none', label: 'No link', icon: 'none' },
      { type: 'separator' },
      { value: 'page', label: 'Page', icon: 'page' },
      { value: 'asset', label: 'Asset', icon: 'paperclip' },
      { value: 'field', label: 'CMS field', icon: 'database', disabled: linkFieldGroups.length === 0 },
      { type: 'separator' },
      { value: 'url', label: 'URL', icon: 'link' },
      { value: 'email', label: 'Email', icon: 'email' },
      { value: 'phone', label: 'Phone', icon: 'phone' },
    ];

    if (!allowedTypes) return allOptions;

    const allowed = new Set(allowedTypes);
    const filtered = allOptions.filter(
      (option) => 'type' in option || ('value' in option && allowed.has(option.value))
    );

    // Remove consecutive/trailing separators
    return filtered.filter((option, index, arr) => {
      if (!('type' in option)) return true;
      const next = arr[index + 1];
      const prev = arr[index - 1];
      // Remove separator at start, end, or before another separator
      if (index === 0 || index === arr.length - 1) return false;
      if (!next || ('type' in next)) return false;
      if (!prev || ('type' in prev)) return false;
      return true;
    });
  }, [linkFieldGroups, allowedTypes]);

  // Update link settings helper - supports both layer and standalone mode
  const updateLinkSettings = useCallback(
    (newSettings: Partial<LinkSettingsType> | null) => {
      if (isStandaloneMode) {
        // In standalone mode, call onChange with the new settings (null = explicit "no link" override)
        standaloneOnChange?.(newSettings as LinkSettingsType | null);
        return;
      }

      // Layer mode - update the layer
      if (!layer || !onLayerUpdate) return;

      onLayerUpdate(layer.id, {
        variables: {
          ...layer.variables,
          link: newSettings as LinkSettingsType,
        },
      });
    },
    [isStandaloneMode, standaloneOnChange, layer, onLayerUpdate]
  );

  // Handle linking link to a component variable
  const handleLinkLinkVariable = useCallback((variableId: string) => {
    if (!layer || !onLayerUpdate) return;

    const currentLink = layer.variables?.link;

    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        link: currentLink
          ? { ...currentLink, variable_id: variableId } as any
          : { type: 'none', variable_id: variableId } as any,
      },
    });
  }, [layer, onLayerUpdate]);

  // Handle unlinking link from a component variable
  const handleUnlinkLinkVariable = useCallback(() => {
    if (!layer || !onLayerUpdate) return;

    const currentLink = layer.variables?.link;
    if (!currentLink) return;

    // Remove variable_id from link settings
    const { variable_id, ...restLink } = currentLink as any;

    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        link: restLink,
      },
    });
  }, [layer, onLayerUpdate]);

  // Handle link type change
  const handleLinkTypeChange = useCallback(
    (newType: LinkType | 'none') => {
      // In layer mode, require a layer
      if (!isStandaloneMode && !layer) return;

      if (newType === 'none') {
        // Remove link settings
        updateLinkSettings(null);
        return;
      }

      // Create new link settings with the new type
      const newSettings: LinkSettingsType = {
        type: newType,
      };

      // Initialize with empty values based on type
      switch (newType) {
        case 'url':
          newSettings.url = createDynamicTextVariable('');
          break;
        case 'email':
          newSettings.email = createDynamicTextVariable('');
          break;
        case 'phone':
          newSettings.phone = createDynamicTextVariable('');
          break;
        case 'asset':
          newSettings.asset = { id: null };
          break;
        case 'page':
          newSettings.page = { id: '', collection_item_id: null };
          break;
        case 'field':
          newSettings.field = { type: 'field', data: { field_id: null, relationships: [], field_type: null } };
          break;
      }

      updateLinkSettings(newSettings);
    },
    [isStandaloneMode, layer, updateLinkSettings]
  );

  // Handle URL change
  const handleUrlChange = useCallback(
    (value: string) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      updateLinkSettings({
        ...linkSettings,
        url: createDynamicTextVariable(value),
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings]
  );

  // Handle email change
  const handleEmailChange = useCallback(
    (value: string) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      updateLinkSettings({
        ...linkSettings,
        email: createDynamicTextVariable(value),
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings]
  );

  // Handle phone change
  const handlePhoneChange = useCallback(
    (value: string) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      updateLinkSettings({
        ...linkSettings,
        phone: createDynamicTextVariable(value),
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings]
  );

  // Handle asset selection
  const handleAssetSelect = useCallback(() => {
    if ((!isStandaloneMode && !layer) || !linkSettings) return;

    openFileManager(
      (asset) => {
        updateLinkSettings({
          ...linkSettings,
          asset: { id: asset.id },
        });
      },
      assetId || undefined,
      undefined // All asset types allowed for download
    );
  }, [isStandaloneMode, layer, linkSettings, assetId, openFileManager, updateLinkSettings]);

  // Handle page selection
  const handlePageChange = useCallback(
    (newPageId: string) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      updateLinkSettings({
        ...linkSettings,
        page: {
          id: newPageId,
          collection_item_id: null, // Reset item when page changes
        },
        anchor_layer_id: null, // Reset anchor when page changes
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings]
  );

  // Handle collection item selection.
  // The selection value is stored verbatim; it's either a concrete item id or
  // one of the dynamic-resolution keywords (current-page / current-collection /
  // next-item / previous-item / ref-*). Resolution happens at render time in
  // `generateLinkHref`.
  const handleCollectionItemChange = useCallback(
    (itemId: string) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      updateLinkSettings({
        ...linkSettings,
        page: {
          ...linkSettings.page!,
          collection_item_id: itemId,
        },
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings]
  );

  // Handle field selection (field type is stored for link resolution)
  const handleFieldChange = useCallback(
    (
      selectedFieldId: string,
      relationshipPath: string[],
      source?: FieldSourceType,
      layerId?: string
    ) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      // Find the field type
      const field = linkFields.find(f => f.id === selectedFieldId);
      const fieldType = field?.type;

      updateLinkSettings({
        ...linkSettings,
        field: {
          type: 'field',
          data: {
            field_id: selectedFieldId,
            relationships: relationshipPath,
            field_type: fieldType || null,
            source,
            collection_layer_id: layerId,
          },
        },
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings, linkFields]
  );

  // Handle anchor layer ID change
  const handleAnchorLayerIdChange = useCallback(
    (value: string) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      updateLinkSettings({
        ...linkSettings,
        anchor_layer_id: value === 'none' ? null : value,
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings]
  );

  // Handle target change
  const handleTargetChange = useCallback(
    (checked: boolean) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      const newTarget = checked ? '_blank' : '_self';
      const currentRel = (rel || '').replace(/\b(noopener|noreferrer)\b/g, '').replace(/\s+/g, ' ').trim();
      const securityTokens = checked ? 'noopener noreferrer' : '';
      const newRel = [securityTokens, currentRel].filter(Boolean).join(' ');

      updateLinkSettings({
        ...linkSettings,
        target: newTarget,
        rel: newRel,
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings]
  );

  // Handle download change
  const handleDownloadChange = useCallback(
    (checked: boolean) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      updateLinkSettings({
        ...linkSettings,
        download: checked,
      });
    },
    [isStandaloneMode, layer, linkSettings, updateLinkSettings]
  );

  // Handle nofollow change
  const handleNofollowChange = useCallback(
    (checked: boolean) => {
      if ((!isStandaloneMode && !layer) || !linkSettings) return;

      const currentRel = rel || '';
      const hasNofollow = currentRel.includes('nofollow');
      let newRel = currentRel;

      if (checked && !hasNofollow) {
        newRel = currentRel ? `${currentRel} nofollow` : 'nofollow';
      } else if (!checked && hasNofollow) {
        newRel = currentRel.replace(/\s*nofollow\s*/g, ' ').trim();
      }

      updateLinkSettings({
        ...linkSettings,
        rel: newRel,
      });
    },
    [isStandaloneMode, layer, linkSettings, rel, updateLinkSettings]
  );

  // Get asset info for display
  const selectedAsset = assetId ? getAsset(assetId) : null;

  // Layer mode requires a layer
  if (!isStandaloneMode && !layer) return null;

  // Don't show link settings for component layers (layer mode only)
  if (!isStandaloneMode && layer?.componentId) return null;

  // Show empty state if there's a link nesting issue (layer mode only)
  if (!isStandaloneMode && linkNestingIssue) {
    return (
      <SettingsPanel
        title="Link"
        isOpen={isOpen}
        onToggle={() => setIsOpen(!isOpen)}
      >
        <Empty>
          <EmptyDescription>
            {linkNestingIssue.type === 'richText'
              ? 'Cannot add a link to a layer that contains rich text links. Remove the rich text links first.'
              : linkNestingIssue.type === 'ancestor'
                ? `Links cannot be nested. This layer is inside a "${linkNestingIssue.layerName}" layer that already has a link.`
                : 'Links cannot be nested. This layer contains child layers with links.'}
          </EmptyDescription>
        </Empty>
      </SettingsPanel>
    );
  }

  // Standalone mode content (without SettingsPanel wrapper)
  const linkTypeContent = (
    <div className={useStackedLayout ? '' : 'grid grid-cols-3 items-center gap-2'}>
      {!isStandaloneMode && (
        <div className="flex items-start gap-1 py-1">
          <ComponentVariableLabel
            label="Link To"
            isEditingComponent={!!editingComponentId}
            variables={linkComponentVariables}
            linkedVariableId={linkedLinkVariableId}
            onLinkVariable={handleLinkLinkVariable}
            onManageVariables={() => onOpenVariablesDialog?.()}
            onCreateVariable={editingComponentId ? async () => {
              const newId = await addLinkVariable(editingComponentId, 'Link');
              if (newId) {
                const currentValue: LinkSettingsValue = { type: 'url', ...linkSettings };
                await updateTextVariable(editingComponentId, newId, { default_value: currentValue });
                handleLinkLinkVariable(newId);
                onOpenVariablesDialog?.(newId);
              }
            } : undefined}
          />
        </div>
      )}
      {isStandaloneMode && !useStackedLayout && typeLabel && (
        <Label variant="muted">{typeLabel}</Label>
      )}
      <div className={useStackedLayout ? '*:w-full' : 'col-span-2 *:w-full'}>
        {linkedLinkVariable ? (
          <Button
            asChild
            variant="purple"
            className="justify-between! w-full"
            onClick={() => onOpenVariablesDialog?.(linkedLinkVariable.id)}
          >
            <div>
              <span className="flex items-center gap-1.5">
                {linkedLinkVariable.type && VARIABLE_TYPE_ICONS[linkedLinkVariable.type] && (
                  <Icon name={VARIABLE_TYPE_ICONS[linkedLinkVariable.type]} className="size-3 opacity-60" />
                )}
                {linkedLinkVariable.name}
              </span>
              <Button
                className="size-4! p-0!"
                variant="outline"
                onClick={(e) => { e.stopPropagation(); handleUnlinkLinkVariable(); }}
              >
                <Icon name="x" className="size-2" />
              </Button>
            </div>
          </Button>
        ) : (
          <Select
            value={linkType}
            onValueChange={(value) => handleLinkTypeChange(value as LinkType | 'none')}
            disabled={isLockedByOther}
          >
            <SelectTrigger
              onClear={linkType !== 'none'
                ? () => handleLinkTypeChange('none')
                : undefined}
            >
              <SelectValue placeholder="No link" />
            </SelectTrigger>
            <SelectContent>
              {linkTypeOptions.map((option, index) => {
                if ('type' in option && option.type === 'separator') {
                  return <SelectSeparator key={`separator-${index}`} />;
                }
                if ('value' in option) {
                  return (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled || isLockedByOther}
                    >
                      <div className="flex items-center gap-2">
                        <Icon name={option.icon as any} className="size-3" />
                        {option.label}
                      </div>
                    </SelectItem>
                  );
                }
                return null;
              })}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );

  // Type-specific inputs content
  const typeSpecificContent = (
    <>
      {/* URL Input */}
      {linkType === 'url' && (
        <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 items-center gap-2'}>
          {!useStackedLayout && <Label variant="muted">URL</Label>}
          {useStackedLayout && <Label variant="muted" className="mb-1.5">URL</Label>}
          <div className={useStackedLayout ? '' : 'col-span-2'}>
            <RichTextEditor
              value={urlValue}
              onChange={handleUrlChange}
              placeholder="https://example.com"
              fieldGroups={fieldGroups}
              allFields={allFields}
              collections={collections}
              disabled={isLockedByOther}
              disableLinks
            />
          </div>
        </div>
      )}

      {/* Email Input */}
      {linkType === 'email' && (
        <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 items-center gap-2'}>
          {!useStackedLayout && <Label variant="muted">Email</Label>}
          {useStackedLayout && <Label variant="muted" className="mb-1.5">Email</Label>}
          <div className={useStackedLayout ? '' : 'col-span-2'}>
            <RichTextEditor
              value={emailValue}
              onChange={handleEmailChange}
              placeholder="email@example.com"
              fieldGroups={fieldGroups}
              allFields={allFields}
              collections={collections}
              disabled={isLockedByOther}
              disableLinks
            />
          </div>
        </div>
      )}

      {/* Phone Input */}
      {linkType === 'phone' && (
        <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 items-center gap-2'}>
          {!useStackedLayout && <Label variant="muted">Phone</Label>}
          {useStackedLayout && <Label variant="muted" className="mb-1.5">Phone</Label>}
          <div className={useStackedLayout ? '' : 'col-span-2'}>
            <RichTextEditor
              value={phoneValue}
              onChange={handlePhoneChange}
              placeholder="+1234567890"
              fieldGroups={fieldGroups}
              allFields={allFields}
              collections={collections}
              disabled={isLockedByOther}
              disableLinks
            />
          </div>
        </div>
      )}

      {/* Asset Selection */}
      {linkType === 'asset' && (
        <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 items-center gap-2'}>
          {!useStackedLayout && <Label variant="muted">Asset</Label>}
          {useStackedLayout && <Label variant="muted" className="mb-1.5">Asset</Label>}
          <div className={useStackedLayout ? '' : 'col-span-2'}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleAssetSelect}
              disabled={isLockedByOther}
              className="w-full justify-start"
            >
              <Icon name={(selectedAsset ? getAssetIcon(selectedAsset.mime_type) : 'paperclip') as IconProps['name']} className="size-3 mr-0.5" />
              {selectedAsset ? selectedAsset.filename : 'Select asset...'}
            </Button>
          </div>
        </div>
      )}

      {/* Page Selection */}
      {linkType === 'page' && (
        <>
          <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 items-center gap-2'}>
            {!useStackedLayout && <Label variant="muted">Page</Label>}
            {useStackedLayout && <Label variant="muted" className="mb-1.5">Page</Label>}
            <div className={useStackedLayout ? '' : 'col-span-2'}>
              <PageSelector
                value={pageId}
                onValueChange={handlePageChange}
                disabled={isLockedByOther}
                popoverClassName={isStandaloneMode ? 'min-w-[var(--radix-popover-trigger-width)]' : undefined}
              />
            </div>
          </div>

          {/* Collection Item Selection (for dynamic pages) */}
          {isDynamicPage && pageId && (
            <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 items-center gap-2'}>
              {!useStackedLayout && <Label variant="muted">CMS item</Label>}
              {useStackedLayout && <Label variant="muted" className="mb-1.5">CMS item</Label>}
              <div className={useStackedLayout ? '' : 'col-span-2'}>
                <LinkCollectionItemPicker
                  collectionId={collectionPickerId}
                  value={collectionItemId}
                  onChange={handleCollectionItemChange}
                  canUseCurrentPageItem={canUseCurrentPageItem}
                  canUseCurrentCollectionItem={canUseCurrentCollectionItem}
                  canUseNextPreviousItem={canUseNextPreviousItem}
                  referenceItemOptions={referenceItemOptions}
                  disabled={isLockedByOther}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Field Selection */}
      {linkType === 'field' && (
        <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 items-center gap-2'}>
          {!useStackedLayout && <Label variant="muted">Field</Label>}
          {useStackedLayout && <Label variant="muted" className="mb-1.5">Field</Label>}
          <div className={useStackedLayout ? '' : 'col-span-2'}>
            <FieldSelectDropdown
              fieldGroups={linkFieldGroups}
              allFields={allFields || {}}
              collections={collections || []}
              value={fieldId}
              onSelect={handleFieldChange}
              placeholder="Select..."
              disabled={isLockedByOther}
              allowedFieldTypes={LINK_FIELD_TYPES}
            />
          </div>
        </div>
      )}
    </>
  );

  // Anchor content - only show when there are layers with IDs or an anchor is already set
  const anchorContent = linkType !== 'none' && (linkType === 'page' || (linkType === 'url' && !hideBehavior)) && (anchorLayers.length > 0 || anchorLayerId) && (
    <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 items-center gap-2'}>
      {!isStandaloneMode && (
        <Label variant="muted">Anchor</Label>
      )}
      {isStandaloneMode && !useStackedLayout && <Label variant="muted">Anchor</Label>}
      {useStackedLayout && <Label variant="muted" className="mb-1.5">Anchor</Label>}

      <div className={useStackedLayout ? '*:w-full' : 'col-span-2 *:w-full'}>
        <Select
          value={anchorLayerId || ''}
          onValueChange={handleAnchorLayerIdChange}
          disabled={isLockedByOther}
        >
          <SelectTrigger
            onClear={anchorLayerId
              ? () => handleAnchorLayerIdChange('none')
              : undefined}
          >
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {anchorLayers.map(({ layer: anchorLayer, id }) => (
              <SelectItem key={id} value={id}>
                #{id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  // Behavior options content (target, download, nofollow)
  const behaviorContent = linkType !== 'none' && (
    <>
      {/* Link Behavior (when link is set) */}
      <div className={useStackedLayout ? 'mt-2.5' : 'grid grid-cols-3 gap-2 py-1'}>
        {!useStackedLayout && (
          <div>
            <Label variant="muted">Behavior</Label>
          </div>
        )}
        {useStackedLayout && <Label variant="muted" className="mb-1.5">Behavior</Label>}
        <div className={`${useStackedLayout ? '' : 'col-span-2'} flex flex-col gap-2`}>
          <div className="flex items-center gap-2">
            <Checkbox
              id="newTab"
              checked={target === '_blank'}
              onCheckedChange={handleTargetChange}
              disabled={isLockedByOther}
            />
            <Label
              variant="muted"
              htmlFor="newTab"
              className="cursor-pointer"
            >
              Open in new tab
            </Label>
          </div>
          {linkType === 'asset' && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="download"
                checked={download}
                onCheckedChange={handleDownloadChange}
                disabled={isLockedByOther}
              />
              <Label
                variant="muted"
                htmlFor="download"
                className="cursor-pointer"
              >
                Force download
              </Label>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="nofollow"
              checked={rel?.includes('nofollow') || false}
              onCheckedChange={handleNofollowChange}
              disabled={isLockedByOther}
            />
            <Label
              variant="muted"
              htmlFor="nofollow"
              className="cursor-pointer"
            >
              No follow
            </Label>
          </div>
        </div>
      </div>
    </>
  );

  // Standalone mode: render without SettingsPanel wrapper
  if (isStandaloneMode) {
    return (
      <div className="flex flex-col">
        {linkTypeContent}
        {typeSpecificContent}
        {anchorContent}
        {!hideBehavior && behaviorContent}
      </div>
    );
  }

  // Layer mode: render with SettingsPanel wrapper
  return (
    <SettingsPanel
      title="Link"
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
    >
      <div className="flex flex-col gap-3">
        {linkTypeContent}
        {!linkedLinkVariable && typeSpecificContent}
        {!linkedLinkVariable && anchorContent}
        {!linkedLinkVariable && behaviorContent}
      </div>
    </SettingsPanel>
  );
}
