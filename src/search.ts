import type { ToolEntry } from './types.js';

const K1 = 1.2;
const B = 0.75;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 20;

type PostingList = { values: number[]; idf: number };
export interface SearchOptions {
  query?: string;
  server?: string;
  tool?: string;
  limit?: number;
}
export interface SearchResult { tools: ToolEntry[]; matched: number }

/** Build a reusable BM25 index for an immutable tool-list snapshot. */
export function createSearchIndex(tools: readonly ToolEntry[]) {
  const docs = tools.map((tool) => ({ tool, length: 0, lengthNorm: 0, tieRank: 0 }));
  const postingLists = new Map<string, PostingList>();
  let tokenCount = 0;

  for (let docId = 0; docId < tools.length; docId += 1) {
    const tool = tools[docId];
    const tokens = tokenize(`${tool.server} ${tool.name} ${tool.description ?? ''}`);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    docs[docId].length = tokens.length;
    tokenCount += tokens.length;
    for (const [term, frequency] of counts) {
      let posting = postingLists.get(term);
      if (!posting) postingLists.set(term, posting = { values: [], idf: 0 });
      posting.values.push(docId, frequency);
    }
  }

  const averageLength = tokenCount / (docs.length || 1);
  const lengthScale = averageLength || 1;
  for (const doc of docs) {
    doc.lengthNorm = K1 * (1 - B + B * doc.length / lengthScale);
  }
  for (const posting of postingLists.values()) {
    const df = posting.values.length / 2;
    posting.idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  }

  const stableOrder = docs.map((_, i) => i).sort((a, b) =>
    String(docs[a].tool.server).localeCompare(String(docs[b].tool.server), 'en') ||
    String(docs[a].tool.name).localeCompare(String(docs[b].tool.name), 'en') || a - b);
  for (let i = 0; i < stableOrder.length; i += 1) docs[stableOrder[i]].tieRank = i;

  const byServer = new Map<string, number[]>();
  const byTool = new Map<string, number[]>();
  for (let i = 0; i < docs.length; i += 1) {
    addToIndex(byServer, docs[i].tool.server, i);
    addToIndex(byTool, docs[i].tool.name, i);
  }

  const marks = new Uint32Array(docs.length);
  const scores = new Float64Array(docs.length);
  let generation = 0;
  const touched: number[] = [];

  return {
    search(options: SearchOptions = {}): SearchResult {
      const limit = normalizeLimit(options.limit);
      const serverIds = options.server === undefined ? undefined : byServer.get(options.server);
      const toolIds = options.tool === undefined ? undefined : byTool.get(options.tool);
      if ((options.server !== undefined && !serverIds) || (options.tool !== undefined && !toolIds)) {
        return { tools: [], matched: 0 };
      }
      const allowed = (docId: number): boolean =>
        (serverIds === undefined || containsSorted(serverIds, docId)) &&
        (toolIds === undefined || containsSorted(toolIds, docId));

      const query = options.query;
      if (query === undefined || query.trim().length === 0) {
        if (serverIds === undefined && toolIds === undefined) {
          return { tools: stableOrder.slice(0, limit).map((docId) => docs[docId].tool), matched: docs.length };
        }
        const candidates = serverIds === undefined ? toolIds! : toolIds === undefined ? serverIds :
          (serverIds.length <= toolIds.length ? serverIds : toolIds);
        const result: number[] = [];
        let matched = 0;
        for (const docId of candidates) {
          if (!allowed(docId)) continue;
          matched += 1;
          if (limit === 0) continue;
          const rank = docs[docId].tieRank;
          let insertion = result.length;
          while (insertion > 0 && docs[result[insertion - 1]].tieRank > rank) insertion -= 1;
          if (insertion >= limit) continue;
          result.splice(insertion, 0, docId);
          if (result.length > limit) result.pop();
        }
        return { tools: result.map((docId) => docs[docId].tool), matched };
      }

      const queryTerms = tokenize(query);
      if (queryTerms.length === 0) return { tools: [], matched: 0 };

      generation += 1;
      if (generation === 0x1_0000_0000) {
        marks.fill(0);
        generation = 1;
      }
      touched.length = 0;
      for (const term of queryTerms) {
        const posting = postingLists.get(term);
        if (!posting) continue;
        const values = posting.values;
        for (let i = 0; i < values.length; i += 2) {
          const docId = values[i];
          if (!allowed(docId)) continue;
          if (marks[docId] !== generation) {
            marks[docId] = generation;
            scores[docId] = 0;
            touched.push(docId);
          }
          const frequency = values[i + 1];
          const doc = docs[docId];
          scores[docId] += posting.idf * (frequency * (K1 + 1)) / (frequency + doc.lengthNorm);
        }
      }

      const matched = touched.length;
      if (matched === 0 || limit === 0) return { tools: [], matched };
      const heap: number[] = [];
      for (const docId of touched) {
        if (heap.length < limit) heapPush(heap, docId, scores, docs);
        else if (isBetter(docId, heap[0], scores, docs)) {
          heap[0] = docId;
          heapDown(heap, 0, scores, docs);
        }
      }
      heap.sort((a, b) => compareRank(a, b, scores, docs));
      return { tools: heap.map((docId) => docs[docId].tool), matched };
    },
  };
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function addToIndex(index: Map<string, number[]>, key: string, docId: number): void {
  let ids = index.get(key);
  if (!ids) index.set(key, ids = []);
  ids.push(docId);
}

function containsSorted(ids: number[], docId: number): boolean {
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (ids[middle] === docId) return true;
    if (ids[middle] < docId) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(value)));
}

function compareRank(a: number, b: number, scores: Float64Array, docs: Array<{ tieRank: number }>): number {
  return scores[b] - scores[a] || docs[a].tieRank - docs[b].tieRank;
}

function isBetter(a: number, b: number, scores: Float64Array, docs: Array<{ tieRank: number }>): boolean {
  return compareRank(a, b, scores, docs) < 0;
}

function heapPush(heap: number[], docId: number, scores: Float64Array, docs: Array<{ tieRank: number }>): void {
  let index = heap.length;
  heap.push(docId);
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (!isBetter(heap[parent], heap[index], scores, docs)) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function heapDown(heap: number[], start: number, scores: Float64Array, docs: Array<{ tieRank: number }>): void {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && isBetter(heap[left], heap[right], scores, docs)) worse = right;
    if (!isBetter(heap[index], heap[worse], scores, docs)) return;
    [heap[index], heap[worse]] = [heap[worse], heap[index]];
    index = worse;
  }
}
