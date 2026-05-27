import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { noCache } from '@/lib/api-response';
import { getCallerInfo, requireManageMembers } from '@/lib/roles-server';
import { resolveRole, ASSIGNABLE_ROLES } from '@/lib/roles';

/**
 * GET /ycode/api/auth/users
 *
 * List all users with their status (active or pending invite) and roles.
 */
export async function GET(request: NextRequest) {
  try {
    const client = await getSupabaseAdmin();
    if (!client) {
      return noCache({ error: 'Supabase not configured' }, 500);
    }

    const { data, error } = await client.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (error) {
      console.error('[users] Error listing users:', error);
      return noCache({ error: error.message }, 500);
    }

    const caller = await getCallerInfo();

    const activeUsers: Array<{
      id: string;
      email: string;
      display_name: string | null;
      avatar_url: string | null;
      role: string;
      created_at: string;
      last_sign_in_at: string | null;
    }> = [];

    const pendingInvites: Array<{
      id: string;
      email: string;
      role: string;
      invited_at: string;
    }> = [];

    for (const user of data.users) {
      const userAny = user as any;
      const metadata = user.user_metadata || userAny.raw_user_meta_data || {};
      const appMeta = user.app_metadata || userAny.raw_app_meta_data || {};
      const wasInvited = !!metadata.invited_at;
      const hasIdentities = user.identities && user.identities.length > 0;
      const hasSignedIn = user.last_sign_in_at !== null;
      const emailConfirmed = !!user.email_confirmed_at;
      const isPending = wasInvited && !emailConfirmed && !hasIdentities && !hasSignedIn;

      const userRole = resolveRole(appMeta.role as string);

      if (!isPending) {
        activeUsers.push({
          id: user.id,
          email: user.email || '',
          display_name: metadata.display_name || metadata.full_name || null,
          avatar_url: metadata.avatar_url || null,
          role: userRole,
          created_at: user.created_at,
          last_sign_in_at: user.last_sign_in_at || null,
        });
      } else {
        pendingInvites.push({
          id: user.id,
          email: user.email || '',
          role: userRole,
          invited_at: metadata.invited_at || user.created_at,
        });
      }
    }

    return noCache({
      data: { activeUsers, pendingInvites, callerRole: caller?.role || null },
    });
  } catch (error) {
    console.error('[users] Unexpected error:', error);
    return noCache({ error: 'Failed to fetch users' }, 500);
  }
}

/**
 * PATCH /ycode/api/auth/users?id=...
 *
 * Change a user's role. Requires owner or admin.
 */
export async function PATCH(request: NextRequest) {
  try {
    const result = await requireManageMembers();
    if ('status' in result) return result;
    const caller = result;

    const { searchParams } = new URL(request.url);
    const targetId = searchParams.get('id');
    if (!targetId) {
      return noCache({ error: 'ID is required' }, 400);
    }

    const body = await request.json();
    const { role } = body;
    if (!role || !ASSIGNABLE_ROLES.includes(role)) {
      return noCache({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` }, 400);
    }

    if (role === 'admin' && caller.role !== 'owner') {
      return noCache({ error: 'Only the owner can assign the admin role' }, 403);
    }

    const client = await getSupabaseAdmin();
    if (!client) {
      return noCache({ error: 'Supabase not configured' }, 500);
    }

    const { data: targetData } = await client.auth.admin.getUserById(targetId);
    if (targetData?.user?.app_metadata?.role === 'owner') {
      return noCache({ error: 'Cannot change the owner\'s role' }, 400);
    }

    const { error } = await client.auth.admin.updateUserById(targetId, {
      app_metadata: { role },
    });

    if (error) {
      console.error('[users] Error updating role:', error);
      return noCache({ error: error.message }, 400);
    }

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[users] Unexpected error:', error);
    return noCache({ error: 'Failed to update role' }, 500);
  }
}

/**
 * DELETE /ycode/api/auth/users?id=...
 *
 * Delete a user or cancel a pending invite. Requires owner or admin.
 */
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireManageMembers();
    if ('status' in result) return result;
    const caller = result;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('id');

    if (!userId) {
      return noCache({ error: 'User ID is required' }, 400);
    }

    if (userId === caller.userId) {
      return noCache({ error: 'Cannot remove yourself' }, 400);
    }

    const client = await getSupabaseAdmin();
    if (!client) {
      return noCache({ error: 'Supabase not configured' }, 500);
    }

    const { data: targetData } = await client.auth.admin.getUserById(userId);
    if (targetData?.user?.app_metadata?.role === 'owner') {
      return noCache({ error: 'Cannot remove the owner' }, 400);
    }

    const { error } = await client.auth.admin.deleteUser(userId);
    if (error) {
      console.error('[users] Error deleting user:', error);
      return noCache({ error: error.message }, 400);
    }

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[users] Unexpected error:', error);
    return noCache({ error: 'Failed to delete user' }, 500);
  }
}
