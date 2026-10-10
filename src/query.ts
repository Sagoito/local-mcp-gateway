import { z } from 'zod';

const MAX_RECORDS = 100_000;
const MAX_OPERATION_VISITS = 1_000_000;

const scalarSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const pathSchema = z.array(z.string().max(100)).max(8);

export const queryInput = z
  .object({
    id: z.string().min(1).max(100),
    path: pathSchema.default([]),
    where: z
      .array(
        z
          .object({
            field: z.array(z.string().max(100)).min(1).max(8),
            op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
            value: scalarSchema,
          })
          .strict(),
      )
      .max(16)
      .default([]),
    action: z.enum(['all', 'first', 'count']).default('all'),
    fields: z.array(z.string().max(100)).max(16).optional(),
  })
  .strict();

/** JSON Schema form for MCP tools/list clients that do not translate Zod. */
export const querySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 },
    path: {
      type: 'array',
      maxItems: 8,
      default: [],
      items: { type: 'string', maxLength: 100 },
    },
    where: {
      type: 'array',
      maxItems: 16,
      default: [],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'op', 'value'],
        properties: {
          field: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: { type: 'string', maxLength: 100 },
          },
          op: { type: 'string', enum: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] },
          value: {
            anyOf: [
              { type: 'string', maxLength: 512 },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
            ],
          },
        },
      },
    },
    action: { type: 'string', enum: ['all', 'first', 'count'], default: 'all' },
    fields: {
      type: 'array',
      maxItems: 16,
      items: { type: 'string', maxLength: 100 },
    },
  },
} as const;

export type QueryInput = z.infer<typeof queryInput>;

/** Filters a retained MCP JSON result using own-property paths and bounded work. */
export function queryResult(
  rawMcpResult: unknown,
  options: QueryInput,
): unknown {
  const root = normalizeResult(rawMcpResult);
  const selected = resolvePath(root, options.path, 'path');
  if (!Array.isArray(selected))
    throw new TypeError('Selected query path must resolve to an array');
  if (selected.length > MAX_RECORDS) {
    throw new RangeError(
      `Selected array has ${selected.length} records; maximum is ${MAX_RECORDS}`,
    );
  }

  const visits = { count: 0 };
  const rows: unknown[] = [];
  let count = 0;
  for (const row of selected) {
    visit(visits);
    if (!matches(row, options.where, visits)) continue;
    count += 1;
    if (options.action === 'count') continue;
    rows.push(
      options.fields === undefined ? row : project(row, options.fields, visits),
    );
    if (options.action === 'first') break;
  }

  if (options.action === 'count') return count;
  if (options.action === 'first') return rows[0] ?? null;
  return rows;
}

function normalizeResult(raw: unknown): unknown {
  const result = asRecord(raw);
  if (result?.isError === true) throw new Error(mcpErrorMessage(result));

  let value: unknown;
  const content = Array.isArray(result?.content) ? result.content : [];
  if (content.length > 0) {
    const textBlocks = content.filter(
      (block) => asRecord(block)?.type === 'text',
    );
    if (textBlocks.length !== content.length) {
      throw new TypeError(
        'MCP result contains non-text content and cannot be queried as JSON',
      );
    }
    const text = textBlocks
      .map((block) => {
        const blockRecord = asRecord(block);
        if (typeof blockRecord?.text !== 'string')
          throw new TypeError('MCP text content is not a string');
        return blockRecord.text;
      })
      .join('\n');
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new TypeError('MCP text content is not valid JSON');
    }
  } else if (
    result &&
    Object.prototype.hasOwnProperty.call(result, 'structuredContent')
  ) {
    value = result.structuredContent;
  } else {
    throw new TypeError('MCP result has no JSON text or structuredContent');
  }

  // The query operates on a detached JSON value, so getters, prototypes, and
  // references supplied by a caller cannot affect path resolution.
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('MCP structuredContent is not JSON-serializable');
  }
  if (serialized === undefined)
    throw new TypeError('MCP structuredContent is not JSON-serializable');
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError('MCP structuredContent is not valid JSON');
  }
}

function resolvePath(root: unknown, path: string[], label: string): unknown {
  let value = root;
  for (const segment of path) {
    if (
      !isObjectLike(value) ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      throw new Error(`${label} does not exist`);
    }
    value = value[segment];
  }
  return value;
}

function matches(
  row: unknown,
  conditions: QueryInput['where'],
  visits: { count: number },
): boolean {
  for (const condition of conditions) {
    const found = resolveField(row, condition.field, visits);
    if (!found.exists || !compare(found.value, condition.op, condition.value))
      return false;
  }
  return true;
}

function resolveField(
  root: unknown,
  path: string[],
  visits: { count: number },
): { exists: boolean; value?: unknown } {
  let value = root;
  for (const segment of path) {
    visit(visits);
    if (
      !isObjectLike(value) ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    )
      return { exists: false };
    value = value[segment];
  }
  return { exists: true, value };
}

function compare(
  actual: unknown,
  op: QueryInput['where'][number]['op'],
  expected: string | number | boolean | null,
): boolean {
  if (
    actual !== null &&
    typeof actual !== 'string' &&
    typeof actual !== 'number' &&
    typeof actual !== 'boolean'
  )
    return false;
  if (op === 'eq') return actual === expected;
  if (op === 'ne') return actual !== expected;
  if (typeof actual === 'number' && typeof expected === 'number') {
    switch (op) {
      case 'lt':
        return actual < expected;
      case 'lte':
        return actual <= expected;
      case 'gt':
        return actual > expected;
      case 'gte':
        return actual >= expected;
    }
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    switch (op) {
      case 'lt':
        return actual < expected;
      case 'lte':
        return actual <= expected;
      case 'gt':
        return actual > expected;
      case 'gte':
        return actual >= expected;
    }
  }
  return false;
}

function project(
  row: unknown,
  fields: string[],
  visits: { count: number },
): Record<string, unknown> {
  const output: Array<[string, unknown]> = [];
  for (const field of fields) {
    visit(visits);
    if (isObjectLike(row) && Object.prototype.hasOwnProperty.call(row, field)) {
      output.push([field, row[field]]);
    }
  }
  // Object.fromEntries creates __proto__ as an ordinary own data property.
  return Object.fromEntries(output);
}

function visit(visits: { count: number }): void {
  visits.count += 1;
  if (visits.count > MAX_OPERATION_VISITS) {
    throw new RangeError(
      `Query exceeds the ${MAX_OPERATION_VISITS} operation-visit limit`,
    );
  }
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mcpErrorMessage(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const message = content
    .filter((block) => asRecord(block)?.type === 'text')
    .map((block) => {
      const value = asRecord(block)?.text;
      return typeof value === 'string' ? value : '';
    })
    .join('\n');
  return message
    ? `MCP tool returned an error: ${message.slice(0, 500)}`
    : 'MCP tool returned an error';
}
