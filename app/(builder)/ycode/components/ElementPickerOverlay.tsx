'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useEditorStore } from '@/stores/useEditorStore';

interface HoveredElement {
  layerId: string;
  rect: { left: number; top: number; width: number; height: number };
  isValid: boolean;
}

interface ElementPickerOverlayProps {
  iframeElement: HTMLIFrameElement | null;
  zoom: number;
}

export default function ElementPickerOverlay({ iframeElement, zoom }: ElementPickerOverlayProps) {
  const elementPicker = useEditorStore((state) => state.elementPicker);
  const stopElementPicker = useEditorStore((state) => state.stopElementPicker);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [hoveredElement, setHoveredElement] = useState<HoveredElement | null>(null);
  const overlayRef = useRef<SVGSVGElement>(null);

  const origin = elementPicker?.originPosition;
  const validate = elementPicker?.validate;
  const scale = zoom / 100;

  const findLayerInIframe = useCallback((iframeX: number, iframeY: number): HoveredElement | null => {
    if (!iframeElement) return null;
    const iframeDoc = iframeElement.contentDocument;
    if (!iframeDoc) return null;

    const el = iframeDoc.elementFromPoint(iframeX, iframeY);
    if (!el) return null;

    let current: HTMLElement | null = el as HTMLElement;
    while (current) {
      const layerId = current.getAttribute('data-layer-id');
      if (layerId) {
        const localRect = current.getBoundingClientRect();
        const iframeRect = iframeElement.getBoundingClientRect();
        const screenRect = {
          left: iframeRect.left + localRect.left * scale,
          top: iframeRect.top + localRect.top * scale,
          width: localRect.width * scale,
          height: localRect.height * scale,
        };
        const isValid = validate ? validate(layerId) : true;
        return { layerId, rect: screenRect, isValid };
      }
      current = current.parentElement;
    }
    return null;
  }, [iframeElement, validate, scale]);

  const findLayerInParent = useCallback((clientX: number, clientY: number): HoveredElement | null => {
    const overlay = overlayRef.current;
    if (overlay) overlay.style.pointerEvents = 'none';
    const el = document.elementFromPoint(clientX, clientY);
    if (overlay) overlay.style.pointerEvents = '';

    if (!el) return null;

    let current: HTMLElement | null = el as HTMLElement;
    while (current) {
      const layerId = current.getAttribute('data-layer-id');
      if (layerId) {
        const rect = current.getBoundingClientRect();
        const isValid = validate ? validate(layerId) : true;
        return { layerId, rect, isValid };
      }
      current = current.parentElement;
    }
    return null;
  }, [validate]);

  // Parent window event listeners
  useEffect(() => {
    if (!elementPicker?.active) return;

    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
      const found = findLayerInParent(e.clientX, e.clientY);
      setHoveredElement(found);
    };

    const handleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const found = findLayerInParent(e.clientX, e.clientY);
      if (found && found.isValid && elementPicker.onSelect) {
        elementPicker.onSelect(found.layerId);
      } else {
        toast.error('Please select an input element inside a Filter form.');
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // Stop other global Esc handlers (e.g. "select parent layer") from
        // also reacting while the picker is being cancelled.
        e.stopImmediatePropagation();
        stopElementPicker();
      }
    };

    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('click', handleClick, true);
    window.addEventListener('keydown', handleEscape, true);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove, true);
      window.removeEventListener('click', handleClick, true);
      window.removeEventListener('keydown', handleEscape, true);
    };
  }, [elementPicker?.active, elementPicker?.onSelect, findLayerInParent, stopElementPicker]);

  // Iframe event listeners
  useEffect(() => {
    if (!elementPicker?.active || !iframeElement) return;
    const iframeDoc = iframeElement.contentDocument;
    if (!iframeDoc) return;

    const handleMouseMove = (e: MouseEvent) => {
      const iframeRect = iframeElement.getBoundingClientRect();
      const screenX = iframeRect.left + e.clientX * scale;
      const screenY = iframeRect.top + e.clientY * scale;
      setMousePos({ x: screenX, y: screenY });
      const found = findLayerInIframe(e.clientX, e.clientY);
      setHoveredElement(found);
    };

    const handleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const found = findLayerInIframe(e.clientX, e.clientY);
      if (found && found.isValid && elementPicker.onSelect) {
        elementPicker.onSelect(found.layerId);
      } else {
        toast.error('Please select an input element inside a Filter form.');
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        stopElementPicker();
      }
    };

    iframeDoc.addEventListener('mousemove', handleMouseMove, true);
    iframeDoc.addEventListener('click', handleClick, true);
    iframeDoc.addEventListener('keydown', handleEscape, true);
    iframeDoc.body.style.cursor = 'crosshair';

    return () => {
      iframeDoc.removeEventListener('mousemove', handleMouseMove, true);
      iframeDoc.removeEventListener('click', handleClick, true);
      iframeDoc.removeEventListener('keydown', handleEscape, true);
      iframeDoc.body.style.cursor = '';
    };
  }, [elementPicker?.active, elementPicker?.onSelect, iframeElement, scale, findLayerInIframe, stopElementPicker]);

  // Reset state when picker deactivates
  useEffect(() => {
    if (!elementPicker?.active) {
      setMousePos(null);
      setHoveredElement(null);
    }
  }, [elementPicker?.active]);

  if (!elementPicker?.active || !origin || !mousePos) return null;

  const snapToTarget = hoveredElement?.isValid;
  const endX = snapToTarget
    ? hoveredElement!.rect.left + hoveredElement!.rect.width / 2
    : mousePos.x;
  const endY = snapToTarget
    ? hoveredElement!.rect.top + hoveredElement!.rect.height / 2
    : mousePos.y;

  const dx = endX - origin.x;
  const curveOffset = Math.max(32, Math.min(140, Math.abs(dx) * 0.25));
  const cp1x = origin.x + dx * 0.35;
  const cp1y = origin.y - curveOffset;
  const cp2x = endX - dx * 0.35;
  const cp2y = endY - curveOffset;
  const pathD = `M ${origin.x} ${origin.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;

  const highlightColor = hoveredElement?.isValid ? '#2dd4bf' : '#2dd4bf';
  const highlightFill = hoveredElement?.isValid ? 'rgba(45, 212, 191, 0.1)' : 'rgba(45, 212, 191, 0.1)';

  return (
    <svg
      ref={overlayRef}
      className="fixed inset-0 z-[9999] pointer-events-none"
      style={{ width: '100vw', height: '100vh', cursor: 'crosshair' }}
    >
      {/* Bezier connector line */}
      <path
        d={pathD}
        fill="none"
        stroke="#2dd4bf"
        strokeWidth={1.25}
        strokeLinecap="round"
      />

      {/* Origin dot */}
      <circle
        cx={origin.x} cy={origin.y}
        r={5} fill="#2dd4bf"
      />

      {/* Crosshair icon at end of line */}
      <g transform={`translate(${endX - 8}, ${endY - 8})`}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <path
            d="M6.455 1v1.026a4.002 4.002 0 013.52 3.52H11v.909H9.974a4.002 4.002 0 01-3.52 3.52V11h-.909V9.974a4.002 4.002 0 01-3.52-3.52H1v-.909h1.026a4.002 4.002 0 013.52-3.52V1h.909zM6 3a3 3 0 100 6 3 3 0 000-6zm0 2a1 1 0 110 2 1 1 0 010-2z"
            fill={highlightColor}
          />
        </svg>
      </g>

      {/* Hover highlight on any layer */}
      {hoveredElement && (
        <rect
          x={hoveredElement.rect.left - 1}
          y={hoveredElement.rect.top - 1}
          width={hoveredElement.rect.width + 2}
          height={hoveredElement.rect.height + 2}
          rx={4}
          fill={highlightFill}
          stroke={highlightColor}
          strokeWidth={1}
        />
      )}
    </svg>
  );
}
