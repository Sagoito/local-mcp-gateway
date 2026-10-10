import type { ToolEntry } from './types.js';

const MAX_TOOLS = 64;
const MAX_DEPTH = 4;
const MAX_PROPERTIES = 32;
const MAX_UNION_MEMBERS = 8;
const MAX_ENUM_MEMBERS = 16;
const MAX_IDENTIFIER_LENGTH = 128;
const HEADER = 'Available MCP signatures (hints only; skip search when one is sufficient; use search for full constraints):';
const RECOGNIZED_SCHEMA_KEYS = new Set([
  'type', 'enum', 'anyOf', 'oneOf', '$ref', 'properties', 'required',
  'additionalProperties', 'items', 'nullable', 'description', 'title',
  'default', 'examples', 'deprecated', '$schema', '$id', '$comment',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);

/**
 * Render a small, inline catalogue for tool selection. These signatures are
 * deliberately hints: JSON Schema has constraints TypeScript-like types cannot
 * express, and callers should use search for the authoritative schema.
 */
export function renderCatalog(tools: ToolEntry[], budgetBytes = 4096): string {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > MAX_TOOLS ||
      !Number.isFinite(budgetBytes) || budgetBytes < 0) return '';

  const rows: Array<{ server: string; name: string; line: string }> = [];
  for (const tool of tools) {
    if (!tool || typeof tool.server !== 'string' || typeof tool.name !== 'string' ||
        tool.server.length > MAX_IDENTIFIER_LENGTH || tool.name.length > MAX_IDENTIFIER_LENGTH ||
        !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) return '';
    rows.push({
      server: tool.server,
      name: tool.name,
      line: `mcp.call(${JSON.stringify(tool.server)},${JSON.stringify(tool.name)}, ${renderSchema(tool.inputSchema)}): MCPResult;`,
    });
  }

  rows.sort((a, b) => compare(a.server, b.server) || compare(a.name, b.name) || compare(a.line, b.line));
  const rendered = `\n${HEADER}\n${rows.map(row => row.line).join('\n')}`;
  return Buffer.byteLength(rendered, 'utf8') <= budgetBytes ? rendered : '';
}

function renderSchema(schema: Record<string, unknown>): string {
  return renderNode(schema, 0, new Set<object>(), { remaining: 256 });
}

function renderNode(value: unknown, depth: number, ancestors: Set<object>, budget: { remaining: number }): string {
  if (--budget.remaining < 0 || !isRecord(value) || depth > MAX_DEPTH || ancestors.has(value)) return 'unknown';
  ancestors.add(value);
  try {
    if ('$ref' in value) return 'unknown';
    if (Object.keys(value).some(key => !RECOGNIZED_SCHEMA_KEYS.has(key))) return 'unknown';

    const alternatives = value.anyOf ?? value.oneOf;
    if (alternatives !== undefined) {
      if (!Array.isArray(alternatives) || alternatives.length === 0 || alternatives.length > MAX_UNION_MEMBERS) return 'unknown';
      const members = alternatives.map(item => renderNode(item, depth + 1, ancestors, budget));
      return union(members);
    }

    if (Array.isArray(value.enum)) {
      const values = value.enum;
      if (values.length === 0 || values.length > MAX_ENUM_MEMBERS) return 'unknown';
      const literals: string[] = [];
      for (const item of values) {
        if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
          literals.push(JSON.stringify(item));
        } else if (typeof item === 'string' && item.length <= MAX_IDENTIFIER_LENGTH) {
          literals.push(JSON.stringify(item));
        } else return 'unknown';
      }
      return union(literals);
    }

    const schemaType = value.type;
    if (Array.isArray(schemaType)) {
      if (schemaType.length === 0 || schemaType.length > MAX_UNION_MEMBERS ||
          !schemaType.every(type => typeof type === 'string')) return 'unknown';
      const result = schemaType.map(type => renderType(type as string, value, depth, ancestors, budget));
      if (value.nullable === true && !schemaType.includes('null')) result.push('null');
      return union(result);
    }
    if (typeof schemaType === 'string') {
      const result = renderType(schemaType, value, depth, ancestors, budget);
      return value.nullable === true && schemaType !== 'null' ? union([result, 'null']) : result;
    }

    if ('properties' in value || 'required' in value || 'additionalProperties' in value) {
      return renderObject(value, depth, ancestors, budget);
    }
    return 'unknown';
  } finally {
    ancestors.delete(value);
  }
}

function renderType(type: string, schema: Record<string, unknown>, depth: number, ancestors: Set<object>, budget: { remaining: number }): string {
  switch (type) {
    case 'string': return 'string';
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': {
      if (!('items' in schema)) return 'unknown[]';
      return `Array<${renderNode(schema.items, depth + 1, ancestors, budget)}>`;
    }
    case 'object': return renderObject(schema, depth, ancestors, budget);
    default: return 'unknown';
  }
}

function renderObject(schema: Record<string, unknown>, depth: number, ancestors: Set<object>, budget: { remaining: number }): string {
  const properties = schema.properties;
  const requiredValue = schema.required;
  if (properties !== undefined && !isRecord(properties)) return 'unknown';
  if (requiredValue !== undefined && (!Array.isArray(requiredValue) || !requiredValue.every(item => typeof item === 'string'))) return 'unknown';
  const entries = properties ? Object.entries(properties) : [];
  if (entries.length > MAX_PROPERTIES || entries.some(([key]) => key.length > MAX_IDENTIFIER_LENGTH)) return 'unknown';
  const required = new Set(requiredValue as string[] | undefined);
  const members = entries.map(([key, child]) => `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${renderNode(child, depth + 1, ancestors, budget)};`);

  if ('additionalProperties' in schema) {
    const additional = schema.additionalProperties;
    if (additional === true) members.push('[key: string]: unknown;');
    else if (additional !== false) members.push(`[key: string]: ${renderNode(additional, depth + 1, ancestors, budget)};`);
  }
  return `{ ${members.join(' ')} }`;
}

function union(members: string[]): string {
  const unique = [...new Set(members)];
  return unique.length === 1 ? unique[0]! : unique.join(' | ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
