'use client';

/**
 * Layer Styles Panel
 *
 * UI for managing layer styles in the Right Sidebar.
 *
 * Layers carry an ordered stack of styles (`styleIds`, low -> high priority),
 * mirroring Webflow combo classes. The stack is shown as a row of chips; one
 * chip is "active" and is the target for New/Update/Detach/Reset/Rename/Delete.
 * A checkbox dropdown toggles which styles are in the stack (adding appends at
 * the end = highest priority), and chips can be dragged to reorder.
 *
 * Rich-text inline styles (text-style mode) keep the original single-select
 * behavior.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyTitle } from '@/components/ui/empty';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useLayerStylesStore } from '@/stores/useLayerStylesStore';
import { useLiveLayerStyleUpdates } from '@/hooks/use-live-layer-style-updates';
import {
  applyStyleToLayer,
  detachStyleFromLayer,
  getStyleIds,
} from '@/lib/layer-style-utils';
import { resolveLayerClasses, resolveLayerDesign, chipClasses, mergeClassStack } from '@/lib/layer-style-resolve';
import { buildDesign } from '@/lib/import/design';
import { detachStyleAcrossStores, updateStyleAcrossStores } from '@/lib/layer-style-store-utils';
import { getStyleGroup, getTextStyleGroup, isStyleGroupCompatible } from '@/lib/layer-style-groups';
import { DEFAULT_TEXT_STYLES } from '@/lib/text-format-utils';
import type { Layer, LayerStyle, TextStyle } from '@/types';

interface LayerStylesPanelProps {
  layer: Layer | null;
  pageId: string | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  activeTextStyleKey?: string | null;
  /**
   * Controlled active-chip selection (the style the design panel edits). When
   * provided, the parent owns it so the Classes/property panels stay in sync.
   * Falls back to internal state when omitted.
   */
  activeStyleId?: string | null;
  onActiveStyleChange?: (id: string | null) => void;
}

/**
 * A draggable style chip in the combo-class stack. Mirrors the CMS fields
 * dropdown: the whole row is a grab handle (cursor changes on hover, an
 * explicit grip icon signals reorderability) while a short click still selects
 * the chip and the trailing X removes it from the stack.
 */
interface SortableStyleChipProps {
  style: LayerStyle;
  index: number;
  isActive: boolean;
  isCustomized: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function SortableStyleChip({
  style,
  index,
  isActive,
  isCustomized,
  onSelect,
  onRemove,
}: SortableStyleChipProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: style.id });

  const dndStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={dndStyle}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      title={`${style.name}${index === 0 ? ' (base)' : ''}`}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-grab active:cursor-grabbing select-none',
        isActive
          ? 'border-blue-400 bg-blue-400/10 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50',
      )}
    >
      <Icon name="grip-vertical" className="size-3 text-muted-foreground shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
        <span className="truncate">{style.name}</span>
        {isCustomized && (
          <span className="text-yellow-400 text-[10px]">Customized</span>
        )}
      </span>
      <span
        role="button"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="shrink-0 cursor-pointer opacity-60 hover:opacity-100"
      >
        <Icon name="x" className="size-2.5" />
      </span>
    </div>
  );
}

export default function LayerStylesPanel({
  layer,
  pageId,
  onLayerUpdate,
  activeTextStyleKey,
  activeStyleId: activeStyleIdProp,
  onActiveStyleChange,
}: LayerStylesPanelProps) {
  const {
    styles,
    createStyle,
    updateStyle,
    deleteStyle,
    getStyleById,
  } = useLayerStylesStore();

  // Real-time style sync
  const liveLayerStyleUpdates = useLiveLayerStyleUpdates();

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [styleToDelete, setStyleToDelete] = useState<string | null>(null);
  const [internalActiveStyleId, setInternalActiveStyleId] = useState<string | null>(null);
  // Controlled when the parent passes `onActiveStyleChange`, else internal.
  const activeStyleId = activeStyleIdProp !== undefined ? activeStyleIdProp : internalActiveStyleId;
  const setActiveStyleId = useCallback((id: string | null) => {
    if (onActiveStyleChange) onActiveStyleChange(id);
    else setInternalActiveStyleId(id);
  }, [onActiveStyleChange]);

  // Reorder requires a small drag threshold so a plain click still selects.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const isTextStyleMode = !!activeTextStyleKey;

  const stylesById = useMemo(
    () => new Map<string, LayerStyle>(styles.map((s) => [s.id, s])),
    [styles]
  );

  // Determine the style group for this element
  const currentGroup = isTextStyleMode
    ? getTextStyleGroup(activeTextStyleKey!)
    : layer
      ? getStyleGroup(layer.name)
      : 'block';

  const filteredStyles = useMemo(
    () => styles.filter((s) => isStyleGroupCompatible(s.group, currentGroup)),
    [styles, currentGroup]
  );

  // Get the current text style when in text style mode
  const currentTextStyle: TextStyle | undefined = isTextStyleMode && layer?.textStyles
    ? layer.textStyles[activeTextStyleKey!] ?? DEFAULT_TEXT_STYLES[activeTextStyleKey!]
    : undefined;

  // The layer's ordered style stack (combo classes). Empty in text-style mode.
  const appliedStyleIds = useMemo(
    () => (!isTextStyleMode && layer ? getStyleIds(layer) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isTextStyleMode, layer?.styleIds, layer?.styleId]
  );
  const appliedStyles = appliedStyleIds
    .map((id) => getStyleById(id))
    .filter((s): s is LayerStyle => !!s);

  // The active style is the target for footer actions. Defaults to the last
  // (highest-priority) chip; text mode uses the single applied text style.
  const textAppliedStyleId = isTextStyleMode ? currentTextStyle?.styleId : undefined;
  const layerActiveId = activeStyleId && appliedStyleIds.includes(activeStyleId)
    ? activeStyleId
    : appliedStyleIds[appliedStyleIds.length - 1] ?? null;
  const activeStyleId_ = isTextStyleMode ? textAppliedStyleId ?? null : layerActiveId;
  const activeStyle = activeStyleId_ ? getStyleById(activeStyleId_) : undefined;

  // Override / "Customized" state
  const hasOverrides = isTextStyleMode
    ? !!currentTextStyle?.styleOverrides
    : !!layer?.styleOverrides;

  // In layer mode, customization is per-chip: each chip can carry its own
  // override (`styleOverridesByStyle[styleId]`), so the "Customized" badge,
  // "Update", and "Reset" act only on the active chip — not the whole stack.
  const overridesByStyle = !isTextStyleMode ? layer?.styleOverridesByStyle : undefined;
  const topStyleId = appliedStyleIds[appliedStyleIds.length - 1] ?? null;
  // A legacy single-blob override (pre per-chip) is attributed to the top chip,
  // so it still surfaces a "Customized" badge and can be Reset (never stuck).
  const legacyOnTop = !isTextStyleMode && !!layer?.styleOverrides && !!topStyleId
    && activeStyleId_ === topStyleId;
  const activeHasPerChip = !!activeStyleId_ && !!overridesByStyle?.[activeStyleId_];
  const activeChipCustomized = activeHasPerChip || legacyOnTop;
  // Reset clears the active chip's override (or legacy blob). Update folds a
  // per-chip override into the shared style (text mode uses its single override).
  const canEditOverride = isTextStyleMode ? hasOverrides : activeChipCustomized;
  const canUpdate = isTextStyleMode ? hasOverrides : activeHasPerChip;

  const currentClasses = isTextStyleMode
    ? currentTextStyle?.classes || ''
    : layer
      ? Array.isArray(layer.classes) ? layer.classes.join(' ') : layer.classes || ''
      : '';

  const currentDesign = isTextStyleMode ? currentTextStyle?.design : layer?.design;

  // Helper to update a text style on the layer
  const updateTextStyle = useCallback((updates: Partial<TextStyle>) => {
    if (!layer || !activeTextStyleKey) return;
    const currentTextStyles = layer.textStyles ?? { ...DEFAULT_TEXT_STYLES };
    const existingStyle = currentTextStyles[activeTextStyleKey] || {};
    onLayerUpdate(layer.id, {
      textStyles: {
        ...currentTextStyles,
        [activeTextStyleKey]: { ...existingStyle, ...updates },
      },
    });
  }, [layer, activeTextStyleKey, onLayerUpdate]);

  // Persist a new style stack on the layer, re-flattening its classes/design.
  // Per-chip overrides for styles dropped from the stack are pruned.
  const applyStack = useCallback((styleIds: string[]) => {
    if (!layer) return;
    const prevMap = layer.styleOverridesByStyle ?? {};
    const map: NonNullable<Layer['styleOverridesByStyle']> = {};
    for (const id of styleIds) if (prevMap[id]) map[id] = prevMap[id];
    const hasMap = Object.keys(map).length > 0;
    const probe = {
      styleIds,
      styleOverridesByStyle: hasMap ? map : undefined,
      styleOverrides: layer.styleOverrides,
    };
    onLayerUpdate(layer.id, {
      styleIds,
      styleId: styleIds[0],
      styleOverridesByStyle: hasMap ? map : undefined,
      classes: resolveLayerClasses(probe, stylesById),
      design: resolveLayerDesign(probe, stylesById),
    });
    setActiveStyleId(styleIds.length ? styleIds[styleIds.length - 1] : null);
  }, [layer, stylesById, onLayerUpdate, setActiveStyleId]);

  /**
   * "New" creates a fresh style and immediately opens rename.
   *
   * With an active chip, it FORKS that chip: the new style captures the chip's
   * current (possibly customized) classes, swaps into the stack at the chip's
   * position, and the chip's local override is dropped (now baked into the new
   * style). On a style-less layer / text style it captures the current styling
   * and applies it. In all cases we jump straight into the rename field.
   */
  const handleNewStyle = useCallback(async () => {
    if (!layer) return;

    // Style-less layer or text style: capture current styling and apply.
    if (isTextStyleMode || !activeStyleId_ || appliedStyleIds.length === 0) {
      const style = await createStyle(
        isTextStyleMode ? 'Text style' : 'Style',
        currentClasses,
        currentDesign,
        currentGroup,
      );
      if (!style) return;
      if (isTextStyleMode) {
        updateTextStyle({ classes: style.classes, design: style.design, styleId: style.id, styleOverrides: undefined });
      } else {
        const updatedLayer = applyStyleToLayer(layer, style);
        onLayerUpdate(layer.id, {
          classes: updatedLayer.classes,
          design: updatedLayer.design,
          styleId: updatedLayer.styleId,
          styleIds: updatedLayer.styleIds,
          styleOverrides: undefined,
          styleOverridesByStyle: undefined,
        });
        setActiveStyleId(style.id);
      }
      liveLayerStyleUpdates?.broadcastStyleCreate(style);
      setRenameValue(style.name);
      setIsRenaming(true);
      return;
    }

    // Active chip: fork it in place.
    const forkClasses = chipClasses(layer, activeStyleId_, stylesById);
    const sourceName = getStyleById(activeStyleId_)?.name ?? 'Style';
    const style = await createStyle(sourceName, forkClasses, buildDesign(forkClasses), currentGroup);
    if (!style) return;

    const nextIds = appliedStyleIds.map((id) => (id === activeStyleId_ ? style.id : id));
    // Drop the forked chip's override (baked into the new style); keep the rest.
    const prevMap = layer.styleOverridesByStyle ?? {};
    const map: NonNullable<Layer['styleOverridesByStyle']> = {};
    for (const id of nextIds) if (id !== style.id && prevMap[id]) map[id] = prevMap[id];
    const hasMap = Object.keys(map).length > 0;
    const nextStyles = new Map(stylesById);
    nextStyles.set(style.id, style);
    const probe = { styleIds: nextIds, styleOverridesByStyle: hasMap ? map : undefined };
    onLayerUpdate(layer.id, {
      styleIds: nextIds,
      styleId: nextIds[0],
      styleOverridesByStyle: hasMap ? map : undefined,
      styleOverrides: undefined,
      classes: resolveLayerClasses(probe, nextStyles),
      design: resolveLayerDesign(probe, nextStyles),
    });
    setActiveStyleId(style.id);
    liveLayerStyleUpdates?.broadcastStyleCreate(style);
    setRenameValue(style.name);
    setIsRenaming(true);
  }, [layer, isTextStyleMode, activeStyleId_, appliedStyleIds, currentClasses, currentDesign, currentGroup, stylesById, getStyleById, createStyle, onLayerUpdate, updateTextStyle, setActiveStyleId, liveLayerStyleUpdates]);

  // Text-style mode: apply (replace) the single style.
  const handleApplyTextStyle = useCallback((styleId: string) => {
    const style = getStyleById(styleId);
    if (!style) return;
    updateTextStyle({
      classes: style.classes,
      design: style.design,
      styleId: style.id,
      styleOverrides: undefined,
    });
  }, [getStyleById, updateTextStyle]);

  // Layer mode: toggle a style in/out of the stack (append = highest priority).
  const toggleStyleMembership = useCallback((styleId: string) => {
    if (!layer) return;
    const ids = getStyleIds(layer);
    const next = ids.includes(styleId) ? ids.filter((id) => id !== styleId) : [...ids, styleId];
    applyStack(next);
  }, [layer, applyStack]);

  // Drag-to-reorder chips (dnd-kit sortable, matching the CMS fields dropdown).
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = appliedStyleIds.indexOf(String(active.id));
    const newIndex = appliedStyleIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const ids = [...appliedStyleIds];
    const [moved] = ids.splice(oldIndex, 1);
    ids.splice(newIndex, 0, moved);
    applyStack(ids);
  }, [appliedStyleIds, applyStack]);

  /**
   * Detach the ACTIVE chip: unlink that one shared style but keep its look.
   *
   * Unlike the chip's X (which removes the style AND its classes), Detach keeps
   * the layer looking identical. The active chip is dropped from the stack and
   * its *winning* class contribution is folded into the TOP remaining chip's
   * per-chip override (`styleOverridesByStyle`). We use a per-chip override
   * (not the legacy single `styleOverrides` blob) so the layer is NOT frozen:
   * the other chips keep tracking their shared styles. Because the resolver
   * already decided the per-property winners, the detached delta never
   * conflicts with the remaining stack, so a middle-of-stack detach stays
   * visually faithful. Detaching the only chip flattens to plain classes.
   */
  const handleDetachStyle = useCallback(() => {
    if (!layer) return;
    if (isTextStyleMode) {
      updateTextStyle({ styleId: undefined, styleOverrides: undefined });
      return;
    }
    if (!activeStyleId_) return;

    const fullResolved = resolveLayerClasses(layer, stylesById);
    const remaining = appliedStyleIds.filter((id) => id !== activeStyleId_);

    // Only chip in the stack: flatten everything into plain layer classes.
    if (remaining.length === 0) {
      const updatedLayer = detachStyleFromLayer(layer);
      onLayerUpdate(layer.id, {
        classes: updatedLayer.classes,
        design: updatedLayer.design,
        styleId: undefined,
        styleIds: undefined,
        styleOverrides: undefined,
        styleOverridesByStyle: undefined,
      });
      setActiveStyleId(null);
      return;
    }

    // Keep only the remaining chips' per-chip overrides.
    const prevMap = layer.styleOverridesByStyle ?? {};
    const map: NonNullable<Layer['styleOverridesByStyle']> = {};
    for (const id of remaining) if (prevMap[id]) map[id] = prevMap[id];

    // The detached style's surviving contribution = current resolved classes
    // minus what the remaining stack alone resolves to. Fold it into the top
    // chip's override so it renders at the highest priority without freezing
    // the layer against style updates.
    const remainingResolved = resolveLayerClasses(
      { styleIds: remaining, styleOverridesByStyle: Object.keys(map).length ? map : undefined },
      stylesById,
    );
    const remainingSet = new Set(remainingResolved.split(/\s+/).filter(Boolean));
    const detached = fullResolved.split(/\s+/).filter((c) => c && !remainingSet.has(c));

    if (detached.length > 0) {
      const topId = remaining[remaining.length - 1];
      const topCurrent = chipClasses({ styleOverridesByStyle: map }, topId, stylesById)
        .split(/\s+/)
        .filter(Boolean);
      const mergedTop = mergeClassStack([...topCurrent, ...detached]).join(' ');
      map[topId] = { classes: mergedTop, design: buildDesign(mergedTop) };
    }
    const hasMap = Object.keys(map).length > 0;

    onLayerUpdate(layer.id, {
      styleIds: remaining,
      styleId: remaining[0],
      styleOverridesByStyle: hasMap ? map : undefined,
      styleOverrides: undefined,
      classes: fullResolved,
      design: buildDesign(fullResolved),
    });
    setActiveStyleId(remaining[remaining.length - 1]);
  }, [layer, isTextStyleMode, activeStyleId_, appliedStyleIds, stylesById, updateTextStyle, onLayerUpdate, setActiveStyleId]);

  // Reset the active chip's customization back to the shared style (text mode
  // resets the single applied text style).
  const handleResetOverrides = useCallback(() => {
    if (!layer) return;
    if (isTextStyleMode) {
      if (!activeStyle) return;
      updateTextStyle({
        classes: activeStyle.classes,
        design: activeStyle.design,
        styleOverrides: undefined,
      });
      return;
    }
    if (!activeStyleId_) return;
    const map = { ...(layer.styleOverridesByStyle ?? {}) };
    delete map[activeStyleId_];
    const hasMap = Object.keys(map).length > 0;
    // Reset to the clean stack: drop this chip's override AND any legacy blob.
    const probe = {
      styleIds: appliedStyleIds,
      styleOverridesByStyle: hasMap ? map : undefined,
    };
    onLayerUpdate(layer.id, {
      styleOverridesByStyle: hasMap ? map : undefined,
      styleOverrides: undefined,
      classes: resolveLayerClasses(probe, stylesById),
      design: resolveLayerDesign(probe, stylesById),
    });
  }, [layer, isTextStyleMode, activeStyle, activeStyleId_, updateTextStyle, appliedStyleIds, stylesById, onLayerUpdate]);

  /**
   * Fold the active chip's customization into the shared style, so every layer
   * using that style picks it up. Text mode folds the whole text-style classes.
   * Layer mode promotes the active chip's per-chip override to the style and
   * clears that override.
   */
  const handleUpdateStyle = useCallback(async () => {
    if (!layer || !activeStyle) return;

    let nextClasses: string;
    let nextDesign: Layer['design'];

    if (isTextStyleMode) {
      nextClasses = currentClasses;
      nextDesign = currentDesign;
    } else {
      const override = layer.styleOverridesByStyle?.[activeStyle.id];
      if (!override) return;
      nextClasses = override.classes ?? activeStyle.classes ?? '';
      nextDesign = override.design ?? buildDesign(nextClasses);
    }

    await updateStyle(activeStyle.id, { classes: nextClasses, design: nextDesign });
    updateStyleAcrossStores(activeStyle.id, nextClasses, nextDesign);

    if (isTextStyleMode) {
      updateTextStyle({ styleOverrides: undefined });
    } else {
      // Drop the chip's override and re-flatten against the now-updated style.
      const map = { ...(layer.styleOverridesByStyle ?? {}) };
      delete map[activeStyle.id];
      const hasMap = Object.keys(map).length > 0;
      const nextStyles = new Map(stylesById);
      nextStyles.set(activeStyle.id, { ...activeStyle, classes: nextClasses, design: nextDesign });
      const probe = {
        styleIds: appliedStyleIds,
        styleOverridesByStyle: hasMap ? map : undefined,
        styleOverrides: layer.styleOverrides,
      };
      onLayerUpdate(layer.id, {
        styleOverridesByStyle: hasMap ? map : undefined,
        classes: resolveLayerClasses(probe, nextStyles),
        design: resolveLayerDesign(probe, nextStyles),
      });
    }

    liveLayerStyleUpdates?.broadcastStyleUpdate(activeStyle.id, { classes: nextClasses, design: nextDesign });
  }, [layer, activeStyle, isTextStyleMode, currentClasses, currentDesign, appliedStyleIds, stylesById, updateStyle, onLayerUpdate, updateTextStyle, liveLayerStyleUpdates]);

  const handleDeleteStyle = useCallback((styleId: string) => {
    setStyleToDelete(styleId);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteDialogClose = useCallback((open: boolean) => {
    setDeleteDialogOpen(open);
    if (!open) setStyleToDelete(null);
  }, []);

  const confirmDeleteStyle = useCallback(async () => {
    if (!styleToDelete) return;
    const result = await deleteStyle(styleToDelete);
    if (result.success) {
      detachStyleAcrossStores(styleToDelete);
      liveLayerStyleUpdates?.broadcastStyleDelete(styleToDelete);
    } else {
      throw new Error('Failed to delete layer style');
    }
  }, [styleToDelete, deleteStyle, liveLayerStyleUpdates]);

  const handleRenameStyle = useCallback(async () => {
    if (!activeStyle || !renameValue.trim()) return;
    await updateStyle(activeStyle.id, { name: renameValue.trim() });
    setIsRenaming(false);
    setRenameValue('');
    liveLayerStyleUpdates?.broadcastStyleUpdate(activeStyle.id, { name: renameValue.trim() });
  }, [activeStyle, renameValue, updateStyle, liveLayerStyleUpdates]);

  if (!layer) {
    return (
      <div className="p-4 text-sm text-zinc-500">
        Select a layer to manage styles
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 pb-2 pt-3">
      {/* Rename input */}
      {activeStyle && isRenaming && (
        <div className="flex flex-col gap-2">
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameStyle();
              if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(''); }
            }}
            autoFocus
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm" variant="default"
              onClick={handleRenameStyle}
            >Save changes</Button>
            <Button
              size="sm" variant="secondary"
              onClick={() => { setIsRenaming(false); setRenameValue(''); }}
            >Cancel</Button>
          </div>
        </div>
      )}

      {/* Selector (text mode = single select; layer mode = chips + picker) */}
      {!isRenaming && (
        isTextStyleMode ? (
          <Select onValueChange={handleApplyTextStyle} value={textAppliedStyleId || ''}>
            <SelectTrigger className="flex-1">
              {filteredStyles.length === 0 ? (
                <span className="opacity-50">Apply layer style...</span>
              ) : (
                <SelectValue placeholder="Apply layer style..." />
              )}
              {hasOverrides && (
                <span className="ml-auto text-yellow-400 text-[10px] pr-1">Customized</span>
              )}
            </SelectTrigger>
            <SelectContent>
              {filteredStyles.length === 0 ? (
                <Empty><EmptyTitle>No layers styles</EmptyTitle></Empty>
              ) : (
                <SelectGroup>
                  {filteredStyles.map((style) => (
                    <SelectItem key={style.id} value={style.id}>{style.name}</SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex flex-col gap-1.5">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={appliedStyleIds} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-1.5">
                  {appliedStyles.map((style, index) => (
                    <SortableStyleChip
                      key={style.id}
                      style={style}
                      index={index}
                      isActive={style.id === activeStyleId_}
                      isCustomized={!!overridesByStyle?.[style.id] || (legacyOnTop && style.id === topStyleId)}
                      onSelect={() => setActiveStyleId(style.id)}
                      onRemove={() => toggleStyleMembership(style.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {/* Add styles to the stack (checkbox membership) — full-width footer */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm" variant="outline"
                  className="w-full"
                >
                  <Icon name="plus" className="size-3" />
                  <span className="text-xs">Add style</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto w-(--radix-dropdown-menu-trigger-width) min-w-50">
                {filteredStyles.length === 0 ? (
                  <DropdownMenuItem disabled>No layer styles</DropdownMenuItem>
                ) : (
                  filteredStyles.map((style) => (
                    <DropdownMenuCheckboxItem
                      key={style.id}
                      checked={appliedStyleIds.includes(style.id)}
                      onCheckedChange={() => toggleStyleMembership(style.id)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {style.name}
                    </DropdownMenuCheckboxItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      )}

      {!isRenaming && (
        <div className="flex">
          <Button
            size="sm" variant="ghost"
            onClick={handleNewStyle} className="flex-1"
          >
            <Icon name="plus" />
            New
          </Button>

          <Button
            size="sm" variant="ghost"
            onClick={handleUpdateStyle} disabled={!canUpdate || !activeStyle}
          >
            Update
          </Button>

          <Button
            size="sm" variant="ghost"
            onClick={handleDetachStyle} disabled={!activeStyle}
          >
            Detach
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <Icon name="more" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleResetOverrides} disabled={!canEditOverride}>
                Reset
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  if (!activeStyle) return;
                  setRenameValue(activeStyle.name);
                  setIsRenaming(true);
                }}
                disabled={!activeStyle}
              >
                Rename{activeStyle ? ` "${activeStyle.name}"` : ''}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => activeStyle && handleDeleteStyle(activeStyle.id)}
                disabled={!activeStyle}
              >
                Delete{activeStyle ? ` "${activeStyle.name}"` : ''}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={handleDeleteDialogClose}
        title="Delete layer style"
        description="Are you sure you want to delete this style? It will be detached from all layers."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={confirmDeleteStyle}
      />
    </div>
  );
}
