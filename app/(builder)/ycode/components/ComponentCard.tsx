'use client';

/** Reusable component card with thumbnail and name. */

import React from 'react';
import Image from 'next/image';
import Icon from '@/components/ui/icon';
import { DEFAULT_ASSETS } from '@/lib/asset-constants';
import { cn } from '@/lib/utils';
import type { Component } from '@/types';

interface ComponentCardProps {
  component: Component;
  onClick?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  /** Optional actions rendered to the right of the name (e.g. dropdown menu) */
  actions?: React.ReactNode;
  className?: string;
  /** Triggered by double-clicking the name (e.g. to start renaming) */
  onStartRename?: () => void;
}

export default function ComponentCard({
  component,
  onClick,
  onMouseDown,
  disabled = false,
  actions,
  className,
  onStartRename,
}: ComponentCardProps) {
  return (
    <div className={cn('group flex flex-col gap-1.5', className)}>
      <button
        type="button"
        className={cn(
          'flex flex-col items-start p-1.5 overflow-hidden rounded-[10px] border border-border bg-secondary text-left transition-opacity hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
          onMouseDown && 'cursor-grab active:cursor-grabbing select-none',
        )}
        onClick={onMouseDown ? undefined : onClick}
        onMouseDown={onMouseDown}
        disabled={disabled}
      >
        <Image
          src={
            component.thumbnail_url
              ? `${component.thumbnail_url}?v=${new Date(component.updated_at).getTime()}`
              : DEFAULT_ASSETS.IMAGE
          }
          alt={component.name}
          width={640}
          height={262}
          unoptimized
          loading="eager"
          className="object-contain w-full h-full rounded pointer-events-none"
        />
      </button>
      <div className="flex items-center gap-1 px-0.5 min-w-0">
        <Icon name="component" className="size-3 shrink-0 text-muted-foreground" />
        <span
          className="flex-1 truncate text-xs font-medium"
          title={component.name}
          onDoubleClick={onStartRename}
        >
          {component.name}
        </span>
        {actions}
      </div>
    </div>
  );
}
