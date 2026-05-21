'use client';

/**
 * Rich Text Link Settings Component
 *
 * Settings panel for rich text links in TipTap editors.
 * Supports all link types: URL, email, phone, asset, page, field.
 * Extracted from LinkSettings to work with LinkSettings object directly.
 */

import React, { useCallback, useMemo } from 'react';

import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import Icon, { type IconProps } from '@/components/ui/icon';
import RichTextEditor from './RichTextEditor';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldSelectDropdown, type FieldSourceType } from './CollectionFieldSelector';
import type { Layer, CollectionField, Collection, LinkSettings, LinkType } from '@/types';
import {
  createDynamicTextVariable,
  getDynamicTextContent,
} from '@/lib/variable-utils';
import { usePagesStore } from '@/stores/usePagesStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { getAssetIcon } from '@/lib/asset-utils';
import { getCollectionVariable, findLayersWithAnchorId } from '@/lib/layer-utils';
import { getLayerIcon, getLayerName } from '@/lib/layer-display-utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import PageSelector from './PageSelector';
import { filterFieldGroupsByType, flattenFieldGroups, LINK_FIELD_TYPES, buildReferenceItemOptions, type FieldGroup } from '@/lib/collection-field-utils';
import LinkCollectionItemPicker from './LinkCollectionItemPicker';

export interface RichTextLinkSettingsProps {
  /** Current link settings */
  value: LinkSettings | null;
  /** Callback when link settings change */
  onChange: (settings: LinkSettings | null) => void;
  /** Field groups with labels and sources for inline variable selection */
  fieldGroups?: FieldGroup[];
  /** All fields by collection ID */
  allFields?: Record<string, CollectionField[]>;
  /** Available collections */
  collections?: Collection[];
  /** Whether this is inside a collection layer */
  isInsideCollectionLayer?: boolean;
  /** Current layer (for context - collection layer detection) */
  layer?: Layer | null;
  /** Link types to exclude from the dropdown */
  excludedLinkTypes?: LinkType[];
  /** Hide "Current page item" and "Reference field" options (e.g. when editing CMS item content) */
  hidePageContextOptions?: boolean;
}

/**
 * Rich text link settings UI for TipTap editors
 */
export default function RichTextLinkSettings({
  value,
  onChange,
  fieldGroups,
  allFields,
  collections,
  isInsideCollectionLayer = false,
  layer,
  excludedLinkTypes = [],
  hidePageContextOptions = false,
}: RichTextLinkSettingsProps) {
  // Stores
  const pages = usePagesStore((state) => state.pages);
  const draftsByPageId = usePagesStore((state) => state.draftsByPageId);
  const currentPageId = useEditorStore((state) => state.currentPageId);
  const openFileManager = useEditorStore((state) => state.openFileManager);
  const getAsset = useAssetsStore((state) => state.getAsset);

  // Get current link settings
  const linkSettings = value;
  const linkType = linkSettings?.type || 'none';

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

  // "Current page item" only makes sense when both pages use the same collection,
  // and is never relevant when editing CMS item content directly
  const currentPageCollectionId = currentPage?.settings?.cms?.collection_id || null;
  const targetPageCollectionId = selectedPage?.settings?.cms?.collection_id || null;
  const canUseCurrentPageItem = !hidePageContextOptions && isDynamicPage && isCurrentPageDynamic
    && !!currentPageCollectionId && currentPageCollectionId === targetPageCollectionId;

  // Next/previous navigation only makes sense when the link points back at the
  // same dynamic page the user is editing.
  const canUseNextPreviousItem = !hidePageContextOptions && isDynamicPage && isCurrentPageDynamic
    && !!pageId && pageId === currentPageId;

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

  // Check if we have collection fields available
  const collectionGroup = fieldGroups?.find(g => g.source === 'collection');
  const hasCollectionFields = !!(collectionGroup && collectionGroup.fields.length > 0 && isInsideCollectionLayer);
  const canUseCurrentCollectionItem = hasCollectionFields || isCollectionLayer;

  // Find reference fields that point to the target page's collection.
  // Hidden when editing CMS item content directly (no page context).
  const referenceItemOptions = useMemo(
    () => hidePageContextOptions ? [] : buildReferenceItemOptions(isDynamicPage, targetPageCollectionId, fieldGroups),
    [hidePageContextOptions, isDynamicPage, targetPageCollectionId, fieldGroups]
  );

  // Get collection ID from dynamic page settings
  const pageCollectionId = selectedPage?.settings?.cms?.collection_id || null;

  const collectionPickerId = isDynamicPage ? pageCollectionId : null;

  // Link type options for the dropdown
  const linkTypeOptions = useMemo<
    Array<
      | { value: LinkType | 'none'; label: string; icon: string; disabled?: boolean }
      | { type: 'separator' }
    >
  >(() => {
    const allOptions = [
      { value: 'page', label: 'Page', icon: 'page' },
      { value: 'asset', label: 'Asset', icon: 'paperclip' },
      { value: 'field', label: 'CMS field', icon: 'database', disabled: linkFieldGroups.length === 0 },
      { type: 'separator' },
      { value: 'url', label: 'URL', icon: 'link' },
      { value: 'email', label: 'Email', icon: 'email' },
      { value: 'phone', label: 'Phone', icon: 'phone' },
    ] as Array<
      | { value: LinkType | 'none'; label: string; icon: string; disabled?: boolean }
      | { type: 'separator' }
    >;

    // Filter out excluded link types
    return allOptions.filter((option) => {
      if ('type' in option && option.type === 'separator') return true;
      if ('value' in option && excludedLinkTypes.includes(option.value as LinkType)) return false;
      return true;
    });
  }, [linkFieldGroups, excludedLinkTypes]);

  // Handle link type change
  const handleLinkTypeChange = useCallback(
    (newType: LinkType | 'none') => {
      if (newType === 'none') {
        onChange(null);
        return;
      }

      // Create new link settings with the new type
      const newSettings: LinkSettings = {
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

      onChange(newSettings);
    },
    [onChange]
  );

  // Handle URL change
  const handleUrlChange = useCallback(
    (newValue: string) => {
      if (!linkSettings) return;

      onChange({
        ...linkSettings,
        url: createDynamicTextVariable(newValue),
      });
    },
    [linkSettings, onChange]
  );

  // Handle email change
  const handleEmailChange = useCallback(
    (newValue: string) => {
      if (!linkSettings) return;

      onChange({
        ...linkSettings,
        email: createDynamicTextVariable(newValue),
      });
    },
    [linkSettings, onChange]
  );

  // Handle phone change
  const handlePhoneChange = useCallback(
    (newValue: string) => {
      if (!linkSettings) return;

      onChange({
        ...linkSettings,
        phone: createDynamicTextVariable(newValue),
      });
    },
    [linkSettings, onChange]
  );

  // Handle asset selection
  const handleAssetSelect = useCallback(() => {
    if (!linkSettings) return;

    openFileManager(
      (asset) => {
        onChange({
          ...linkSettings,
          asset: { id: asset.id },
        });
      },
      assetId || undefined,
      undefined
    );
  }, [linkSettings, assetId, openFileManager, onChange]);

  // Handle page selection
  const handlePageChange = useCallback(
    (newPageId: string) => {
      if (!linkSettings) return;

      onChange({
        ...linkSettings,
        page: {
          id: newPageId,
          collection_item_id: null,
        },
        anchor_layer_id: null,
      });
    },
    [linkSettings, onChange]
  );

  // Handle collection item selection. The selection value (concrete id or
  // dynamic-resolution keyword like `current-page` / `next-item`) is stored
  // verbatim and resolved at render time by `generateLinkHref`.
  const handleCollectionItemChange = useCallback(
    (itemId: string) => {
      if (!linkSettings) return;

      onChange({
        ...linkSettings,
        page: {
          ...linkSettings.page!,
          collection_item_id: itemId,
        },
      });
    },
    [linkSettings, onChange]
  );

  // Handle field selection
  const handleFieldChange = useCallback(
    (
      selectedFieldId: string,
      relationshipPath: string[],
      source?: FieldSourceType,
      layerId?: string
    ) => {
      if (!linkSettings) return;

      // Find the field type
      const field = linkFields.find(f => f.id === selectedFieldId);
      const fieldType = field?.type;

      onChange({
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
    [linkSettings, onChange, linkFields]
  );

  // Handle anchor layer ID change
  const handleAnchorLayerIdChange = useCallback(
    (newValue: string) => {
      if (!linkSettings) return;

      onChange({
        ...linkSettings,
        anchor_layer_id: newValue === 'none' ? null : newValue,
      });
    },
    [linkSettings, onChange]
  );

  // Handle target change
  const handleTargetChange = useCallback(
    (checked: boolean) => {
      if (!linkSettings) return;

      const newTarget = checked ? '_blank' : '_self';
      const newRel = checked ? 'noopener noreferrer' : '';

      onChange({
        ...linkSettings,
        target: newTarget,
        rel: newRel,
      });
    },
    [linkSettings, onChange]
  );

  // Handle download change
  const handleDownloadChange = useCallback(
    (checked: boolean) => {
      if (!linkSettings) return;

      onChange({
        ...linkSettings,
        download: checked,
      });
    },
    [linkSettings, onChange]
  );

  // Handle nofollow change
  const handleNofollowChange = useCallback(
    (checked: boolean) => {
      if (!linkSettings) return;

      const currentRel = rel || '';
      const hasNofollow = currentRel.includes('nofollow');
      let newRel = currentRel;

      if (checked && !hasNofollow) {
        newRel = currentRel ? `${currentRel} nofollow` : 'nofollow';
      } else if (!checked && hasNofollow) {
        newRel = currentRel.replace(/\s*nofollow\s*/g, ' ').trim();
      }

      onChange({
        ...linkSettings,
        rel: newRel,
      });
    },
    [linkSettings, rel, onChange]
  );

  // Get asset info for display
  const selectedAsset = assetId ? getAsset(assetId) : null;

  return (
    <div className="flex flex-col gap-3">
      {/* Link Type */}
      <div className="grid grid-cols-3 items-center gap-2">
        <Label className="text-xs text-muted-foreground">Link To</Label>
        <div className="col-span-2 *:w-full">
          <Select
            value={linkType === 'none' ? '' : linkType}
            onValueChange={(newVal) => handleLinkTypeChange(newVal as LinkType | 'none')}
          >
            <SelectTrigger
              onClear={linkType !== 'none'
                ? () => handleLinkTypeChange('none')
                : undefined}
            >
              <SelectValue placeholder="Page or URL..." />
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
                      disabled={option.disabled}
                    >
                      <div className="flex items-center gap-2">
                        <Icon name={option.icon as IconProps['name']} className="size-3" />
                        {option.label}
                      </div>
                    </SelectItem>
                  );
                }
                return null;
              })}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* URL Input */}
      {linkType === 'url' && (
        <div className="grid grid-cols-3 items-center gap-2">
          <Label className="text-xs text-muted-foreground">URL</Label>
          <div className="col-span-2">
            <RichTextEditor
              value={urlValue}
              onChange={handleUrlChange}
              placeholder="https://example.com"
              fieldGroups={fieldGroups}
              allFields={allFields}
              collections={collections}
              disableLinks
            />
          </div>
        </div>
      )}

      {/* Email Input */}
      {linkType === 'email' && (
        <div className="grid grid-cols-3 items-center gap-2">
          <Label className="text-xs text-muted-foreground">Email</Label>
          <div className="col-span-2">
            <RichTextEditor
              value={emailValue}
              onChange={handleEmailChange}
              placeholder="email@example.com"
              fieldGroups={fieldGroups}
              allFields={allFields}
              collections={collections}
              disableLinks
            />
          </div>
        </div>
      )}

      {/* Phone Input */}
      {linkType === 'phone' && (
        <div className="grid grid-cols-3 items-center gap-2">
          <Label className="text-xs text-muted-foreground">Phone</Label>
          <div className="col-span-2">
            <RichTextEditor
              value={phoneValue}
              onChange={handlePhoneChange}
              placeholder="+1234567890"
              fieldGroups={fieldGroups}
              allFields={allFields}
              collections={collections}
              disableLinks
            />
          </div>
        </div>
      )}

      {/* Asset Selection */}
      {linkType === 'asset' && (
        <div className="grid grid-cols-3 items-center gap-2">
          <Label className="text-xs text-muted-foreground">Asset</Label>
          <div className="col-span-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleAssetSelect}
              className="w-full justify-start"
            >
              <Icon
                name={(selectedAsset ? getAssetIcon(selectedAsset.mime_type) : 'paperclip') as IconProps['name']}
                className="size-3 mr-0.5"
              />
              {selectedAsset ? selectedAsset.filename : 'Select asset...'}
            </Button>
          </div>
        </div>
      )}

      {/* Page Selection */}
      {linkType === 'page' && (
        <>
          <div className="grid grid-cols-3 items-center gap-2">
            <Label className="text-xs text-muted-foreground">Page</Label>
            <div className="col-span-2">
              <PageSelector
                value={pageId}
                onValueChange={handlePageChange}
              />
            </div>
          </div>

          {/* Collection Item Selection (for dynamic pages) */}
          {isDynamicPage && pageId && (
            <div className="grid grid-cols-3 items-center gap-2">
              <Label className="text-xs text-muted-foreground">CMS item</Label>
              <div className="col-span-2">
                <LinkCollectionItemPicker
                  collectionId={collectionPickerId}
                  value={collectionItemId}
                  onChange={handleCollectionItemChange}
                  canUseCurrentPageItem={canUseCurrentPageItem}
                  canUseCurrentCollectionItem={canUseCurrentCollectionItem}
                  canUseNextPreviousItem={canUseNextPreviousItem}
                  referenceItemOptions={referenceItemOptions}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Field Selection */}
      {linkType === 'field' && (
        <div className="grid grid-cols-3 items-center gap-2">
          <Label className="text-xs text-muted-foreground">Field</Label>
          <div className="col-span-2">
            <FieldSelectDropdown
              fieldGroups={linkFieldGroups}
              allFields={allFields || {}}
              collections={collections || []}
              value={fieldId}
              onSelect={handleFieldChange}
              placeholder="Select..."
              allowedFieldTypes={LINK_FIELD_TYPES}
            />
          </div>
        </div>
      )}

      {/* Anchor (for page and URL types) */}
      {(linkType === 'page' || linkType === 'url') && (
        <div className="grid grid-cols-3 items-center gap-2">
          <div className="flex items-center gap-1">
            <Label className="text-xs text-muted-foreground">Anchor</Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Icon name="info" className="size-3 text-foreground/80" />
              </TooltipTrigger>
              <TooltipContent>Layers with ID attributes are used as anchors</TooltipContent>
            </Tooltip>
          </div>

          <div className="col-span-2">
            <Select
              value={anchorLayerId || 'none'}
              onValueChange={handleAnchorLayerIdChange}
              disabled={false}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  <div className="flex items-center gap-2">
                    <Icon name="none" className="size-3" />
                    <span>No anchor</span>
                  </div>
                </SelectItem>
                {anchorLayers.map(({ layer: anchorLayer, id }) => (
                  <SelectItem key={id} value={id}>
                    <div className="flex items-center gap-2">
                      <Icon name={getLayerIcon(anchorLayer)} className="size-3" />
                      <span>{getLayerName(anchorLayer)}</span>
                      <span className="text-xs text-muted-foreground">#{id}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Link Behavior (when link is set) */}
      {linkType !== 'none' && (
        <div className="grid grid-cols-3 gap-2 py-1">
          <div>
            <Label variant="muted">Behavior</Label>
          </div>
          <div className="col-span-2 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="richtext-newTab"
                checked={target === '_blank'}
                onCheckedChange={handleTargetChange}
              />
              <Label
                variant="muted"
                htmlFor="richtext-newTab"
                className="cursor-pointer"
              >
                Open in new tab
              </Label>
            </div>
            {linkType === 'asset' && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="richtext-download"
                  checked={download}
                  onCheckedChange={handleDownloadChange}
                />
                <Label
                  variant="muted"
                  htmlFor="richtext-download"
                  className="cursor-pointer"
                >
                  Force download
                </Label>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="richtext-nofollow"
                checked={rel?.includes('nofollow') || false}
                onCheckedChange={handleNofollowChange}
              />
              <Label
                variant="muted"
                htmlFor="richtext-nofollow"
                className="cursor-pointer"
              >
                No follow
              </Label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
