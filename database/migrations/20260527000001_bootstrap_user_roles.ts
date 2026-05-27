import type { Knex } from 'knex';

/**
 * Bootstrap user roles in Supabase auth.users.
 *
 * - The earliest-created user (the person who set up the app) becomes 'owner'.
 * - All other users without a role default to 'designer'.
 *
 * Roles are stored in raw_app_meta_data (Supabase's app_metadata),
 * which is only writable via the Admin API or direct SQL.
 */

export async function up(knex: Knex): Promise<void> {
  // Set the first-ever user as owner (if they don't already have a role)
  await knex.raw(`
    UPDATE auth.users
    SET raw_app_meta_data = raw_app_meta_data || '{"role": "owner"}'::jsonb
    WHERE id = (
      SELECT id FROM auth.users
      ORDER BY created_at ASC
      LIMIT 1
    )
    AND (raw_app_meta_data->>'role') IS NULL
  `);

  // Set all remaining users without a role to designer
  await knex.raw(`
    UPDATE auth.users
    SET raw_app_meta_data = raw_app_meta_data || '{"role": "designer"}'::jsonb
    WHERE (raw_app_meta_data->>'role') IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE auth.users
    SET raw_app_meta_data = raw_app_meta_data - 'role'
  `);
}
