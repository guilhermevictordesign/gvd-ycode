'use client';

/**
 * Shared TipTap NodeView factory for dynamic variable badges.
 *
 * Creates a DynamicVariable extension with a React-based NodeView that renders
 * an inline badge with optional format selector (for date/number fields).
 *
 * Used by both RichTextEditor (sidebar variant) and CanvasTextEditor (canvas variant).
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';

import { DynamicVariable, getDynamicVariableLabel } from '@/lib/tiptap-extensions/dynamic-variable';
import { isFormattableFieldType, isFormatValidForFieldType, getDefaultFormatId } from '@/lib/variable-format-utils';
import { flattenFieldGroups, type FieldGroup } from '@/lib/collection-field-utils';
import { getVariableLabel } from '@/lib/cms-variables-utils';
import type { CollectionField } from '@/types';
import VariableFormatSelector from '@/app/(builder)/ycode/components/VariableFormatSelector';

type VariableViewVariant = 'sidebar' | 'canvas';

interface DynamicVariableStorage {
  /**
   * Live re-render callbacks, one per mounted badge. RichTextEditor invokes
   * these when its field context changes so labels reflect renamed/deleted
   * fields and globals immediately, without rebuilding the document.
   */
  renderers: Set<() => void>;
}

/**
 * Resolve the badge label from the editor's *live* field context when available,
 * falling back to the label baked into the node. The baked label is what gets
 * persisted (and used for SSR/published output, which has no live store), but in
 * the builder the synced context is authoritative so a renamed field/global or a
 * deleted one ("[Deleted Field]") reflects instantly.
 */
function resolveLiveLabel(editor: { storage: Record<string, any> }, node: { attrs: Record<string, any> }): string {
  const variable = node.attrs.variable;
  if (variable?.type === 'field' && variable.data?.field_id) {
    const ctx = editor.storage?.richTextComponent?.editorContext as
      | { fieldGroups?: FieldGroup[]; allFields?: Record<string, CollectionField[]> }
      | undefined;
    // Once a RichTextEditor has synced its context, that context is the source
    // of truth — even when it's empty (e.g. the last global was deleted, leaving
    // no field groups). Resolving against it yields "[Deleted Field]" for a
    // dangling binding instead of falling back to the stale baked label.
    if (ctx) {
      return getVariableLabel(variable, flattenFieldGroups(ctx.fieldGroups), ctx.allFields);
    }
  }
  return getDynamicVariableLabel(node);
}

/**
 * Resolve the bound field's *current* type from the live context, falling back
 * to the type baked into the node. A field/global can change type after a pill
 * is inserted (e.g. text → number), and the format selector + persisted value
 * formatting must follow the current type, not the stale snapshot.
 */
function resolveLiveFieldType(
  editor: { storage: Record<string, any> },
  node: { attrs: Record<string, any> }
): string | undefined {
  const variable = node.attrs.variable;
  if (variable?.type === 'field' && variable.data?.field_id) {
    const ctx = editor.storage?.richTextComponent?.editorContext as
      | { fieldGroups?: FieldGroup[] }
      | undefined;
    // When the context is synced it's authoritative: a missing field means the
    // binding is dangling (deleted), so return no type. That keeps the format
    // selector consistent with the "[Deleted Field]" label — a deleted field
    // can't be formatted. Only fall back to the baked type when no context
    // exists at all (e.g. the canvas variant doesn't sync one).
    if (ctx) {
      return flattenFieldGroups(ctx.fieldGroups).find((f) => f.id === variable.data.field_id)?.type;
    }
  }
  return variable?.data?.field_type;
}

const VARIANT_CONFIG = {
  sidebar: {
    badgeVariant: 'secondary' as const,
    deleteButtonVariant: 'outline' as const,
    formatSelectorVariant: 'sidebar' as const,
  },
  canvas: {
    badgeVariant: 'inline_variable_canvas' as const,
    deleteButtonVariant: 'inline_variable_canvas' as const,
    formatSelectorVariant: 'canvas' as const,
  },
};

/**
 * Create a DynamicVariable TipTap extension with a React NodeView.
 * The variant controls visual styling (Badge/Button variants).
 */
export function createDynamicVariableNodeView(variant: VariableViewVariant) {
  const config = VARIANT_CONFIG[variant];

  return DynamicVariable.extend({
    addStorage(): DynamicVariableStorage {
      return { renderers: new Set<() => void>() };
    },
    addNodeView() {
      return ({ node: initialNode, getPos, editor }) => {
        const container = document.createElement('span');
        container.className = 'inline-block';
        container.contentEditable = 'false';

        const storage = (editor.storage as unknown as Record<string, unknown>).dynamicVariable as DynamicVariableStorage | undefined;

        let currentNode = initialNode;
        const syncVariableAttr = () => {
          const variable = currentNode.attrs.variable;
          if (variable) {
            container.setAttribute('data-variable', JSON.stringify(variable));
          } else {
            container.removeAttribute('data-variable');
          }
        };
        syncVariableAttr();

        const handleDelete = () => {
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.chain().focus().deleteRange({ from: pos, to: pos + 1 }).run();
          }
        };

        const handleFormatChange = (formatId: string) => {
          const pos = getPos();
          if (typeof pos === 'number') {
            const currentVariable = currentNode.attrs.variable;
            // Persist the live field type alongside the format so SSR/published
            // formatting uses the field's current type, not the inserted snapshot.
            const liveFieldType = resolveLiveFieldType(editor, currentNode);
            const updatedVariable = {
              ...currentVariable,
              data: { ...currentVariable.data, field_type: liveFieldType, format: formatId },
            };
            editor.chain().focus()
              .command(({ tr }) => {
                tr.setNodeMarkup(pos, undefined, {
                  ...currentNode.attrs,
                  variable: updatedVariable,
                });
                return true;
              })
              .run();
          }
        };

        const root = createRoot(container);

        const renderBadge = () => {
          // Derive label/format from the *current* node on every render so the
          // chip reflects live attribute changes (e.g. a renamed field/global)
          // when ProseMirror reuses this node view via update() instead of
          // recreating it.
          const variable = currentNode.attrs.variable;
          const label = resolveLiveLabel(editor, currentNode);
          const fieldType = resolveLiveFieldType(editor, currentNode);
          const isFormattable = isFormattableFieldType(fieldType);
          const storedFormat = variable?.data?.format;
          const currentFormat = isFormatValidForFieldType(storedFormat, fieldType)
            ? storedFormat
            : getDefaultFormatId(fieldType);
          const badgeContent = (
            <Badge variant={config.badgeVariant}>
              <span>{label}</span>
              {editor.isEditable && isFormattable && (
                <Icon
                  name="chevronDown"
                  className="size-2 opacity-60"
                />
              )}
              {editor.isEditable && (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete();
                  }}
                  className="size-4! p-0! -mr-1"
                  variant={config.deleteButtonVariant}
                >
                  <Icon name="x" className="size-2" />
                </Button>
              )}
            </Badge>
          );

          root.render(
            editor.isEditable && isFormattable ? (
              <VariableFormatSelector
                fieldType={fieldType}
                currentFormat={currentFormat}
                onFormatChange={handleFormatChange}
                variant={config.formatSelectorVariant}
              >
                {badgeContent}
              </VariableFormatSelector>
            ) : badgeContent
          );
        };

        queueMicrotask(renderBadge);

        const updateListener = () => renderBadge();
        editor.on('update', updateListener);
        // Re-render this badge whenever the editor's field context changes
        // (field/global renamed or deleted) so the label stays live.
        storage?.renderers.add(renderBadge);

        return {
          dom: container,
          update: (updatedNode) => {
            if (updatedNode.type.name !== 'dynamicVariable') return false;
            currentNode = updatedNode;
            syncVariableAttr();
            renderBadge();
            return true;
          },
          destroy: () => {
            editor.off('update', updateListener);
            storage?.renderers.delete(renderBadge);
            setTimeout(() => root.unmount(), 0);
          },
        };
      };
    },
  });
}
