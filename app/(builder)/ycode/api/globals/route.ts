import { NextRequest } from 'next/server';
import {
  getAllGlobalVariables,
  createGlobalVariable,
} from '@/lib/repositories/globalVariableRepository';
import { noCache } from '@/lib/api-response';
import { GLOBAL_VARIABLE_TYPES, isValidGlobalVariableType } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/globals
 */
export async function GET() {
  try {
    const variables = await getAllGlobalVariables();

    return noCache({ data: variables });
  } catch (error) {
    console.error('[GET /ycode/api/globals] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch global variables' },
      500
    );
  }
}

/**
 * POST /ycode/api/globals
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, type, value, key, data, order } = body;

    if (!name || typeof name !== 'string') {
      return noCache({ error: 'Name is required' }, 400);
    }

    if (!isValidGlobalVariableType(type)) {
      return noCache(
        { error: `Invalid type. Must be one of: ${GLOBAL_VARIABLE_TYPES.join(', ')}` },
        400
      );
    }

    const variable = await createGlobalVariable({
      name,
      type,
      value: value ?? null,
      key: key ?? null,
      data: data ?? {},
      order,
    });

    return noCache({ data: variable }, 201);
  } catch (error) {
    console.error('[POST /ycode/api/globals] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to create global variable' },
      500
    );
  }
}
