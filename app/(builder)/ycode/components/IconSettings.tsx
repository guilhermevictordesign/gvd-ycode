'use client';

/**
 * Icon Settings Component
 *
 * Settings panel for icon layers with icon library selection
 */

import React, { useState, useCallback, useMemo } from 'react';

import { Label } from '@/components/ui/label';
import SettingsPanel from './SettingsPanel';
import type { Layer, IconSettingsValue } from '@/types';
import { createAssetVariable, isAssetVariable, getAssetId, isStaticTextVariable, getStaticTextContent } from '@/lib/variable-utils';
import { DEFAULT_ASSETS, getSvgIntrinsicSize, isAssetOfType, ASSET_CATEGORIES } from '@/lib/asset-utils';
import { useDesignSync } from '@/hooks/use-design-sync';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '@/stores/useEditorStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { toast } from 'sonner';
import Icon from '@/components/ui/icon';
import ComponentVariableLabel, { VARIABLE_TYPE_ICONS } from './ComponentVariableLabel';

// Re-export IconSettingsValue from types for convenience
export type { IconSettingsValue } from '@/types';

// Layer mode props - for editing icon layers
interface LayerModeProps {
  mode?: 'layer';
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  value?: never;
  onChange?: never;
}

// Standalone mode props - for component variable overrides
interface StandaloneModeProps {
  mode: 'standalone';
  value: IconSettingsValue | undefined;
  onChange: (value: IconSettingsValue) => void;
  layer?: never;
  onLayerUpdate?: never;
}

interface CommonProps {
  onOpenVariablesDialog?: (variableId?: string) => void;
}

type IconSettingsProps = (LayerModeProps | StandaloneModeProps) & CommonProps;

export default function IconSettings(props: IconSettingsProps) {
  const { onOpenVariablesDialog } = props;
  const isStandaloneMode = props.mode === 'standalone';

  // Layer mode props
  const layer = isStandaloneMode ? null : props.layer;
  const onLayerUpdate = isStandaloneMode ? undefined : props.onLayerUpdate;

  // Standalone mode props
  const standaloneValue = isStandaloneMode ? props.value : undefined;
  const standaloneOnChange = isStandaloneMode ? props.onChange : undefined;
  const [isOpen, setIsOpen] = useState(true);

  // Pinned to desktop/neutral so adopting an icon's size updates the base
  // dimensions (matching how the default icon element sets w-/h- at base).
  const { updateDesignProperties } = useDesignSync({
    layer,
    onLayerUpdate: onLayerUpdate ?? (() => {}),
    activeBreakpoint: 'desktop',
    activeUIState: 'neutral',
  });

  const openFileManager = useEditorStore((state) => state.openFileManager);
  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const getAsset = useAssetsStore((state) => state.getAsset);
  const getComponentById = useComponentsStore((state) => state.getComponentById);
  const addIconVariable = useComponentsStore((state) => state.addIconVariable);
  const updateTextVariable = useComponentsStore((state) => state.updateTextVariable);

  // Get component variables for icon linking (when editing a component in layer mode)
  const editingComponent = !isStandaloneMode && editingComponentId ? getComponentById(editingComponentId) : undefined;
  const componentVariables = editingComponent?.variables || [];
  const iconComponentVariables = componentVariables.filter(v => v.type === 'icon');

  // Get icon source variable - from layer or standalone value
  const iconSrc = isStandaloneMode ? standaloneValue?.src : layer?.variables?.icon?.src;

  // Get linked icon variable ID from layer (stored in src.id)
  const linkedIconVariableId = !isStandaloneMode && iconSrc ? (iconSrc as any).id : undefined;
  const linkedIconVariable = iconComponentVariables.find(v => v.id === linkedIconVariableId);

  // Icons only support AssetVariable in the UI (StaticTextVariable is for internal use only)
  // If we have a StaticTextVariable, treat it as if no source is set (user can't edit it)

  const handleAssetSelect = useCallback((assetId: string) => {
    const assetVariable = createAssetVariable(assetId);

    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ src: assetVariable });
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        icon: { src: assetVariable },
      },
    });

    // Adopt the selected icon's intrinsic size so it reflects the new icon's
    // real dimensions rather than inheriting the previous icon's box (e.g. the
    // default 24×24 element size). Sends design + classes in a separate update
    // that doesn't touch the variables set above.
    const selectedAsset = getAsset(assetId);
    const intrinsicSize = getSvgIntrinsicSize(selectedAsset?.content);
    if (intrinsicSize) {
      updateDesignProperties([
        { category: 'sizing', property: 'width', value: `${intrinsicSize.width}px` },
        { category: 'sizing', property: 'height', value: `${intrinsicSize.height}px` },
      ]);
    }
  }, [isStandaloneMode, standaloneOnChange, layer, onLayerUpdate, getAsset, updateDesignProperties]);

  const handleBrowseAsset = useCallback(() => {
    const currentAssetId = (() => {
      if (isAssetVariable(iconSrc)) {
        return getAssetId(iconSrc);
      }
      return null;
    })();

    openFileManager(
      (asset) => {
        if (!isStandaloneMode && !layer) return false;

        if (!asset.mime_type || !isAssetOfType(asset.mime_type, ASSET_CATEGORIES.ICONS)) {
          toast.error('Invalid asset type', {
            description: 'Please select an SVG file.',
          });
          return false;
        }

        handleAssetSelect(asset.id);
      },
      currentAssetId,
      ASSET_CATEGORIES.ICONS
    );
  }, [openFileManager, handleAssetSelect, isStandaloneMode, layer, iconSrc]);

  const handleLinkIconVariable = useCallback((variableId: string) => {
    if (!layer || !onLayerUpdate) return;

    const currentSrc = layer.variables?.icon?.src;

    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        icon: {
          ...layer.variables?.icon,
          src: currentSrc
            ? { ...currentSrc, id: variableId } as any
            : { type: 'asset', id: variableId, data: { asset_id: null } } as any,
        },
      },
    });
  }, [layer, onLayerUpdate]);

  const handleUnlinkIconVariable = useCallback(() => {
    if (!layer || !onLayerUpdate) return;

    const currentSrc = layer.variables?.icon?.src;

    if (currentSrc) {
      const { id: _, ...srcWithoutId } = currentSrc as any;

      onLayerUpdate(layer.id, {
        variables: {
          ...layer.variables,
          icon: {
            ...layer.variables?.icon,
            src: srcWithoutId,
          },
        },
      });
    }
  }, [layer, onLayerUpdate]);

  // In layer mode, only show for icon layers
  if (!isStandaloneMode && (!layer || layer.name !== 'icon')) {
    return null;
  }

  // Get current icon source (always SVG code string) for preview
  const currentIconSource = (() => {
    let iconContent = '';

    if (iconSrc) {
      if (isStaticTextVariable(iconSrc)) {
        iconContent = getStaticTextContent(iconSrc);
      } else if (isAssetVariable(iconSrc)) {
        const assetId = getAssetId(iconSrc);
        const asset = assetId ? getAsset(assetId) : null;
        iconContent = asset?.content || '';
      }
    }

    return iconContent && iconContent.trim() !== '' ? iconContent : DEFAULT_ASSETS.ICON;
  })();

  // Get current asset ID and asset for display
  const currentAssetId = (() => {
    if (isAssetVariable(iconSrc)) {
      return getAssetId(iconSrc);
    }
    return null;
  })();

  const currentAsset = currentAssetId ? getAsset(currentAssetId) : null;
  const assetFilename = currentAsset?.filename || null;

  // Icon file picker content (shared between modes)
  const iconPickerContent = (
    <div
      className="relative group bg-secondary/30 hover:bg-secondary/60 rounded-md w-full aspect-3/2 overflow-hidden cursor-pointer"
      onClick={handleBrowseAsset}
    >
      <div className="absolute inset-0 opacity-10 bg-checkerboard" />
      <div className="relative w-full h-full flex items-center justify-center p-4 z-10">
        {currentIconSource ? (
          <div
            data-icon="true"
            className="w-full h-full flex items-center justify-center"
            dangerouslySetInnerHTML={{ __html: currentIconSource }}
          />
        ) : (
          <Icon name="icon" className="size-4 text-muted-foreground" />
        )}
      </div>

      <div className="absolute inset-0 bg-black/50 text-white text-xs flex flex-col gap-3 items-center justify-center px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
        <Button variant="overlay" size="sm">{assetFilename ? 'Change file' : 'Choose file'}</Button>
        {assetFilename && <div className="max-w-full truncate text-center">{assetFilename}</div>}
      </div>
    </div>
  );

  // Standalone mode - just icon picker
  if (isStandaloneMode) {
    return iconPickerContent;
  }

  return (
    <SettingsPanel
      title="Icon"
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 items-start">
          <div className="flex items-start gap-1 py-1">
            <ComponentVariableLabel
              label="File"
              isEditingComponent={!!editingComponentId}
              variables={iconComponentVariables}
              linkedVariableId={linkedIconVariableId}
              onLinkVariable={handleLinkIconVariable}
              onManageVariables={() => onOpenVariablesDialog?.()}
              onCreateVariable={editingComponentId ? async () => {
                const newId = await addIconVariable(editingComponentId, 'Icon');
                if (newId) {
                  const currentValue: IconSettingsValue = {
                    src: layer?.variables?.icon?.src,
                  };
                  await updateTextVariable(editingComponentId, newId, { default_value: currentValue });
                  handleLinkIconVariable(newId);
                  onOpenVariablesDialog?.(newId);
                }
              } : undefined}
              className="pt-1"
            />
          </div>
          <div className="col-span-2">
            {linkedIconVariable ? (
              <Button
                asChild
                variant="purple"
                className="justify-between! w-full"
                onClick={() => onOpenVariablesDialog?.(linkedIconVariable.id)}
              >
                <div>
                  <span className="flex items-center gap-1.5">
                    {linkedIconVariable.type && VARIABLE_TYPE_ICONS[linkedIconVariable.type] && (
                      <Icon name={VARIABLE_TYPE_ICONS[linkedIconVariable.type]} className="size-3 opacity-60" />
                    )}
                    {linkedIconVariable.name}
                  </span>
                  <Button
                    className="size-4! p-0!"
                    variant="outline"
                    onClick={(e) => { e.stopPropagation(); handleUnlinkIconVariable(); }}
                  >
                    <Icon name="x" className="size-2" />
                  </Button>
                </div>
              </Button>
            ) : (
              iconPickerContent
            )}
          </div>
        </div>
      </div>
    </SettingsPanel>
  );
}
