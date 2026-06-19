'use client';

/**
 * Globals Manager
 *
 * Right-panel UI for the CMS "Global variables" section. Manages site-wide
 * typed singletons (Name / Type / Value). The value editor adapts to the
 * selected type, reusing the same building blocks as collection item editing
 * (color, link, asset, rich text inputs).
 */

import { useEffect, useMemo, useState } from 'react';
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useGlobalsStore } from '@/stores/useGlobalsStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { ASSET_CATEGORIES, getOptimizedImageUrl, isAssetOfType } from '@/lib/asset-utils';
import { FIELD_TYPES } from '@/lib/collection-field-utils';
import { getFileManagerCategory, isValidAssetForField } from '@/lib/collection-field-utils';
import { extractPlainTextFromTiptap } from '@/lib/tiptap-utils';
import { formatDateInTimezone, localDatetimeToUTC, clampDateInputValue } from '@/lib/date-format-utils';
import ColorFieldInput from './ColorFieldInput';
import CollectionLinkFieldInput from './CollectionLinkFieldInput';
import RichTextEditor from './RichTextEditor';
import RichTextEditorSheet from './RichTextEditorSheet';
import AssetFieldCard from './AssetFieldCard';
import { GLOBAL_VARIABLE_TYPES, type GlobalVariable, type GlobalVariableType } from '@/types';

interface GlobalsManagerProps {
  canManageSchema?: boolean;
  timezone: string;
}

/** Type metadata (label + icon) sourced from the shared collection field config. */
function getTypeMeta(type: GlobalVariableType): { label: string; icon: Parameters<typeof Icon>[0]['name'] } {
  const meta = FIELD_TYPES.find((t) => t.value === type);
  return {
    label: meta?.label ?? type,
    icon: (meta?.icon ?? 'text') as Parameters<typeof Icon>[0]['name'],
  };
}

/** Human-readable preview of a stored global value for the list. */
function getValuePreview(global: GlobalVariable, timezone: string, assetName: (id: string) => string): string {
  const { type, value } = global;
  if (!value) return '';
  switch (type) {
    case 'rich_text':
      try {
        return extractPlainTextFromTiptap(JSON.parse(value));
      } catch {
        return String(value);
      }
    case 'image':
      return assetName(value);
    case 'date':
      return formatDateInTimezone(value, timezone, 'display');
    case 'link':
      try {
        const parsed = JSON.parse(value);
        return parsed?.url || parsed?.value || 'Link';
      } catch {
        return String(value);
      }
    default:
      return String(value);
  }
}

interface GlobalImagePreviewProps {
  assetId: string;
}

/** Inline image thumbnail used in the value column for image-typed globals. */
function GlobalImagePreview({ assetId }: GlobalImagePreviewProps) {
  const getAsset = useAssetsStore((state) => state.getAsset);
  const asset = getAsset(assetId);

  if (!asset) {
    return (
      <div className="relative size-8 rounded-[6px] overflow-hidden bg-secondary/30 inline-block">
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <Icon name="image" className="size-3.5 text-muted-foreground" />
        </div>
      </div>
    );
  }

  const isSvgIcon = !!asset.content || (asset.mime_type && isAssetOfType(asset.mime_type, ASSET_CATEGORIES.ICONS));
  const imageUrl = asset.public_url ?? null;
  const showCheckerboard = isSvgIcon || !!imageUrl;

  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <div className="relative size-8 rounded-[6px] overflow-hidden bg-secondary/30 inline-block">
          {showCheckerboard && (
            <div className="absolute inset-0 opacity-10 bg-checkerboard" />
          )}
          {isSvgIcon && asset.content ? (
            <div
              data-icon
              className="relative w-full h-full flex items-center justify-center p-1 pointer-events-none text-foreground z-10"
              dangerouslySetInnerHTML={{ __html: asset.content }}
            />
          ) : imageUrl ? (
            <img
              src={getOptimizedImageUrl(imageUrl)}
              alt={asset.filename || 'Image'}
              className="relative w-full h-full object-contain pointer-events-none z-10"
              loading="lazy"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <Icon name="image" className="size-3.5 text-muted-foreground" />
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p>{asset.filename}</p>
      </TooltipContent>
    </Tooltip>
  );
}

interface GlobalValueInputProps {
  type: GlobalVariableType;
  value: string;
  onChange: (value: string) => void;
  timezone: string;
}

/** Type-aware value editor used inside the create/edit dialog. */
function GlobalValueInput({ type, value, onChange, timezone }: GlobalValueInputProps) {
  const openFileManager = useEditorStore((state) => state.openFileManager);
  const getAsset = useAssetsStore((state) => state.getAsset);
  const [expanded, setExpanded] = useState(false);

  if (type === 'rich_text') {
    return (
      <div>
        <RichTextEditor
          value={value || ''}
          onChange={onChange}
          placeholder="Enter value..."
          variant="full"
          withFormatting={true}
          excludedLinkTypes={['asset', 'field']}
          hidePageContextOptions={true}
          onExpandClick={() => setExpanded(true)}
        />
        <RichTextEditorSheet
          open={expanded}
          onOpenChange={(open) => { if (!open) setExpanded(false); }}
          description="Global variable value"
          value={value || ''}
          onChange={onChange}
          placeholder="Enter value..."
          hidePageContextOptions={true}
        />
      </div>
    );
  }

  if (type === 'color') {
    return <ColorFieldInput value={value || ''} onChange={onChange} />;
  }

  if (type === 'link') {
    return <CollectionLinkFieldInput value={value || ''} onChange={onChange} />;
  }

  if (type === 'number') {
    return (
      <Input
        type="number"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter a number..."
      />
    );
  }

  if (type === 'date') {
    return (
      <Input
        type="datetime-local"
        value={value ? formatDateInTimezone(value, timezone, 'datetime-local') : ''}
        onChange={(e) => {
          const clamped = clampDateInputValue(e.target.value);
          onChange(clamped ? localDatetimeToUTC(clamped, timezone) : '');
        }}
      />
    );
  }

  if (type === 'image') {
    const currentAsset = value ? getAsset(value) : null;
    const handleOpenFileManager = () => {
      openFileManager(
        (asset) => {
          if (!isValidAssetForField(asset, 'image')) {
            toast.error('Invalid asset type', { description: 'Please select an image file.' });
            return false;
          }
          onChange(asset.id);
        },
        value || null,
        getFileManagerCategory('image')
      );
    };

    if (!currentAsset) {
      return (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-fit"
          onClick={(e) => { e.stopPropagation(); handleOpenFileManager(); }}
        >
          <Icon name="plus" className="size-3" />
          Add image
        </Button>
      );
    }

    return (
      <AssetFieldCard
        asset={currentAsset}
        fieldType="image"
        onChangeFile={handleOpenFileManager}
        onRemove={() => onChange('')}
      />
    );
  }

  // text (default)
  return (
    <Input
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Enter value..."
    />
  );
}

interface GlobalFormState {
  name: string;
  type: GlobalVariableType;
  value: string;
}

const EMPTY_FORM: GlobalFormState = { name: '', type: 'text', value: '' };

export default function GlobalsManager({ canManageSchema = true, timezone }: GlobalsManagerProps) {
  const { globals, isLoading, hasLoaded, loadGlobals, createGlobal, updateGlobal, deleteGlobal } = useGlobalsStore();
  const getAsset = useAssetsStore((state) => state.getAsset);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<GlobalFormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!hasLoaded) {
      loadGlobals();
    }
  }, [hasLoaded, loadGlobals]);

  const assetName = useMemo(
    () => (id: string) => getAsset(id)?.filename || 'Image',
    [getAsset]
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (global: GlobalVariable) => {
    setEditingId(global.id);
    setForm({ name: global.name, type: global.type, value: global.value || '' });
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }

    setIsSaving(true);
    try {
      if (editingId) {
        const result = await updateGlobal(editingId, {
          name: form.name.trim(),
          type: form.type,
          value: form.value || null,
        });
        if (result) {
          toast.success('Global variable updated');
          setDialogOpen(false);
        }
      } else {
        const result = await createGlobal({
          name: form.name.trim(),
          type: form.type,
          value: form.value || null,
        });
        if (result) {
          toast.success('Global variable created');
          setDialogOpen(false);
        }
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const ok = await deleteGlobal(deleteId);
    if (ok) {
      toast.success('Global variable deleted');
    }
    setDeleteId(null);
  };

  // Reset the value when the type changes so we don't carry an incompatible
  // value (e.g. an asset id) into a text field.
  const handleTypeChange = (type: GlobalVariableType) => {
    setForm((prev) => ({ ...prev, type, value: '' }));
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="p-4 flex items-center justify-between border-b">
        <div className="flex items-center gap-2">
          <Icon name="globe" className="size-3.5 text-muted-foreground" />
          <span className="font-medium">Global variables</span>
        </div>
        {canManageSchema && (
          <Button
            size="sm" variant="secondary"
            onClick={openCreate}
          >
            <Icon name="plus" />
            New variable
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && !hasLoaded ? (
          <div className="flex items-center justify-center p-8">
            <Spinner />
          </div>
        ) : globals.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Empty>
              <EmptyTitle>No global variables</EmptyTitle>
              <EmptyDescription>
                Create site-wide values you can reuse anywhere via content.
              </EmptyDescription>
            </Empty>
          </div>
        ) : (
          <table className="border-0 whitespace-nowrap text-xs min-w-full align-top border-separate border-spacing-0 [&>tbody>tr>td]:border-b [&>tbody>tr>td]:max-w-56">
            <thead>
              <tr>
                <th className="pl-5 pr-4 py-5 text-left font-normal sticky top-0 z-10 bg-background border-b border-border">Name</th>
                <th className="px-4 py-5 text-left font-normal sticky top-0 z-10 bg-background border-b border-border">Type</th>
                <th className="px-4 py-5 text-left font-normal sticky top-0 z-10 bg-background border-b border-border">Value</th>
              </tr>
            </thead>
            <tbody>
              {globals.map((global) => {
                const meta = getTypeMeta(global.type);
                const preview = getValuePreview(global, timezone, assetName);
                return (
                  <ContextMenu key={global.id}>
                    <ContextMenuTrigger asChild>
                      <tr
                        className={cn(
                          'group h-16 border-b hover:bg-secondary/50 transition-colors cursor-pointer',
                          !canManageSchema && 'cursor-default'
                        )}
                        onClick={() => canManageSchema && openEdit(global)}
                      >
                        <td className="pl-5 pr-4 py-5 text-muted-foreground">{global.name}</td>
                        <td className="px-4 py-5 text-muted-foreground">
                          <span className="flex items-center gap-2">
                            <Icon name={meta.icon} className="size-3 shrink-0 opacity-60" />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-4 text-muted-foreground">
                          {global.type === 'image' && global.value ? (
                            <GlobalImagePreview assetId={global.value} />
                          ) : (
                            <span className="block truncate">{preview || '-'}</span>
                          )}
                        </td>
                      </tr>
                    </ContextMenuTrigger>
                    {canManageSchema && (
                      <ContextMenuContent>
                        <ContextMenuItem onClick={() => openEdit(global)}>Edit</ContextMenuItem>
                        <ContextMenuItem
                          variant="destructive"
                          onClick={() => setDeleteId(global.id)}
                        >
                          Delete
                        </ContextMenuItem>
                      </ContextMenuContent>
                    )}
                  </ContextMenu>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit global variable' : 'New global variable'}</DialogTitle>
            <DialogDescription>
              Global variables can be injected anywhere via content.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="global-name">Name</Label>
              <Input
                id="global-name"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. Company name"
                autoComplete="off"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="global-type">Type</Label>
              <Select value={form.type} onValueChange={(v) => handleTypeChange(v as GlobalVariableType)}>
                <SelectTrigger id="global-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GLOBAL_VARIABLE_TYPES.map((type) => {
                    const meta = getTypeMeta(type);
                    return (
                      <SelectItem key={type} value={type}>
                        <span className="flex items-center gap-2">
                          <Icon name={meta.icon} className="size-3 shrink-0 opacity-60" />
                          {meta.label}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Value</Label>
              <GlobalValueInput
                type={form.type}
                value={form.value}
                onChange={(value) => setForm((prev) => ({ ...prev, value }))}
                timezone={timezone}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost" onClick={() => setDialogOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isSaving}>
              {isSaving ? <Spinner /> : editingId ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) setDeleteId(null); }}
        title="Delete global variable"
        description="This will remove the global variable. Layers using it will no longer resolve a value."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
