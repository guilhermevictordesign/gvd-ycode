import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { noCache } from '@/lib/api-response';
import { purgeTagsOnVercel } from '@/lib/services/cacheService';

/**
 * Vercel Cache Invalidation Endpoint
 *
 * Handles cache tag invalidation for published pages
 */

export async function POST(request: NextRequest) {
  try {
    const { tags } = await request.json();

    if (!Array.isArray(tags)) {
      return noCache(
        { error: 'Tags must be an array' },
        400
      );
    }

    // On Vercel: batched direct CDN purge, avoids revalidateTag cascade bug (#63509).
    // Chunked to respect Vercel's 16-tags-per-purge cap.
    // Off Vercel: revalidateTag per-tag for Next.js's in-process data cache.
    if (process.env.VERCEL === '1') {
      await purgeTagsOnVercel(tags);
    } else {
      for (const tag of tags) {
        revalidateTag(tag, { expire: 0 });
      }
    }

    return noCache({
      success: true,
      invalidated: tags,
    });
  } catch (error) {
    console.error('Cache invalidation error:', error);

    return noCache(
      { error: 'Failed to invalidate cache' },
      500
    );
  }
}
