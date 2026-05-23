/**
 * Animation preset library for the MCP `add_animation` tool.
 *
 * Each preset produces a fully-formed `LayerInteraction` so agents can ship
 * "fade these cards in on scroll" in one tool call instead of hand-rolling a
 * GSAP timeline.
 *
 * Power users that need full control can bypass the presets and call
 * `set_layer_interactions` with the raw shape.
 */

import type {
  InteractionApplyStyles,
  InteractionTimeline,
  InteractionTween,
  LayerInteraction,
  TweenProperties,
  TweenPropertyKey,
} from '@/types';
import { generateId } from '@/lib/utils';

export const ANIMATION_PRESETS = [
  'fade-in',
  'fade-in-up',
  'fade-in-down',
  'fade-in-left',
  'fade-in-right',
  'scale-in',
  'hover-lift',
  'hover-scale',
  'hover-fade',
  'hover-color',
  'click-pulse',
  'click-shake',
  'parallax-up',
  'parallax-down',
  'scroll-reveal-stagger',
  'loop-bounce',
  'loop-pulse',
  'loop-spin',
] as const;

export type AnimationPreset = (typeof ANIMATION_PRESETS)[number];

export type AnimationTrigger =
  | 'click'
  | 'hover'
  | 'scroll-into-view'
  | 'while-scrolling'
  | 'load';

export const ANIMATION_EASES = [
  'none',
  'power1.in',
  'power1.inOut',
  'power1.out',
  'back.in',
  'back.inOut',
  'back.out',
] as const;

export type AnimationEase = (typeof ANIMATION_EASES)[number];

export interface AnimationPresetOptions {
  /** Tween duration in seconds. Preset provides a sensible default. */
  duration?: number;
  /** Delay before the animation starts (seconds). Defaults to 0. */
  delay?: number;
  /**
   * For slide / parallax presets: how far the element travels.
   * Accepts any CSS length (e.g. "40px", "5rem", "20%").
   */
  distance?: string;
  /** Curated GSAP ease. Defaults per preset family. */
  ease?: AnimationEase;
  /** For scale presets: the target scale value (e.g. 1.05). */
  scale_to?: number;
  /** For hover-color: the background color to fade into. */
  background_color?: string;
  /** For scroll-reveal-stagger: seconds between consecutive targets. Defaults 0.1. */
  stagger?: number;
  /**
   * For loop presets: how many times to repeat. -1 = infinite (default for loop-*),
   * 1 = play once and reverse once (click-pulse default).
   */
  repeat?: number;
}

interface PresetMeta {
  /** Default trigger if the caller doesn't override. */
  defaultTrigger: AnimationTrigger;
  /** Default duration in seconds. */
  defaultDuration: number;
  /** Default ease. */
  defaultEase: AnimationEase;
  /** Whether the `from` properties should be applied on load (prevents FOUC). */
  applyFromOnLoad: boolean;
  /** Build the tween from/to for one target. */
  buildTween: (opts: AnimationPresetOptions) => Pick<InteractionTween, 'from' | 'to'>;
  /** Per-property apply_styles override. */
  applyStyles?: (opts: AnimationPresetOptions) => InteractionApplyStyles;
  /**
   * Optional: emit multiple tweens per target instead of one (e.g. click-shake).
   * Each entry receives the layer_id and a position (GSAP timeline position).
   */
  multiStep?: (opts: AnimationPresetOptions) => Array<{
    from: TweenProperties;
    to: TweenProperties;
    duration: number;
    position: number | string;
  }>;
  /** Extra timeline overrides (repeat / yoyo / scrub / scrollStart). */
  timeline?: Partial<InteractionTimeline>;
}

const REVEAL_OPACITY_FROM = '0';
const REVEAL_OPACITY_TO = '100';

const PRESETS: Record<AnimationPreset, PresetMeta> = {
  'fade-in': {
    defaultTrigger: 'scroll-into-view',
    defaultDuration: 0.6,
    defaultEase: 'power1.out',
    applyFromOnLoad: true,
    buildTween: () => ({
      from: { autoAlpha: REVEAL_OPACITY_FROM },
      to: { autoAlpha: REVEAL_OPACITY_TO },
    }),
  },
  'fade-in-up': {
    defaultTrigger: 'scroll-into-view',
    defaultDuration: 0.6,
    defaultEase: 'power1.out',
    applyFromOnLoad: true,
    buildTween: (opts) => ({
      from: { autoAlpha: REVEAL_OPACITY_FROM, y: opts.distance || '40px' },
      to: { autoAlpha: REVEAL_OPACITY_TO, y: '0px' },
    }),
  },
  'fade-in-down': {
    defaultTrigger: 'scroll-into-view',
    defaultDuration: 0.6,
    defaultEase: 'power1.out',
    applyFromOnLoad: true,
    buildTween: (opts) => ({
      from: { autoAlpha: REVEAL_OPACITY_FROM, y: `-${stripSign(opts.distance || '40px')}` },
      to: { autoAlpha: REVEAL_OPACITY_TO, y: '0px' },
    }),
  },
  'fade-in-left': {
    defaultTrigger: 'scroll-into-view',
    defaultDuration: 0.6,
    defaultEase: 'power1.out',
    applyFromOnLoad: true,
    buildTween: (opts) => ({
      from: { autoAlpha: REVEAL_OPACITY_FROM, x: opts.distance || '40px' },
      to: { autoAlpha: REVEAL_OPACITY_TO, x: '0px' },
    }),
  },
  'fade-in-right': {
    defaultTrigger: 'scroll-into-view',
    defaultDuration: 0.6,
    defaultEase: 'power1.out',
    applyFromOnLoad: true,
    buildTween: (opts) => ({
      from: { autoAlpha: REVEAL_OPACITY_FROM, x: `-${stripSign(opts.distance || '40px')}` },
      to: { autoAlpha: REVEAL_OPACITY_TO, x: '0px' },
    }),
  },
  'scale-in': {
    defaultTrigger: 'scroll-into-view',
    defaultDuration: 0.6,
    defaultEase: 'back.out',
    applyFromOnLoad: true,
    buildTween: () => ({
      from: { autoAlpha: REVEAL_OPACITY_FROM, scale: '0.85' },
      to: { autoAlpha: REVEAL_OPACITY_TO, scale: '1' },
    }),
  },
  'hover-lift': {
    defaultTrigger: 'hover',
    defaultDuration: 0.3,
    defaultEase: 'power1.out',
    applyFromOnLoad: false,
    buildTween: (opts) => ({
      from: { y: '0px' },
      to: { y: `-${stripSign(opts.distance || '8px')}` },
    }),
  },
  'hover-scale': {
    defaultTrigger: 'hover',
    defaultDuration: 0.3,
    defaultEase: 'power1.out',
    applyFromOnLoad: false,
    buildTween: (opts) => ({
      from: { scale: '1' },
      to: { scale: String(opts.scale_to ?? 1.05) },
    }),
  },
  'hover-fade': {
    defaultTrigger: 'hover',
    defaultDuration: 0.3,
    defaultEase: 'power1.out',
    applyFromOnLoad: false,
    buildTween: () => ({
      from: { autoAlpha: '100' },
      to: { autoAlpha: '70' },
    }),
  },
  'hover-color': {
    defaultTrigger: 'hover',
    defaultDuration: 0.3,
    defaultEase: 'power1.out',
    applyFromOnLoad: false,
    buildTween: (opts) => ({
      from: { backgroundColor: '#ffffff' },
      to: { backgroundColor: opts.background_color || '#000000' },
    }),
  },
  'click-pulse': {
    defaultTrigger: 'click',
    defaultDuration: 0.15,
    defaultEase: 'power1.out',
    applyFromOnLoad: false,
    buildTween: (opts) => ({
      from: { scale: '1' },
      to: { scale: String(opts.scale_to ?? 1.1) },
    }),
    timeline: { repeat: 1, yoyo: true },
  },
  'click-shake': {
    defaultTrigger: 'click',
    defaultDuration: 0.05,
    defaultEase: 'power1.inOut',
    applyFromOnLoad: false,
    buildTween: () => ({ from: { x: '0px' }, to: { x: '0px' } }),
    multiStep: (opts) => {
      const dist = stripSign(opts.distance || '10px');
      const step = opts.duration ?? 0.05;
      return [
        { from: { x: '0px' }, to: { x: `-${dist}` }, duration: step, position: 0 },
        { from: { x: `-${dist}` }, to: { x: dist }, duration: step, position: '>' },
        { from: { x: dist }, to: { x: `-${dist}` }, duration: step, position: '>' },
        { from: { x: `-${dist}` }, to: { x: dist }, duration: step, position: '>' },
        { from: { x: dist }, to: { x: '0px' }, duration: step, position: '>' },
      ];
    },
  },
  'parallax-up': {
    defaultTrigger: 'while-scrolling',
    defaultDuration: 1,
    defaultEase: 'none',
    applyFromOnLoad: false,
    buildTween: (opts) => ({
      from: { y: '0px' },
      to: { y: `-${stripSign(opts.distance || '100px')}` },
    }),
    timeline: { scrub: true, scrollStart: 'top bottom', scrollEnd: 'bottom top' },
  },
  'parallax-down': {
    defaultTrigger: 'while-scrolling',
    defaultDuration: 1,
    defaultEase: 'none',
    applyFromOnLoad: false,
    buildTween: (opts) => ({
      from: { y: '0px' },
      to: { y: stripSign(opts.distance || '100px') },
    }),
    timeline: { scrub: true, scrollStart: 'top bottom', scrollEnd: 'bottom top' },
  },
  'scroll-reveal-stagger': {
    defaultTrigger: 'scroll-into-view',
    defaultDuration: 0.6,
    defaultEase: 'power1.out',
    applyFromOnLoad: true,
    buildTween: (opts) => ({
      from: { autoAlpha: REVEAL_OPACITY_FROM, y: opts.distance || '24px' },
      to: { autoAlpha: REVEAL_OPACITY_TO, y: '0px' },
    }),
  },
  'loop-bounce': {
    defaultTrigger: 'load',
    defaultDuration: 1.5,
    defaultEase: 'power1.inOut',
    applyFromOnLoad: true,
    buildTween: (opts) => ({
      from: { y: '0px' },
      to: { y: `-${stripSign(opts.distance || '10px')}` },
    }),
    timeline: { repeat: -1, yoyo: true },
  },
  'loop-pulse': {
    defaultTrigger: 'load',
    defaultDuration: 1.5,
    defaultEase: 'power1.inOut',
    applyFromOnLoad: true,
    buildTween: (opts) => ({
      from: { scale: '1' },
      to: { scale: String(opts.scale_to ?? 1.05) },
    }),
    timeline: { repeat: -1, yoyo: true },
  },
  'loop-spin': {
    defaultTrigger: 'load',
    defaultDuration: 4,
    defaultEase: 'none',
    applyFromOnLoad: true,
    buildTween: () => ({
      from: { rotation: '0deg' },
      to: { rotation: '360deg' },
    }),
    timeline: { repeat: -1, yoyo: false },
  },
};

export interface BuildInteractionInput {
  preset: AnimationPreset;
  /** Owning layer ID — used as the default tween target. */
  ownerLayerId: string;
  /** Override the preset's default trigger. */
  trigger?: AnimationTrigger;
  /** Layers the tweens act on. Defaults to [ownerLayerId]. */
  targets?: string[];
  options?: AnimationPresetOptions;
}

/**
 * Build a complete `LayerInteraction` (with fresh IDs) from a preset key.
 * Returns the interaction ready to be appended to `layer.interactions`.
 */
export function buildInteractionFromPreset(input: BuildInteractionInput): LayerInteraction {
  const meta = PRESETS[input.preset];
  if (!meta) {
    throw new Error(`Unknown animation preset "${input.preset}"`);
  }

  const opts: AnimationPresetOptions = input.options || {};
  const trigger: AnimationTrigger = input.trigger || meta.defaultTrigger;
  const targets = input.targets && input.targets.length > 0 ? input.targets : [input.ownerLayerId];
  const duration = opts.duration ?? meta.defaultDuration;
  const ease = opts.ease ?? meta.defaultEase;
  const stagger = opts.stagger ?? 0.1;
  const delay = opts.delay ?? 0;

  const tweens: InteractionTween[] = [];

  for (let targetIdx = 0; targetIdx < targets.length; targetIdx++) {
    const targetId = targets[targetIdx];
    const basePosition = computeBasePosition({
      preset: input.preset,
      targetIdx,
      stagger,
      delay,
    });

    if (meta.multiStep) {
      const steps = meta.multiStep({ ...opts, duration: opts.duration });
      for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
        const step = steps[stepIdx];
        tweens.push({
          id: generateId('twn'),
          layer_id: targetId,
          position: stepIdx === 0 ? basePosition : step.position,
          duration: step.duration,
          ease,
          from: step.from,
          to: step.to,
          apply_styles: buildApplyStyles(step.from, meta.applyFromOnLoad),
        });
      }
      continue;
    }

    const { from, to } = meta.buildTween(opts);
    tweens.push({
      id: generateId('twn'),
      layer_id: targetId,
      position: basePosition,
      duration,
      ease,
      from,
      to,
      apply_styles: meta.applyStyles ? meta.applyStyles(opts) : buildApplyStyles(from, meta.applyFromOnLoad),
    });
  }

  const timeline: InteractionTimeline = {
    breakpoints: ['desktop', 'tablet', 'mobile'],
    repeat: 0,
    yoyo: false,
    ...(trigger === 'scroll-into-view' && { toggleActions: 'play none none none' }),
    ...meta.timeline,
    ...(opts.repeat !== undefined && { repeat: opts.repeat }),
  };

  return {
    id: generateId('int'),
    trigger,
    timeline,
    tweens,
  };
}

/**
 * Compute the GSAP position string / number for the first tween of a target.
 * For stagger presets this offsets each target; otherwise just the delay.
 */
function computeBasePosition(args: {
  preset: AnimationPreset;
  targetIdx: number;
  stagger: number;
  delay: number;
}): number | string {
  if (args.preset === 'scroll-reveal-stagger') {
    return args.delay + args.targetIdx * args.stagger;
  }
  return args.delay;
}

/** Mark every property present in `from` so the runtime knows whether to pre-apply it. */
function buildApplyStyles(from: TweenProperties, applyOnLoad: boolean): InteractionApplyStyles {
  const styles: InteractionApplyStyles = {};
  const mode = applyOnLoad ? 'on-load' : 'on-trigger';
  for (const key of Object.keys(from) as TweenPropertyKey[]) {
    if (from[key] !== undefined && from[key] !== null) {
      styles[key] = mode;
    }
  }
  return styles;
}

/** Strip a leading "-" so callers can pass "-40px" or "40px" interchangeably for distance. */
function stripSign(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

const PRESET_DESCRIPTIONS: Record<AnimationPreset, string> = {
  'fade-in': 'Fades from invisible to fully opaque. Most common reveal.',
  'fade-in-up': 'Fades in while sliding up from below (distance default 40px).',
  'fade-in-down': 'Fades in while sliding down from above.',
  'fade-in-left': 'Fades in while sliding left from off-screen right.',
  'fade-in-right': 'Fades in while sliding right from off-screen left.',
  'scale-in': 'Fades in while scaling up from 0.85. Uses back.out for a slight overshoot.',
  'hover-lift': 'Subtle upward translation on hover (default -8px).',
  'hover-scale': 'Scales up on hover (default 1.05).',
  'hover-fade': 'Fades to 70% opacity on hover.',
  'hover-color': 'Animates background color on hover (pass background_color).',
  'click-pulse': 'Scales up then back on click (yoyo). Adjust with scale_to.',
  'click-shake': 'Horizontal shake of 5 micro-tweens (distance default 10px).',
  'parallax-up': 'Scroll-scrubbed upward translation. Use on hero images / decorative bg.',
  'parallax-down': 'Scroll-scrubbed downward translation.',
  'scroll-reveal-stagger': 'fade-in-up applied to multiple targets with a stagger offset (default 0.1s between targets).',
  'loop-bounce': 'Infinite vertical bounce. Use on small ornamental elements.',
  'loop-pulse': 'Infinite scale pulse.',
  'loop-spin': 'Infinite 360° rotation. Linear ease, no yoyo.',
};

/** Public preset catalog for the reference resource. */
export const PRESET_CATALOG = ANIMATION_PRESETS.map((key) => ({
  key,
  default_trigger: PRESETS[key].defaultTrigger,
  default_duration: PRESETS[key].defaultDuration,
  default_ease: PRESETS[key].defaultEase,
  description: PRESET_DESCRIPTIONS[key],
}));
