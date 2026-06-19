import { Knex } from 'knex';

/**
 * Migration: Create global_variables table
 *
 * Site-wide typed singletons (Name / Type / Value) that can be injected into
 * any layer property that accepts a matching CMS field type. Unlike collection
 * fields, a global combines its schema (name + type) and its value in a single
 * row, so the whole row participates in the draft/published workflow.
 *
 * Values are stored as text and cast based on `type`, exactly like
 * collection_item_values. Uses composite primary key (id, is_published) for the
 * draft/published workflow, same pattern as pages, components, layer_styles,
 * collection_fields, and collection_item_values.
 */
export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable('global_variables');
  if (exists) {
    return;
  }

  await knex.schema.createTable('global_variables', (table) => {
    table.uuid('id').defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 255).notNullable();
    table.string('key', 255).nullable(); // stable slug used for resolution/imports
    table.string('type', 255).notNullable();
    table.text('value').nullable();
    table.jsonb('data').notNullable().defaultTo('{}'); // type-specific config (format, options)
    table.integer('order').notNullable().defaultTo(0);
    table.boolean('is_published').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('deleted_at', { useTz: true }).nullable();

    // Composite primary key (id, is_published)
    table.primary(['id', 'is_published']);

    // Indexes (uniqueness on (id, is_published) is already enforced by the PK)
    table.index('is_published');
    table.index('type');
  });

  // Enable Row Level Security
  await knex.schema.raw('ALTER TABLE global_variables ENABLE ROW LEVEL SECURITY');

  // Single SELECT policy: public can view published OR authenticated can view all
  await knex.schema.raw(`
    CREATE POLICY "Global variables are viewable"
      ON global_variables FOR SELECT
      USING (
        (is_published = true AND deleted_at IS NULL)
        OR (SELECT auth.uid()) IS NOT NULL
      )
  `);

  // Authenticated users can INSERT/UPDATE/DELETE
  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can modify global variables"
      ON global_variables FOR INSERT
      WITH CHECK ((SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can update global variables"
      ON global_variables FOR UPDATE
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can delete global variables"
      ON global_variables FOR DELETE
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP POLICY IF EXISTS "Global variables are viewable" ON global_variables');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can modify global variables" ON global_variables');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can update global variables" ON global_variables');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can delete global variables" ON global_variables');

  await knex.schema.dropTableIfExists('global_variables');
}
