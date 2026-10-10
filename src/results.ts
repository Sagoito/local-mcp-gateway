import { randomUUID } from 'node:crypto';

const DEFAULT_INLINE_BYTES = 32 * 1024;
const DEFAULT_ENTRY_LIMIT = 8;
const DEFAULT_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_METADATA_BYTES = 4 * 1024;

export interface ResultStoreOptions {
  inlineBytes?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
  now?: () => number;
  id?: () => string;
}

interface StoredResult {
  snapshot: string;
  bytes: number;
  createdAt: number;
}

/** Normalizes MCP results and keeps oversized raw results in a bounded snapshot cache. */
export class ResultStore {
  private readonly inlineBytes: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly entries = new Map<string, StoredResult>();
  private totalBytes = 0;

  constructor(options: ResultStoreOptions = {}) {
    this.inlineBytes = nonNegativeInteger(options.inlineBytes, DEFAULT_INLINE_BYTES, 'inlineBytes');
    this.maxEntries = nonNegativeInteger(options.maxEntries, DEFAULT_ENTRY_LIMIT, 'maxEntries');
    this.maxTotalBytes = nonNegativeInteger(options.maxTotalBytes, DEFAULT_TOTAL_BYTES, 'maxTotalBytes');
    this.ttlMs = nonNegativeInteger(options.ttlMs, DEFAULT_TTL_MS, 'ttlMs');
    this.now = options.now ?? Date.now;
    this.makeId = options.id ?? randomUUID;
  }

  /** Returns parsed text/JSON for ordinary results or bounded metadata for large ones. */
  present(raw: unknown): unknown {
    const result = asRecord(raw);
    if (result?.isError === true) {
      throw new Error(errorMessage(result));
    }

    const content = Array.isArray(result?.content) ? result.content : [];
    let value: unknown;
    if (content.length > 0) {
      const textBlocks = content.filter((block) => asRecord(block)?.type === 'text');
      const hasNonText = textBlocks.length !== content.length;
      if (hasNonText) {
        // Keep images, audio, embedded resources, and unknown future block types intact.
        value = raw;
      } else {
        const text = textBlocks.map((block) => String(asRecord(block)?.text ?? '')).join('\n');
        value = parseJsonText(text);
      }
    } else if (result && Object.prototype.hasOwnProperty.call(result, 'structuredContent')) {
      value = result.structuredContent;
    } else {
      value = raw;
    }

    const rawSnapshot = stringify(raw);
    const snapshotBytes = Buffer.byteLength(rawSnapshot, 'utf8');
    if (snapshotBytes > this.maxTotalBytes) {
      throw new RangeError(`MCP result snapshot (${snapshotBytes} bytes) exceeds the result-store capacity`);
    }
    const valueSnapshot = stringify(value);
    const outputBytes = Buffer.byteLength(valueSnapshot, 'utf8');
    if (outputBytes <= this.inlineBytes) return value;

    const id = this.makeId();
    this.retain(id, rawSnapshot, snapshotBytes);
    const metadata = {
      gatewayResult: { id, bytes: outputBytes, shape: summarizeShape(value) },
      hint: `For JSON, call execute.result with id ${JSON.stringify(id)}, path to the desired array, where comparisons, and action all/first/count. Use execute.code with mcp.result(${JSON.stringify(id)}) for custom processing; for ordinary text use mcp.text(await mcp.result(${JSON.stringify(id)})).`,
    };
    const serialized = JSON.stringify(metadata);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
      this.delete(id);
      throw new RangeError('Result metadata exceeds the 4 KiB limit');
    }
    return metadata;
  }

  /** Returns a fresh object parsed from the retained raw-result snapshot. */
  async get(id: string): Promise<unknown> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown or expired MCP result: ${id}`);
    if (this.now() - entry.createdAt >= this.ttlMs) {
      this.delete(id);
      throw new Error(`Unknown or expired MCP result: ${id}`);
    }
    // Refresh insertion order so capacity eviction favors recently accessed results.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return JSON.parse(entry.snapshot) as unknown;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private retain(id: string, snapshot: string, bytes: number): void {
    this.pruneExpired();
    if (this.maxEntries === 0) throw new RangeError('Result store is disabled');
    while (this.entries.size >= this.maxEntries || this.totalBytes + bytes > this.maxTotalBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(id, { snapshot, bytes, createdAt: this.now() });
    this.totalBytes += bytes;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt >= this.ttlMs) this.delete(id);
    }
  }

  private delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalBytes -= entry.bytes;
  }
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return resolved;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('MCP result is not JSON-serializable');
  return serialized;
}

function errorMessage(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const message = content
    .filter((block) => asRecord(block)?.type === 'text')
    .map((block) => String(asRecord(block)?.text ?? ''))
    .join('\n');
  return message ? `MCP tool returned an error: ${message.slice(0, 500)}` : 'MCP tool returned an error';
}

function summarizeShape(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: 'array', length: value.length, itemKeys: itemKeys(value) };
  const record = asRecord(value);
  if (!record) return { type: value === null ? 'null' : typeof value };
  const keys = Object.keys(record);
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let arrayProperties = 0;
  for (const key of keys.slice(0, 16)) {
    const fieldValue = record[key];
    if (Array.isArray(fieldValue) && arrayProperties < 4) {
      properties[safeKey(key)] = { type: 'array', length: fieldValue.length, itemKeys: itemKeys(fieldValue, 6) };
      arrayProperties += 1;
    } else {
      properties[safeKey(key)] = { type: Array.isArray(fieldValue) ? 'array' : fieldValue === null ? 'null' : typeof fieldValue };
    }
  }
  return { type: 'object', keyCount: keys.length, properties };
}

function itemKeys(items: unknown[], limit = 8): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, 3)) {
    for (const key of Object.keys(asRecord(item) ?? {})) {
      const safe = safeKey(key);
      if (!seen.has(safe)) {
        seen.add(safe);
        keys.push(safe);
        if (keys.length >= limit) return keys;
      }
    }
  }
  return keys;
}

function safeKey(key: string): string {
  let safe = '';
  let bytes = 0;
  for (const character of key) {
    const printable = /[\u0000-\u001f\u007f-\u009f]/u.test(character) ? '�' : character;
    const size = Buffer.byteLength(printable, 'utf8');
    if (bytes + size > 32) break;
    safe += printable;
    bytes += size;
  }
  return safe;
}
