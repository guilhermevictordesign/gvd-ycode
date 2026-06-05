import { Knex } from 'knex';

/**
 * Migration: Drop the unique constraint on layer_styles (name, is_published)
 *
 * Layer style names are not required to be unique. Naming and organisation is
 * left to the user — duplicate names are allowed (e.g. forking a style with the
 * "New" action keeps the source name until the user renames it). The original
 * constraint blocked that workflow with a duplicate-key error.
 *
 * Uses DROP ... IF EXISTS for both the constraint and the index form so the
 * migration is safe regardless of how the uniqueness was originally created.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(
    'ALTER TABLE layer_styles DROP CONSTRAINT IF EXISTS layer_styles_name_is_published_unique'
  );
  await knex.schema.raw(
    'DROP INDEX IF EXISTS layer_styles_name_is_published_unique'
  );
}

export async function down(knex: Knex): Promise<void> {
  // Best-effort restore. Will fail if duplicate names now exist in the table.
  await knex.schema.raw(
    'ALTER TABLE layer_styles ADD CONSTRAINT layer_styles_name_is_published_unique UNIQUE (name, is_published)'
  );
}
