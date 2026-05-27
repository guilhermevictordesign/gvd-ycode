import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { noCache } from '@/lib/api-response';
import { requireManageMembers } from '@/lib/roles-server';
import { ALL_ROLES } from '@/lib/roles';

export const dynamic = 'force-dynamic';

/**
 * POST /ycode/api/auth/set-role
 *
 * Set a user's role in app_metadata via the Supabase Admin API.
 * Requires the caller to be owner or admin.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireManageMembers();
    if ('status' in result) return result;
    const caller = result;

    const body = await request.json();
    const { userId, role } = body;

    if (!userId || !role) {
      return noCache({ error: 'userId and role are required' }, 400);
    }

    if (!ALL_ROLES.includes(role)) {
      return noCache({ error: `Invalid role. Must be one of: ${ALL_ROLES.join(', ')}` }, 400);
    }

    if (role === 'owner' && caller.role !== 'owner') {
      return noCache({ error: 'Only the owner can assign the owner role' }, 403);
    }

    const client = await getSupabaseAdmin();
    if (!client) {
      return noCache({ error: 'Supabase not configured' }, 500);
    }

    const { error } = await client.auth.admin.updateUserById(userId, {
      app_metadata: { role },
    });

    if (error) {
      console.error('[set-role] Error:', error);
      return noCache({ error: error.message }, 400);
    }

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[set-role] Unexpected error:', error);
    return noCache({ error: 'Failed to set role' }, 500);
  }
}
