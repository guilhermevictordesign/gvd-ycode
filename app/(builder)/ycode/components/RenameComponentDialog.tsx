'use client';

/**
 * Rename Component Dialog
 *
 * Dialog for renaming an existing component. Mirrors CreateComponentDialog.
 */

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface RenameComponentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (componentName: string) => void;
  currentName?: string;
}

export default function RenameComponentDialog({
  open,
  onOpenChange,
  onConfirm,
  currentName,
}: RenameComponentDialogProps) {
  const [componentName, setComponentName] = useState(currentName || '');

  // Sync the input with the component being renamed each time the dialog opens
  useEffect(() => {
    if (open) setComponentName(currentName || '');
  }, [open, currentName]);

  const handleConfirm = () => {
    if (!componentName.trim()) return;

    // Persist optimistically and close immediately — the store updates the
    // name in place and rolls back if the request fails.
    onConfirm(componentName.trim());
    onOpenChange(false);
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && componentName.trim()) {
      handleConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width="320px"
        className="gap-0"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Rename component</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4.5">
          <div className="flex flex-col gap-2">
            <Input
              id="component-name"
              placeholder="Name"
              value={componentName}
              onChange={(e) => setComponentName(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </div>

          <DialogFooter className="grid grid-cols-2 mt-1">
            <Button
              variant="secondary"
              onClick={handleCancel}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!componentName.trim()}
            >
              Rename
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
