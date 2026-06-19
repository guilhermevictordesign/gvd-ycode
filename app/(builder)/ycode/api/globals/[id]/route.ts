import { NextRequest } from 'next/server';
import {
  updateGlobalVariable,
  softDeleteGlobalVariable,
} from '@/lib/repositories/globalVariableRepository';
import { noCache } from '@/lib/api-response';
import { GLOBAL_VARIABLE_TYPES, isValidGlobalVariableType, type UpdateGlobalVariableData } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * PUT /ycode/api/globals/[id]
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.type !== undefined && !isValidGlobalVariableType(body.type)) {
      return noCache(
        { error: `Invalid type. Must be one of: ${GLOBAL_VARIABLE_TYPES.join(', ')}` },
        400
      );
    }

    const updates: UpdateGlobalVariableData = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.key !== undefined) updates.key = body.key;
    if (body.type !== undefined) updates.type = body.type;
    if (body.value !== undefined) updates.value = body.value;
    if (body.data !== undefined) updates.data = body.data;
    if (body.order !== undefined) updates.order = body.order;

    const updated = await updateGlobalVariable(id, updates);

    return noCache({ data: updated });
  } catch (error) {
    console.error('[PUT /ycode/api/globals/[id]] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to update global variable' },
      500
    );
  }
}

/**
 * DELETE /ycode/api/globals/[id]
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    await softDeleteGlobalVariable(id);

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[DELETE /ycode/api/globals/[id]] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to delete global variable' },
      500
    );
  }
}
