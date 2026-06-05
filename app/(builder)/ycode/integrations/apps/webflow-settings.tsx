'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field';
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';

import { webflowApi, type WebflowCollectionPreview } from '@/lib/apps/webflow/client';
import { WEBFLOW_SETTINGS } from '@/lib/apps/webflow/constants';
import { clearStylesheetCache } from '@/lib/apps/webflow/stylesheet-cache';
import { formatRelativeTime } from '@/lib/utils';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import type { WebflowImport, WebflowSite } from '@/lib/apps/webflow/types';

// =============================================================================
// Types
// =============================================================================

interface WebflowSettingsProps {
  onDisconnect: () => void;
  onConnectionChange: (connected: boolean) => void;
  onCloseAndNavigate?: (path: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export default function WebflowSettings({
  onDisconnect,
  onConnectionChange,
  onCloseAndNavigate,
}: WebflowSettingsProps) {
  const router = useRouter();

  // Token state
  const [token, setToken] = useState('');
  const [savedToken, setSavedToken] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Sites + selection
  const [sites, setSites] = useState<WebflowSite[]>([]);
  const [isLoadingSites, setIsLoadingSites] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');

  // Collection preview
  const [preview, setPreview] = useState<WebflowCollectionPreview[] | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  // Imports + sync state
  const [imports, setImports] = useState<WebflowImport[]>([]);
  const [isMigrating, setIsMigrating] = useState(false);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [importToRemove, setImportToRemove] = useState<WebflowImport | null>(null);

  // Disconnect dialog
  const [showDisconnect, setShowDisconnect] = useState(false);

  // Design section — published site URL used to backfill global styles on paste.
  const [publishedUrl, setPublishedUrl] = useState('');
  const [savedPublishedUrl, setSavedPublishedUrl] = useState('');
  const [isTestingDesign, setIsTestingDesign] = useState(false);
  const [isSavingDesign, setIsSavingDesign] = useState(false);

  // CMS store — used to refresh the sidebar after migrate / re-sync.
  const loadCollections = useCollectionsStore((s) => s.loadCollections);
  const loadFields = useCollectionsStore((s) => s.loadFields);
  const reloadCurrentItems = useCollectionsStore((s) => s.reloadCurrentItems);
  const selectedCollectionId = useCollectionsStore((s) => s.selectedCollectionId);

  /** Refresh the CMS store so the sidebar + open collection reflect new data. */
  const refreshCmsStore = useCallback(async () => {
    await loadCollections();
    if (selectedCollectionId) {
      await Promise.all([
        loadFields(selectedCollectionId),
        reloadCurrentItems(),
      ]);
    }
  }, [loadCollections, loadFields, reloadCurrentItems, selectedCollectionId]);

  // =========================================================================
  // Load settings on mount
  // =========================================================================

  useEffect(() => {
    loadSettings();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSettings = async () => {
    setIsLoading(true);
    try {
      const [settings, importsList] = await Promise.all([
        webflowApi.getSettings(),
        webflowApi.listImports().catch(() => [] as WebflowImport[]),
      ]);

      const apiToken = settings?.[WEBFLOW_SETTINGS.apiToken];
      if (apiToken) {
        setSavedToken(apiToken);
        setToken(apiToken);
        setIsConnected(true);
        onConnectionChange(true);
        loadSites();
      }

      const storedUrl = settings?.[WEBFLOW_SETTINGS.publishedUrl];
      if (storedUrl) {
        setPublishedUrl(storedUrl);
        setSavedPublishedUrl(storedUrl);
        onConnectionChange(true);
      }

      setImports(importsList || []);
    } catch {
      toast.error('Failed to load Webflow settings');
    } finally {
      setIsLoading(false);
    }
  };

  // =========================================================================
  // Token management
  // =========================================================================

  const handleTestToken = async () => {
    setIsTesting(true);
    try {
      const result = await webflowApi.testToken(token);

      if (result?.valid) {
        toast.success('Connection successful', {
          description: 'Your token is valid.',
        });
      } else {
        toast.error('Connection failed', {
          description: result?.error || 'Check your token and try again.',
        });
      }
    } catch {
      toast.error('Connection failed', {
        description: 'Could not reach Webflow. Check your network connection.',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveToken = async () => {
    setIsSavingToken(true);
    try {
      await webflowApi.saveSettings({ [WEBFLOW_SETTINGS.apiToken]: token });
      setSavedToken(token);
      setIsConnected(true);
      onConnectionChange(true);
      loadSites();
    } catch {
      toast.error('Failed to save token');
    } finally {
      setIsSavingToken(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await webflowApi.deleteSettings();
      setToken('');
      setSavedToken('');
      setIsConnected(false);
      setSites([]);
      setSelectedSiteId('');
      setPreview(null);
      setImports([]);
      // deleteSettings() also clears the Design published URL — reset that state
      // and drop the cached stylesheet so a later paste re-discovers cleanly.
      setPublishedUrl('');
      setSavedPublishedUrl('');
      clearStylesheetCache();
      onConnectionChange(false);
      onDisconnect();
    } catch {
      toast.error('Failed to disconnect');
    } finally {
      setShowDisconnect(false);
    }
  };

  // =========================================================================
  // Sites + preview
  // =========================================================================

  const loadSites = useCallback(async () => {
    setIsLoadingSites(true);
    try {
      const data = await webflowApi.listSites();
      setSites(data || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load sites');
    } finally {
      setIsLoadingSites(false);
    }
  }, []);

  const handleSiteChange = async (siteId: string) => {
    setSelectedSiteId(siteId);
    setPreview(null);
    if (!siteId) return;

    setIsLoadingPreview(true);
    try {
      const data = await webflowApi.previewCollections(siteId);
      setPreview(data || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to preview collections');
    } finally {
      setIsLoadingPreview(false);
    }
  };

  // =========================================================================
  // Migration + re-sync
  // =========================================================================

  const handleMigrate = async () => {
    if (!selectedSiteId) return;

    setIsMigrating(true);
    const toastId = toast.loading('Migrating Webflow site...', {
      description: 'This can take a few minutes for large sites.',
    });

    try {
      const { import: importRecord, result } = await webflowApi.migrate(selectedSiteId);

      const totalCreated = result.collections.reduce((sum, c) => sum + c.created, 0);
      const totalPublished = result.collections.reduce((sum, c) => sum + c.published, 0);

      toast.success('Migration complete', {
        id: toastId,
        description: `${result.collections.length} collections, ${totalCreated} items imported (${totalPublished} published).`,
      });

      // Refresh state.
      const refreshed = await webflowApi.listImports().catch(() => imports);
      setImports(refreshed.length > 0 ? refreshed : [...imports, importRecord]);
      setSelectedSiteId('');
      setPreview(null);

      // Refresh CMS store so the new collections show up without a hard reload.
      refreshCmsStore().catch(() => {});
    } catch (error) {
      toast.error('Migration failed', {
        id: toastId,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsMigrating(false);
    }
  };

  const handleResync = async (importRecord: WebflowImport) => {
    setSyncingIds((prev) => new Set(prev).add(importRecord.id));
    const toastId = toast.loading(`Re-syncing ${importRecord.siteName}...`);

    try {
      const result = await webflowApi.resync(importRecord.id);
      const created = result.collections.reduce((s, c) => s + c.created, 0);
      const updated = result.collections.reduce((s, c) => s + c.updated, 0);
      const deleted = result.collections.reduce((s, c) => s + c.deleted, 0);

      toast.success('Re-sync complete', {
        id: toastId,
        description: `${created} created, ${updated} updated, ${deleted} removed.`,
      });

      const refreshed = await webflowApi.listImports().catch(() => imports);
      setImports(refreshed);

      // Reload the open collection so updated items show immediately.
      refreshCmsStore().catch(() => {});
    } catch (error) {
      toast.error('Re-sync failed', {
        id: toastId,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(importRecord.id);
        return next;
      });
    }
  };

  const handleRemoveImport = async () => {
    if (!importToRemove) return;
    try {
      await webflowApi.removeImport(importToRemove.id);
      setImports((prev) => prev.filter((i) => i.id !== importToRemove.id));
      toast.success('Import removed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove import');
    } finally {
      setImportToRemove(null);
    }
  };

  // =========================================================================
  // Design — published stylesheet
  // =========================================================================

  const handleTestDesign = async () => {
    setIsTestingDesign(true);
    try {
      const result = await webflowApi.resolveStylesheet(publishedUrl);
      if (result?.css) {
        toast.success('Stylesheet found', {
          description: 'Global styles will be applied when you paste designs.',
        });
      } else {
        toast.error('No stylesheet found', {
          description: 'Make sure the site is published and the URL is correct.',
        });
      }
    } catch (error) {
      toast.error('Could not reach that site', {
        description: error instanceof Error ? error.message : 'Check the URL and try again.',
      });
    } finally {
      setIsTestingDesign(false);
    }
  };

  const handleSaveDesign = async () => {
    setIsSavingDesign(true);
    try {
      await webflowApi.saveSettings({ [WEBFLOW_SETTINGS.publishedUrl]: publishedUrl.trim() });
      setSavedPublishedUrl(publishedUrl.trim());
      // The stored site changed — drop any cached stylesheet so the next paste
      // re-discovers from the new URL.
      clearStylesheetCache();
      if (publishedUrl.trim()) onConnectionChange(true);
      toast.success('Design settings saved');
    } catch {
      toast.error('Failed to save design settings');
    } finally {
      setIsSavingDesign(false);
    }
  };

  // =========================================================================
  // Render
  // =========================================================================

  if (isLoading) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Webflow</SheetTitle>
          <SheetDescription className="sr-only">Webflow integration settings</SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      </>
    );
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="mr-auto">Webflow</SheetTitle>
        {isConnected && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => setShowDisconnect(true)}
          >
            Disconnect
          </Button>
        )}
        <SheetDescription className="sr-only">
          Webflow integration settings
        </SheetDescription>
      </SheetHeader>

      <div className="mt-3 space-y-8">
        {/* CMS Section */}
        <div className="space-y-4">
          <FieldLabel className="text-sm font-semibold">CMS</FieldLabel>
          <FieldDescription className="flex flex-col gap-2">
            <span>
              Enter a Webflow site API token. Required scopes:{' '}
              <span className="text-foreground">sites:read</span> and{' '}
              <span className="text-foreground">cms:read</span>.
            </span>
            <span>
              Create a token from your site&apos;s{' '}
              <span className="text-foreground">
                Site settings → Apps &amp; Integrations → API access
              </span>{' '}
              page in Webflow.
            </span>
          </FieldDescription>

          <Field>
            <FieldLabel htmlFor="webflow-token">API Token</FieldLabel>
            <Input
              id="webflow-token"
              type="password"
              placeholder="Enter your Webflow API token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono text-xs"
            />
            <div className="flex gap-2 mt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTestToken}
                disabled={!token.trim() || isTesting}
              >
                {isTesting && <Spinner className="size-3" />}
                Test connection
              </Button>
              <Button
                size="sm"
                onClick={handleSaveToken}
                disabled={!token.trim() || token === savedToken || isSavingToken}
              >
                {isSavingToken && <Spinner className="size-3" />}
                Save
              </Button>
            </div>
          </Field>
        </div>

        {/* Migrate a site */}
        {isConnected && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <FieldLabel>Migrate a Webflow site</FieldLabel>
              {sites.length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={loadSites}
                  disabled={isLoadingSites}
                >
                  <Icon name="refresh" />
                  Refresh
                </Button>
              )}
            </div>

            <FieldDescription>
              Pick a site to import its CMS collections, items and assets into Ycode. Items
              that are live in Webflow will be auto-published in Ycode.
            </FieldDescription>

            <Field>
              <Select
                value={selectedSiteId}
                onValueChange={handleSiteChange}
                disabled={isLoadingSites || isMigrating}
              >
                <SelectTrigger>
                  {isLoadingSites ? (
                    <span className="flex items-center gap-1.5">
                      <Spinner className="size-3" />
                      <span>Loading...</span>
                    </span>
                  ) : (
                    <SelectValue placeholder="Select a site" />
                  )}
                </SelectTrigger>
                <SelectContent>
                  {sites.map((site) => (
                    <SelectItem
                      key={site.id}
                      value={site.id}
                    >
                      {site.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {/* Preview */}
            {selectedSiteId && (
              <div className="border rounded-lg bg-secondary/30 p-3 space-y-2">
                {isLoadingPreview && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner className="size-3" />
                    <span>Loading collections...</span>
                  </div>
                )}

                {!isLoadingPreview && preview && preview.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    This site has no CMS collections to migrate.
                  </p>
                )}

                {!isLoadingPreview && preview && preview.length > 0 && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {preview.length} {preview.length === 1 ? 'collection' : 'collections'} ready to migrate.
                    </p>
                    <ul className="space-y-1">
                      {preview.map((c) => (
                        <li
                          key={c.id}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="font-medium truncate">{c.displayName}</span>
                          <span className="text-muted-foreground shrink-0">
                            {c.fieldCount} {c.fieldCount === 1 ? 'field' : 'fields'}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <div className="flex justify-end pt-2">
                      <Button
                        size="sm"
                        onClick={handleMigrate}
                        disabled={isMigrating || preview.length === 0}
                      >
                        {isMigrating && <Spinner className="size-3" />}
                        Start migration
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Imports list */}
        {isConnected && (
          <div className="space-y-2">
            <FieldLabel>Imports</FieldLabel>

            {imports.length === 0 ? (
              <Empty>
                <EmptyTitle>No imports yet</EmptyTitle>
                <EmptyDescription>
                  Pick a Webflow site above and start your first migration.
                </EmptyDescription>
              </Empty>
            ) : (
              imports.map((importRecord) => (
                <ImportCard
                  key={importRecord.id}
                  importRecord={importRecord}
                  isSyncing={syncingIds.has(importRecord.id)}
                  onResync={() => handleResync(importRecord)}
                  onRemove={() => setImportToRemove(importRecord)}
                  onOpenCollection={(collectionId) => {
                    if (onCloseAndNavigate) {
                      onCloseAndNavigate(`/ycode/collections/${collectionId}`);
                    } else {
                      router.push(`/ycode/collections/${collectionId}`);
                    }
                  }}
                />
              ))
            )}
          </div>
        )}

        {/* Design Section */}
        <div className="space-y-4 border-t pt-6">
          <FieldLabel className="text-sm font-semibold">Design</FieldLabel>

          <FieldDescription className="flex flex-col gap-2">
            <span>
              Copy elements in the Webflow Designer and paste them onto the Ycode
              canvas to recreate the layout, styles and components.
            </span>
            <span>
              Add your published site URL below so pasted designs pick up{' '}
              <span className="text-foreground">global styles</span> — section
              backgrounds, heading and text colours, and fonts.
            </span>
          </FieldDescription>

          <Field>
            <FieldLabel htmlFor="webflow-site-url">Published site URL</FieldLabel>
            <Input
              id="webflow-site-url"
              type="url"
              placeholder="https://your-site.webflow.io"
              value={publishedUrl}
              onChange={(e) => setPublishedUrl(e.target.value)}
              className="font-mono text-xs"
            />
            <FieldDescription>
              Your Webflow site must be{' '}
              <span className="text-foreground">published</span> for its
              stylesheet to be available.
            </FieldDescription>
            <div className="flex gap-2 mt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTestDesign}
                disabled={!publishedUrl.trim() || isTestingDesign}
              >
                {isTestingDesign && <Spinner className="size-3" />}
                Test
              </Button>
              <Button
                size="sm"
                onClick={handleSaveDesign}
                disabled={publishedUrl.trim() === savedPublishedUrl.trim() || isSavingDesign}
              >
                {isSavingDesign && <Spinner className="size-3" />}
                Save
              </Button>
            </div>
          </Field>

          <div className="border rounded-lg bg-secondary/30 p-3">
            <p className="text-xs font-medium mb-2">How to paste a design</p>
            <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
              <li>Publish your site in Webflow.</li>
              <li>Select elements in the Webflow Designer and copy them.</li>
              <li>Click the Ycode canvas and paste to import the design.</li>
            </ol>
          </div>
        </div>
      </div>

      {/* Disconnect dialog */}
      <ConfirmDialog
        open={showDisconnect}
        onOpenChange={setShowDisconnect}
        title="Disconnect Webflow?"
        description="This removes your CMS token, your Design site URL, and all import records. The Ycode collections created by past migrations will remain."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDisconnect}
        onCancel={() => setShowDisconnect(false)}
      />

      {/* Remove import dialog */}
      <ConfirmDialog
        open={!!importToRemove}
        onOpenChange={(open: boolean) => { if (!open) setImportToRemove(null); }}
        title="Remove import?"
        description={`Removes the link to "${importToRemove?.siteName}". Re-sync won't be possible, but the Ycode collections themselves will stay.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        confirmVariant="destructive"
        onConfirm={handleRemoveImport}
        onCancel={() => setImportToRemove(null)}
      />
    </>
  );
}

// =============================================================================
// Import Card Sub-component
// =============================================================================

interface ImportCardProps {
  importRecord: WebflowImport;
  isSyncing: boolean;
  onResync: () => void;
  onRemove: () => void;
  onOpenCollection: (collectionId: string) => void;
}

function ImportCard({
  importRecord,
  isSyncing,
  onResync,
  onRemove,
  onOpenCollection,
}: ImportCardProps) {
  return (
    <div className="border rounded-lg bg-secondary/30 overflow-hidden">
      <div className="flex items-center p-3 gap-2">
        <div className="flex-1 min-w-0 gap-px flex flex-col">
          <span className="text-sm font-medium truncate">{importRecord.siteName}</span>
          <span className="text-[10px] text-muted-foreground">
            {importRecord.collectionMappings.length}{' '}
            {importRecord.collectionMappings.length === 1 ? 'collection' : 'collections'}
            {importRecord.lastSyncedAt && (
              <> • Last synced {formatRelativeTime(importRecord.lastSyncedAt, false)}</>
            )}
          </span>
        </div>

        {importRecord.syncStatus === 'error' && (
          <Badge variant="destructive">Error</Badge>
        )}
        {importRecord.syncStatus === 'syncing' && (
          <Badge variant="secondary">Syncing</Badge>
        )}

        <Button
          variant="secondary"
          size="xs"
          onClick={onResync}
          disabled={isSyncing}
        >
          {isSyncing && <Spinner className="size-3" />}
          Re-sync
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={onRemove}
          aria-label="Remove import"
        >
          <Icon name="trash" />
        </Button>
      </div>

      {importRecord.syncError && (
        <div className="px-3 pb-2 text-[10px] text-destructive">
          {importRecord.syncError}
        </div>
      )}

      {importRecord.collectionMappings.length > 0 && (
        <div className="border-t bg-background/40">
          <ul>
            {importRecord.collectionMappings.map((mapping) => (
              <li
                key={mapping.webflowCollectionId}
                className="flex items-center justify-between px-3 py-2 text-xs border-b last:border-b-0"
              >
                <span className="truncate">{mapping.ycodeCollectionName}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onOpenCollection(mapping.ycodeCollectionId)}
                >
                  Open
                  <Icon name="external-link" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
