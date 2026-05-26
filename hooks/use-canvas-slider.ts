'use client';

/**
 * Hook to initialize Swiper on slider layers in the canvas editor.
 * Provides slide navigation when selecting slide layers in the layers panel.
 *
 * Swiper CSS is loaded via CDN in Canvas.tsx (same pattern as GSAP).
 * Swiper JS is bundled and initialized here per-slider instance.
 */

import { useEffect, useRef, useMemo, useState } from 'react';
import Swiper from 'swiper';
import type { Layer, SliderSettings } from '@/types';
import { useEditorStore } from '@/stores/useEditorStore';
import { DEFAULT_SLIDER_SETTINGS } from '@/lib/slider-constants';
import { buildCanvasSwiperOptions, applySwiperEasing } from '@/lib/slider-utils';

/**
 * Count the real (non-duplicate) swiper-slide DOM children inside the
 * given slider element. Used to detect when collection-backed slides
 * arrive after the initial Swiper init, so we can recreate Swiper with
 * the right slide count (and avoid the "not enough slides for loop" warning).
 */
function countRealSlides(sliderEl: HTMLElement): number {
  const wrapper = sliderEl.querySelector('.swiper-wrapper');
  if (!wrapper) return 0;
  return wrapper.querySelectorAll(
    ':scope > .swiper-slide:not(.swiper-slide-duplicate)',
  ).length;
}

/** Registry of active Swiper instances and their layer refs */
const swiperRegistry = new Map<string, { swiper: Swiper; layerRef: React.RefObject<Layer> }>();

/** Tracks the intended target index per slider during rapid navigation */
const targetIndex = new Map<string, number>();

/**
 * Find the Swiper slide index for a layer by querying the DOM.
 * Needed because collection layers expand into multiple DOM slides,
 * so layer-tree indices don't map 1:1 to Swiper slide indices.
 */
function findSlideIndexInDom(swiperEl: HTMLElement, swiper: Swiper, layerId: string): number {
  const layerEl = swiperEl.querySelector(`[data-layer-id="${layerId}"]`);
  if (!layerEl) return -1;

  let current: HTMLElement | null = layerEl as HTMLElement;
  while (current && current !== swiperEl) {
    if (current.classList.contains('swiper-slide')) {
      return Array.from(swiper.slides).indexOf(current);
    }
    current = current.parentElement;
  }
  return -1;
}

function navigateAndSelect(sliderLayerId: string, direction: 'prev' | 'next') {
  const entry = swiperRegistry.get(sliderLayerId);
  if (!entry) return;
  const { swiper } = entry;
  const totalSlides = swiper.slides.length;
  if (!totalSlides) return;

  const current = targetIndex.get(sliderLayerId) ?? swiper.realIndex;
  const next = direction === 'prev'
    ? (current - 1 + totalSlides) % totalSlides
    : (current + 1) % totalSlides;
  targetIndex.set(sliderLayerId, next);

  swiper.slideTo(next);

  const slideEl = swiper.slides[next] as HTMLElement | undefined;
  const layerId = slideEl?.getAttribute('data-layer-id');
  if (layerId) {
    useEditorStore.getState().setSelectedLayerId(layerId);
  }
}

/** Navigate to the previous slide and select it */
export function slidePrev(sliderLayerId: string) {
  navigateAndSelect(sliderLayerId, 'prev');
}

/** Navigate to the next slide and select it */
export function slideNext(sliderLayerId: string) {
  navigateAndSelect(sliderLayerId, 'next');
}

/**
 * Initializes Swiper on the canvas for a slider layer and navigates
 * to the correct slide when a slide or its descendant is selected.
 *
 * No-op when `layer.name !== 'slider'` or `isEditMode` is false.
 */
export function useCanvasSlider(
  elementRef: React.RefObject<HTMLElement | null>,
  layer: Layer,
  isEditMode: boolean,
) {
  const swiperRef = useRef<Swiper | null>(null);
  const layerRef = useRef(layer);

  useEffect(() => {
    layerRef.current = layer;
  });

  const isSlider = isEditMode && layer.name === 'slider';

  const settings: SliderSettings = { ...DEFAULT_SLIDER_SETTINGS, ...layer.settings?.slider };
  const settingsKey = useMemo(
    () => `${settings.animationEffect}-${settings.duration}-${settings.easing}-${settings.groupSlide}-${settings.slidesPerGroup}-${settings.centered}-${settings.paginationType}-${settings.navigation}-${settings.loop}`,
    [settings.animationEffect, settings.duration, settings.easing, settings.groupSlide, settings.slidesPerGroup, settings.centered, settings.paginationType, settings.navigation, settings.loop],
  );

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; });

  // Track the real (non-duplicate) swiper-slide count in the DOM. Collection-
  // backed slides expand asynchronously after data fetches, so the count we
  // see at first init is often 0. Within the init effect we use this only
  // through `initBucket` (below) so Swiper is recreated when transitioning
  // between "no slides", "too few for loop", and "enough" — not on every
  // single add/remove (those still go through the wrapper observer's
  // swiper.update()).
  const [slideCount, setSlideCount] = useState(0);

  useEffect(() => {
    if (!isSlider || !elementRef.current) return;
    const el = elementRef.current;

    const measure = () => setSlideCount(countRealSlides(el));
    measure();

    const ObsCtor = el.ownerDocument.defaultView?.MutationObserver;
    if (!ObsCtor) return;

    let raf: number | undefined;
    const observer = new ObsCtor(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    observer.observe(el, { childList: true, subtree: true });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [isSlider, elementRef]);

  // Bucket the slide count so we only force a Swiper reinit when transitions
  // matter (no slides → some, or insufficient → enough for loop). Within
  // the same bucket, slide add/remove is handled by swiper.update().
  // Loop requires at least `slidesPerView + slidesPerGroup` slides; with
  // slidesPerView='auto' the safest conservative threshold is 2.
  const needsLoop = settings.loop === 'loop';
  const minSlidesForLoop = Math.max(2, (settings.slidesPerGroup || 1) + 1);
  const initBucket = slideCount === 0
    ? 'empty'
    : needsLoop && slideCount < minSlidesForLoop
      ? 'too-few-for-loop'
      : 'ok';

  // Initialize / destroy Swiper when the slider mounts or settings change
  useEffect(() => {
    if (!isSlider || !elementRef.current) return;
    // Skip init when no slides exist yet (e.g. collection-backed slides
    // still loading). The slideCount effect above will bump the bucket
    // once slides arrive, retriggering this effect.
    if (initBucket === 'empty') return;

    const el = elementRef.current;

    // Create a hidden ghost element for Swiper's fraction pagination.
    // Swiper calculates the real page count and renders it here,
    // so we can read it instead of computing it manually.
    const ghostEl = document.createElement('div');
    ghostEl.style.cssText = 'position:absolute!important;color:transparent!important;z-index:-1!important;pointer-events:none!important';
    el.appendChild(ghostEl);

    const options = buildCanvasSwiperOptions(settingsRef.current, ghostEl);
    const swiper = new Swiper(el, options);
    applySwiperEasing(el, settingsRef.current.easing);

    // Read the page count from Swiper's snap grid and store it
    const { setSliderSnapCount } = useEditorStore.getState();
    const syncSnapCount = () => {
      setSliderSnapCount(layer.id, swiper.snapGrid.length);
    };
    swiper.on('update', syncSnapCount);
    requestAnimationFrame(syncSnapCount);

    // Sync nav button disabled state from Swiper's position tracking.
    // Navigation module is disabled on canvas to prevent click-to-navigate,
    // so we read isBeginning/isEnd directly and set aria-disabled manually.
    // pointer-events is kept enabled so buttons remain selectable in the editor.
    const navWrapper = layerRef.current.children?.find(c => c.name === 'slideNavigationWrapper');
    const prevLayer = navWrapper?.children?.find(c => c.name === 'slideButtonPrev');
    const nextLayer = navWrapper?.children?.find(c => c.name === 'slideButtonNext');
    const prevEl = prevLayer ? el.querySelector(`[data-layer-id="${prevLayer.id}"]`) as HTMLElement : null;
    const nextEl = nextLayer ? el.querySelector(`[data-layer-id="${nextLayer.id}"]`) as HTMLElement : null;

    const syncNavState = () => {
      const canLoop = swiper.params.loop || swiper.params.rewind;
      if (prevEl) {
        if (!canLoop && swiper.isBeginning) {
          prevEl.setAttribute('aria-disabled', 'true');
        } else {
          prevEl.removeAttribute('aria-disabled');
        }
        prevEl.style.pointerEvents = 'auto';
      }
      if (nextEl) {
        if (!canLoop && swiper.isEnd) {
          nextEl.setAttribute('aria-disabled', 'true');
        } else {
          nextEl.removeAttribute('aria-disabled');
        }
        nextEl.style.pointerEvents = 'auto';
      }
    };

    swiper.on('slideChange', syncNavState);
    requestAnimationFrame(syncNavState);

    swiperRef.current = swiper;
    swiperRegistry.set(layer.id, { swiper, layerRef });

    // Restore the selected slide after reinit (e.g. after per-view change)
    const selectedLayerId = useEditorStore.getState().selectedLayerId;
    if (selectedLayerId) {
      const slideIndex = findSlideIndexInDom(el, swiper, selectedLayerId);
      if (slideIndex > 0) {
        requestAnimationFrame(() => swiper.slideTo(slideIndex, 0));
      }
    }

    // Sync pagination state on the canvas depending on pagination type
    const isFraction = settingsRef.current.paginationType === 'fraction';

    const syncBullets = () => {
      if (isFraction) return;
      const snapCount = swiper.snapGrid.length;
      const activeSnapIdx = swiper.snapIndex ?? 0;
      const bulletTemplate = layerRef.current.children
        ?.find(c => c.name === 'slidePaginationWrapper')
        ?.children?.find(c => c.name === 'slideBullets')
        ?.children?.[0];
      if (!bulletTemplate) return;
      const bulletEls = el.querySelectorAll(`[data-layer-id="${bulletTemplate.id}"]`);
      bulletEls.forEach((b, i) => {
        if (i < snapCount && i === activeSnapIdx) {
          b.setAttribute('aria-current', 'true');
        } else {
          b.removeAttribute('aria-current');
        }
      });
    };

    const syncFraction = () => {
      if (!isFraction) return;
      const fractionLayer = layerRef.current.children
        ?.find(c => c.name === 'slidePaginationWrapper')
        ?.children?.find(c => c.name === 'slideFraction');
      if (!fractionLayer) return;
      const fractionEl = el.querySelector(`[data-layer-id="${fractionLayer.id}"]`) as HTMLElement | null;
      if (!fractionEl) return;
      const totalPages = swiper.snapGrid.length;
      const currentPage = (swiper.snapIndex ?? 0) + 1;
      fractionEl.textContent = `${currentPage} / ${totalPages}`;
    };

    const syncPagination = () => {
      syncBullets();
      syncFraction();
    };

    swiper.on('slideChange', syncPagination);
    requestAnimationFrame(syncPagination);

    const { setSliderAnimating } = useEditorStore.getState();
    swiper.on('slideChangeTransitionStart', () => setSliderAnimating(true));
    swiper.on('slideChangeTransitionEnd', () => {
      targetIndex.delete(layer.id);
      setSliderAnimating(false);
    });

    // Swiper's built-in observer uses the parent window's MutationObserver,
    // which can miss mutations in the canvas iframe's document. Use the
    // iframe's own MutationObserver to reliably detect slide changes.
    let wrapperObserver: MutationObserver | undefined;
    const wrapperEl = swiper.wrapperEl;
    if (wrapperEl) {
      const iframeWindow = wrapperEl.ownerDocument.defaultView;
      const ObsCtor = iframeWindow?.MutationObserver;
      if (ObsCtor) {
        let debounceRaf: number | undefined;
        wrapperObserver = new ObsCtor(() => {
          if (debounceRaf) cancelAnimationFrame(debounceRaf);
          debounceRaf = requestAnimationFrame(() => {
            if (swiperRef.current && !swiperRef.current.destroyed) {
              swiperRef.current.update();
            }
          });
        });
        wrapperObserver.observe(wrapperEl, { childList: true, subtree: true });
      }
    }

    return () => {
      wrapperObserver?.disconnect();
      swiperRegistry.delete(layer.id);
      swiper.destroy(true, true);
      ghostEl.remove();
      swiperRef.current = null;
      setSliderAnimating(false);
    };
  }, [isSlider, elementRef, settingsKey, layer.id, initBucket]);

  // Navigate to the slide containing the selected layer
  useEffect(() => {
    if (!isSlider) return;

    const navigateToSelected = (selectedLayerId: string | null) => {
      const swiper = swiperRef.current;
      if (!swiper || !selectedLayerId || !elementRef.current) return;

      const slideIndex = findSlideIndexInDom(elementRef.current, swiper, selectedLayerId);

      if (slideIndex >= 0 && slideIndex !== swiper.realIndex) {
        requestAnimationFrame(() => {
          swiper.update();
          swiper.slideTo(slideIndex);
        });
      } else if (slideIndex === -1) {
        // Element not in DOM yet (e.g. newly added slide). Retry after render.
        let retries = 10;
        const retry = () => {
          const sw = swiperRef.current;
          const el = elementRef.current;
          if (!sw || sw.destroyed || !el || retries-- <= 0) return;

          sw.update();
          const idx = findSlideIndexInDom(el, sw, selectedLayerId);
          if (idx >= 0) {
            sw.slideTo(idx);
          } else {
            requestAnimationFrame(retry);
          }
        };
        requestAnimationFrame(retry);
      }
    };

    // Handle initial selection (e.g. from URL layer= param)
    navigateToSelected(useEditorStore.getState().selectedLayerId);

    let prevSelectedId: string | null = useEditorStore.getState().selectedLayerId;

    const unsubscribe = useEditorStore.subscribe((state) => {
      const selectedLayerId = state.selectedLayerId;
      if (selectedLayerId === prevSelectedId) return;
      prevSelectedId = selectedLayerId;
      navigateToSelected(selectedLayerId);
    });

    return unsubscribe;
  }, [isSlider, elementRef]);
}
