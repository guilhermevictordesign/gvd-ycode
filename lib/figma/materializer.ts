'use client';

/**
 * Figma Materializer
 *
 * Paste-time helper that turns the design-system metadata carried in a Figma
 * payload (v3) into real, persisted Ycode entities: color variables, layer
 * styles, and components. Each entity is created at most once per import via an
 * in-flight promise cache, so the parallel converter can request the same
 * entity from multiple nodes without creating duplicates.
 */

import type { Component, Layer, LayerStyle } from '@/types';
import { useLayerStylesStore } from '@/stores/useLayerStylesStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useColorVariablesStore } from '@/stores/useColorVariablesStore';

export interface MaterializationSummary {
  colorVariables: number;
  layerStyles: number;
  components: number;
  fonts: number;
}

export class FigmaMaterializer {
  private colorPromises = new Map<string, Promise<string | null>>();
  private stylePromises = new Map<string, Promise<LayerStyle | null>>();
  private componentPromises = new Map<string, Promise<Component | null>>();

  readonly summary: MaterializationSummary = {
    colorVariables: 0,
    layerStyles: 0,
    components: 0,
    fonts: 0,
  };

  /**
   * Create (or reuse) a color variable and return a CSS reference to it
   * (`var(--<id>)`). Keyed by name+value so identical tokens collapse.
   * Returns null on failure so callers can fall back to the literal color.
   */
  async getOrCreateColorVariableRef(name: string, value: string): Promise<string | null> {
    const key = `${name}::${value}`;
    let promise = this.colorPromises.get(key);
    if (!promise) {
      promise = (async () => {
        try {
          const created = await useColorVariablesStore.getState().createColorVariable(name, value);
          if (created?.id) {
            this.summary.colorVariables++;
            return `var(--${created.id})`;
          }
        } catch (err) {
          console.warn('[FigmaPaste] failed to create color variable', name, err);
        }
        return null;
      })();
      this.colorPromises.set(key, promise);
    }
    return promise;
  }

  /**
   * Create (or reuse) a layer style keyed by `key`. The first caller's
   * name/classes/design/group win; later callers with the same key reuse it.
   */
  async getOrCreateLayerStyle(
    key: string,
    name: string,
    classes: string,
    design?: LayerStyle['design'],
    group?: string,
  ): Promise<LayerStyle | null> {
    let promise = this.stylePromises.get(key);
    if (!promise) {
      promise = (async () => {
        // Reuse an existing style of the same name. Style names carry a
        // `name + is_published` unique constraint, so re-pasting a design whose
        // styles already exist would otherwise 500. Matching by name also makes
        // re-paste idempotent.
        const existingByName = () => useLayerStylesStore.getState().styles.find((s) => s.name === name);
        const existing = existingByName();
        if (existing) return existing;
        try {
          const created = await useLayerStylesStore.getState().createStyle(name, classes, design, group);
          if (created) {
            this.summary.layerStyles++;
            return created;
          }
          // createStyle swallows the duplicate-name error and returns null; fall
          // back to the now-present style if a parallel call created it.
          return existingByName() ?? null;
        } catch (err) {
          console.warn('[FigmaPaste] failed to create layer style', name, err);
          return existingByName() ?? null;
        }
      })();
      this.stylePromises.set(key, promise);
    }
    return promise;
  }

  /**
   * Create a component once per Figma component id. The `build` callback
   * produces the component's layer tree (and is only invoked on first request).
   */
  async createComponentOnce(
    figmaId: string,
    name: string,
    build: () => Promise<Layer[]>,
  ): Promise<Component | null> {
    let promise = this.componentPromises.get(figmaId);
    if (!promise) {
      promise = (async () => {
        try {
          const layers = await build();
          if (!layers.length) return null;
          const created = await useComponentsStore.getState().createComponent(name, layers);
          if (created) this.summary.components++;
          else console.warn('[FigmaPaste] createComponent returned null for', name);
          return created;
        } catch (err) {
          console.warn('[FigmaPaste] failed to create component', name, err);
          return null;
        }
      })();
      this.componentPromises.set(figmaId, promise);
    }
    return promise;
  }

  noteFontInstalled(count: number) {
    this.summary.fonts += count;
  }
}
