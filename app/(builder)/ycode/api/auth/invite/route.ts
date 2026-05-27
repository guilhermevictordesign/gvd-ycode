import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { noCache } from '@/lib/api-response';
import { requireManageMembers } from '@/lib/roles-server';
import { ASSIGNABLE_ROLES } from '@/lib/roles';

/**
 * POST /ycode/api/auth/invite
 *
 * Invite a user by email using Supabase's built-in invite system.
 * Requires owner or admin role.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireManageMembers();
    if ('status' in result) return result;

    const body = await request.json();
    const { email, role = 'designer', redirectTo } = body;

    if (!email) {
      return noCache({ error: 'Email is required' }, 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return noCache({ error: 'Invalid email format' }, 400);
    }

    const assignRole = ASSIGNABLE_ROLES.includes(role) ? role : 'designer';

    const client = await getSupabaseAdmin();
    if (!client) {
      return noCache({ error: 'Supabase not configured' }, 500);
    }

    const { data, error } = await client.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectTo || undefined,
      data: {
        invited_at: new Date().toISOString(),
      },
    });

    if (error) {
      console.error('[invite] Error inviting user:', error);
      return noCache({ error: error.message }, 400);
    }

    if (data.user) {
      await client.auth.admin.updateUserById(data.user.id, {
        app_metadata: { role: assignRole },
      });
    }

    return noCache({
      data: {
        user: data.user,
        role: assignRole,
        message: `Invitation sent to ${email}`,
      },
    });
  } catch (error) {
    console.error('[invite] Unexpected error:', error);
    return noCache(
      { error: 'Failed to send invitation' },
      500
    );
  }
}
