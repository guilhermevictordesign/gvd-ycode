import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Layer, LayerInteraction } from '@/types';
import { getDraftLayers, upsertDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { broadcastLayersChanged } from '@/lib/mcp/broadcast';
import { findLayerById, updateLayerById, generateId } from '@/lib/mcp/utils';
import {
  ANIMATION_EASES,
  ANIMATION_PRESETS,
  buildInteractionFromPreset,
} from '@/lib/mcp/animation-presets';

async function getPageLayers(pageId: string): Promise<Layer[]> {
  const pageLayers = await getDraftLayers(pageId);
  return (pageLayers?.layers as Layer[]) || [];
}

async function savePageLayers(pageId: string, layers: Layer[]): Promise<void> {
  await upsertDraftLayers(pageId, layers);
  broadcastLayersChanged(pageId, layers).catch(() => {});
}

const presetEnum = z.enum(ANIMATION_PRESETS);
const triggerEnum = z.enum(['click', 'hover', 'scroll-into-view', 'while-scrolling', 'load']);
const easeEnum = z.enum(ANIMATION_EASES);
const breakpointEnum = z.enum(['desktop', 'tablet', 'mobile']);

const tweenPropertyKeyEnum = z.enum([
  'x', 'y', 'rotation', 'scale', 'skewX', 'skewY',
  'autoAlpha', 'display', 'width', 'height', 'backgroundColor',
]);

const tweenPropertiesSchema = z.object({
  x: z.string().nullable().optional(),
  y: z.string().nullable().optional(),
  rotation: z.string().nullable().optional(),
  scale: z.string().nullable().optional(),
  skewX: z.string().nullable().optional(),
  skewY: z.string().nullable().optional(),
  autoAlpha: z.string().nullable().optional().describe('Opacity 0-100 as a string (e.g. "0", "100"). Stored without unit.'),
  display: z.string().nullable().optional().describe('"visible" or "hidden".'),
  width: z.string().nullable().optional(),
  height: z.string().nullable().optional(),
  backgroundColor: z.string().nullable().optional().describe('Hex / rgb color.'),
});

const tweenSchema = z.object({
  id: z.string().optional().describe('Leave blank to auto-generate.'),
  layer_id: z.string().describe('Layer the tween animates. Can differ from the interaction owner.'),
  position: z.union([z.number(), z.string()])
    .describe('GSAP timeline position. Number = seconds, ">" = after previous, "<" = with previous.'),
  duration: z.number().describe('Tween duration in seconds.'),
  ease: easeEnum.describe('GSAP ease.'),
  from: tweenPropertiesSchema,
  to: tweenPropertiesSchema,
  apply_styles: z.record(tweenPropertyKeyEnum, z.enum(['on-load', 'on-trigger']))
    .optional()
    .describe('Per-property: "on-load" pre-applies the from state immediately (prevents FOUC on reveals). "on-trigger" defers until the trigger fires.'),
});

const interactionSchema = z.object({
  id: z.string().optional().describe('Leave blank to auto-generate.'),
  trigger: triggerEnum,
  timeline: z.object({
    breakpoints: z.array(breakpointEnum).describe('Which breakpoints the animation runs on.'),
    repeat: z.number().describe('-1 = infinite, 0 = none, n = repeat n times.'),
    yoyo: z.boolean().describe('Reverse direction on each repeat.'),
    scrollStart: z.string().optional().describe('Scroll trigger start (e.g. "top 80%"). For scroll-into-view / while-scrolling.'),
    scrollEnd: z.string().optional().describe('Scroll trigger end (e.g. "bottom top"). For while-scrolling.'),
    scrub: z.union([z.boolean(), z.number()]).optional().describe('while-scrolling: true for direct link, number for smoothing seconds.'),
    toggleActions: z.string().optional().describe('scroll-into-view: GSAP toggleActions (default "play none none none").'),
  }),
  tweens: z.array(tweenSchema).min(1),
});

function ensureIds(interaction: z.infer<typeof interactionSchema>): LayerInteraction {
  return {
    id: interaction.id || generateId('int'),
    trigger: interaction.trigger,
    timeline: interaction.timeline,
    tweens: interaction.tweens.map((t) => ({
      id: t.id || generateId('twn'),
      layer_id: t.layer_id,
      position: t.position,
      duration: t.duration,
      ease: t.ease,
      from: t.from,
      to: t.to,
      apply_styles: t.apply_styles || {},
    })),
  };
}

export function registerAnimationTools(server: McpServer) {
  server.tool(
    'add_animation',
    `Add a curated animation to a layer using one of YCode's preset patterns.

Presets cover ~80% of animation needs. Use set_layer_interactions for full GSAP control.

PRESETS:
- Reveal (default trigger scroll-into-view): fade-in, fade-in-up, fade-in-down,
  fade-in-left, fade-in-right, scale-in
- Hover (forced trigger hover): hover-lift, hover-scale, hover-fade, hover-color
- Click (forced trigger click): click-pulse, click-shake
- Scroll (forced trigger while-scrolling, scrubbed by scroll position): parallax-up, parallax-down
- Stagger (default trigger scroll-into-view): scroll-reveal-stagger (one tween per target,
  offset by options.stagger seconds — pass multiple targets!)
- Loop (default trigger load, infinite): loop-bounce, loop-pulse, loop-spin

The animation is owned by layer_id but each tween can target a different layer via targets[].
This enables card-hover patterns where hovering one element animates several.

Options vary by preset:
- duration / delay / ease — work on every preset
- distance — fade-in-*, parallax-*, click-shake, loop-bounce, hover-lift (e.g. "40px", "5rem")
- scale_to — hover-scale, click-pulse, loop-pulse (e.g. 1.05)
- background_color — hover-color (hex / rgb)
- stagger — scroll-reveal-stagger (seconds between targets, default 0.1)
- repeat — override the preset's default repeat (e.g. force loop-spin to play 3 times)`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('Layer that owns the animation (and the default target)'),
      preset: presetEnum,
      trigger: triggerEnum.optional()
        .describe('Override the preset\'s default trigger. Rare — most presets have the right trigger baked in.'),
      targets: z.array(z.string()).optional()
        .describe('Layers the tweens animate. Defaults to [layer_id]. Pass multiple for card-hover patterns or scroll-reveal-stagger.'),
      options: z.object({
        duration: z.number().optional(),
        delay: z.number().optional(),
        distance: z.string().optional().describe('CSS length (e.g. "40px", "5rem", "20%")'),
        ease: easeEnum.optional(),
        scale_to: z.number().optional(),
        background_color: z.string().optional(),
        stagger: z.number().optional(),
        repeat: z.number().optional(),
      }).optional(),
    },
    async ({ page_id, layer_id, preset, trigger, targets, options }) => {
      const layers = await getPageLayers(page_id);
      const owner = findLayerById(layers, layer_id);
      if (!owner) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      if (targets && targets.length > 0) {
        for (const targetId of targets) {
          if (!findLayerById(layers, targetId)) {
            return { content: [{ type: 'text' as const, text: `Error: Target layer "${targetId}" not found.` }], isError: true };
          }
        }
      }

      const interaction = buildInteractionFromPreset({
        preset,
        ownerLayerId: layer_id,
        trigger,
        targets,
        options,
      });

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        interactions: [...(l.interactions || []), interaction],
      }));

      await savePageLayers(page_id, updated);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Added "${preset}" animation to "${owner.customName || owner.name}"`,
            interaction_id: interaction.id,
            tween_count: interaction.tweens.length,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'list_layer_animations',
    'List all animations attached to a layer with their triggers and tween summaries.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
    },
    async ({ page_id, layer_id }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      const interactions = (layer.interactions || []).map((i) => ({
        id: i.id,
        trigger: i.trigger,
        timeline: i.timeline,
        tween_count: i.tweens.length,
        targets: Array.from(new Set(i.tweens.map((t) => t.layer_id))),
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(interactions, null, 2) }] };
    },
  );

  server.tool(
    'remove_layer_animation',
    'Remove a single animation from a layer by its interaction ID.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      interaction_id: z.string().describe('The interaction ID to remove'),
    },
    async ({ page_id, layer_id, interaction_id }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      const existing = layer.interactions || [];
      const next = existing.filter((i) => i.id !== interaction_id);
      if (next.length === existing.length) {
        return { content: [{ type: 'text' as const, text: `Error: Interaction "${interaction_id}" not found on this layer.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => ({ ...l, interactions: next }));
      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Removed interaction "${interaction_id}"` }] };
    },
  );

  server.tool(
    'clear_layer_animations',
    'Remove all animations from a layer.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
    },
    async ({ page_id, layer_id }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      const removed = (layer.interactions || []).length;
      const updated = updateLayerById(layers, layer_id, (l) => ({ ...l, interactions: [] }));
      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Cleared ${removed} animation(s) from "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'set_layer_interactions',
    `Raw escape hatch: replace a layer's entire \`interactions\` array with the full LayerInteraction
shape. Use when add_animation's presets aren't expressive enough — custom timelines,
exotic eases, per-property apply_styles, multi-target stagger compositions, etc.

Refer to ycode://reference/animation-presets for the preset catalog and trigger semantics.

Each interaction has:
- trigger: click | hover | scroll-into-view | while-scrolling | load
- timeline: { breakpoints, repeat, yoyo, scrollStart?, scrollEnd?, scrub?, toggleActions? }
- tweens: [{ layer_id, position, duration, ease, from, to, apply_styles? }]

Tween value formats:
- x/y/width/height/distance: "100px", "50%", "5rem"
- scale: "1", "1.05" (no unit)
- rotation/skewX/skewY: "45deg", "-90deg"
- autoAlpha (opacity): "0" to "100" (no % suffix)
- backgroundColor: "#ffffff" or "rgb(0,0,0)"
- display: "visible" | "hidden"

position can be a number (seconds), ">" (after previous), or "<" (with previous).`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      interactions: z.array(interactionSchema)
        .describe('Replaces the entire interactions array. Pass [] to clear (or use clear_layer_animations).'),
    },
    async ({ page_id, layer_id, interactions }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const normalized = interactions.map(ensureIds);

      const updated = updateLayerById(layers, layer_id, (l) => ({ ...l, interactions: normalized }));
      await savePageLayers(page_id, updated);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Set ${normalized.length} interaction(s) on "${layer.customName || layer.name}"`,
            interaction_ids: normalized.map((i) => i.id),
          }, null, 2),
        }],
      };
    },
  );
}
