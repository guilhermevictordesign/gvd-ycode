import { NextRequest } from 'next/server';
import { getSlugsByItemIds } from '@/lib/repositories/collectionItemRepository';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/collections/items/slugs
 *
 * Returns a `{ itemId: slug }` map for the given collection item IDs.
 * Used by the CMS editor to resolve cross-collection / cross-page link
 * references where the referenced item is not part of the currently
 * loaded collection items.
 *
 * Body:
 *  - itemIds: string[]
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { itemIds } = body;

    if (!itemIds || !Array.isArray(itemIds)) {
      return noCache({ error: 'itemIds must be an array' }, 400);
    }

    if (itemIds.length === 0) {
      return noCache({ data: { slugs: {} } });
    }

    const slugs = await getSlugsByItemIds(itemIds, false);
    return noCache({ data: { slugs } });
  } catch (error) {
    console.error('Error fetching item slugs:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch item slugs' },
      500
    );
  }
}
