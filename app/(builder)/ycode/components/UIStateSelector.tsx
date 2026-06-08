'use client';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEditorStore } from '@/stores/useEditorStore';
import { layerHasLink } from '@/lib/link-utils';
import type { UIState, Layer } from '@/types';

interface UIStateSelectorProps {
  selectedLayer: Layer | null;
}

export default function UIStateSelector({ selectedLayer }: UIStateSelectorProps) {
  const activeUIState = useEditorStore((s) => s.activeUIState);
  const setActiveUIState = useEditorStore((s) => s.setActiveUIState);

  // Determine which states are applicable for the current layer
  const isDisabledApplicable = () => {
    if (!selectedLayer) return false;
    const applicableTypes = ['button', 'input', 'textarea', 'select', 'slideButtonPrev', 'slideButtonNext'];
    return applicableTypes.includes(selectedLayer.name || '');
  };

  const isCurrentApplicable = () => {
    if (!selectedLayer) return false;
    // Any element with a link can become the "active page" element, plus the
    // built-in navigation/slider-bullet types that get aria-current at runtime.
    const applicableTypes = ['link', 'a', 'navigation', 'slideBullet'];
    return applicableTypes.includes(selectedLayer.name || '') || layerHasLink(selectedLayer);
  };

  return (
    <div className="bg-background z-30 py-3 flex flex-row gap-2">
      <Select value={activeUIState} onValueChange={(value) => setActiveUIState(value as UIState)}>
        <SelectTrigger className={`w-full ${activeUIState !== 'neutral' ? 'text-[#8dd92f]' : ''}`}>
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            <SelectItem value="neutral">Neutral</SelectItem>
            <SelectItem value="hover">Hover</SelectItem>
            <SelectItem value="focus">Focus</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="disabled" disabled={!isDisabledApplicable()}>
              Disabled
            </SelectItem>
            <SelectItem value="current" disabled={!isCurrentApplicable()}>
              Current
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
