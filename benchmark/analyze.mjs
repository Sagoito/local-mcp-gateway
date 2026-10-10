#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getEncoding } from 'js-tiktoken';

const [runsArg, outputArg] = process.argv.slice(2);
if (!runsArg || !outputArg) throw new Error('Usage: node benchmark/analyze.mjs RUNS_DIR OUTPUT_DIR');
const runsDir = path.resolve(runsArg);
const outputDir = path.resolve(outputArg);
const enc = getEncoding('o200k_base');
const json = v => JSON.stringify(v);
const bytes = v => Buffer.byteLength(typeof v === 'string' ? v : json(v) ?? '', 'utf8');
const tokens = v => enc.encode(typeof v === 'string' ? v : json(v) ?? '').length;
const median = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function maybeJson(file) { try { return await readJson(file); } catch { return null; } }
function parseAnswer(answer) {
  if (answer && typeof answer === 'object') return answer;
  if (typeof answer !== 'string') return null;
  try { return JSON.parse(answer); } catch { return null; }
}
function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function percentileLine(rows, key) {
  const vals = rows.filter(r => r.status === 'complete').map(r => r[key]).filter(Number.isFinite);
  return vals.length ? `p50 ${key}: ${median(vals).toFixed(1)} ms (n=${vals.length})` : `p50 ${key}: n/a`;
}

const dirs = (await readdir(runsDir, { withFileTypes: true })).filter(d => d.isDirectory() && /^q[1-6]-(direct|gateway)-r[12]$/.test(d.name)).map(d => d.name).sort();
const rows = [];
for (const runId of dirs) {
  const dir = path.join(runsDir, runId);
  const cfg = await maybeJson(path.join(dir, 'config.json'));
  if (!cfg) continue;
  const events = [];
  try {
    for (const line of (await readFile(path.join(dir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean)) {
      try { const event = JSON.parse(line); if (!events.some(e => e.id === event.id)) events.push(event); } catch { /* malformed event retained via status below */ }
    }
  } catch { /* run can be incomplete */ }
  const answerFile = await maybeJson(path.join(dir, 'answer.json'));
  const question = cfg.question ?? {};
  const questionId = question.id ?? cfg.questionId ?? cfg.question_id ?? 'unknown';
  const prompt = await readFile(path.join(dir, 'prompt.txt'), 'utf8').catch(() => question.prompt ?? cfg.prompt ?? '');
  const expected = question.expected ?? cfg.expected;
  const finalValue = parseAnswer(answerFile?.answer);
  const hasFinish = events.some(e => e.op === 'finish');
  const failed = events.some(e => e.error) || (!answerFile && events.length > 0 && hasFinish);
  const status = answerFile && hasFinish ? 'complete' : failed ? 'failed' : 'missing';
  const pass = status === 'complete' && expected !== undefined && finalValue !== null && equal(finalValue, expected);
  const listEvents = events.filter(e => e.op === 'list');
  const callEvents = events.filter(e => e.op === 'call');
  const finishEvents = events.filter(e => e.op === 'finish');
  const definitions = listEvents.find(e => e.response)?.response;
  const definitionJson = definitions == null ? '' : json(definitions);
  const toolResponseTokens = callEvents.reduce((n, e) => n + tokens(e.response ?? ''), 0);
  const requestTokens = callEvents.reduce((n, e) => n + tokens({ name: e.name, args: e.args }), 0);
  const finalAnswerTokens = answerFile ? tokens(answerFile.answer) : 0;
  const promptTokens = tokens(prompt);
  const definitionTokens = tokens(definitionJson);
  const responseAndRequestTokens = callEvents.reduce((n, e) => n + tokens(e.response ?? '') + tokens({ name: e.name, args: e.args }), 0);
  const decisionEvents = events.filter(e => e.op === 'list' || e.op === 'call');
  let carried = 0;
  let cumulativeInput = 0;
  for (const e of decisionEvents) {
    cumulativeInput += promptTokens + carried;
    carried += tokens({ name: e.name, args: e.args });
    carried += tokens(e.response ?? '');
  }
  if (answerFile) cumulativeInput += promptTokens + carried;
  const firstList = listEvents[0];
  const lastFinish = finishEvents.at(-1);
  const rpcTotal = events.reduce((n, e) => n + (Number(e.durationMs) || 0), 0);
  const agentElapsed = firstList && lastFinish ? Math.max(0, Date.parse(lastFinish.startedAt) - Date.parse(firstList.startedAt)) : null;
  const rawFinishAnswer = lastFinish?.answer ?? answerFile?.answer;
  const outputTokens = requestTokens + finalAnswerTokens;
  rows.push({
    runId, questionId, mode: cfg.mode ?? 'unknown', repetition: cfg.repetition ?? cfg.repetitionId ?? '', status,
    pass: status === 'complete' ? Boolean(pass) : null,
    expected: expected ?? null, answer: finalValue, error: events.find(e => e.error)?.error ?? null,
    toolCalls: callEvents.length, toolErrors: callEvents.filter(e => e.error || e.response?.isError).length,
    initialToolListBytes: bytes(definitionJson), initialToolListTokens: definitionTokens,
    toolResponseTokens, requestArgumentTokens: requestTokens, finalAnswerTokens,
    finalPayloadTokenProxy: promptTokens + definitionTokens + responseAndRequestTokens + finalAnswerTokens,
    cumulativeInputTokenProxy: cumulativeInput, outputTokenProxy: outputTokens,
    inputProxyCostAt1USDPerMTokens: cumulativeInput / 1_000_000,
    outputProxyCostAt1USDPerMTokens: outputTokens / 1_000_000,
    listRpcMs: listEvents.reduce((n, e) => n + (Number(e.durationMs) || 0), 0),
    firstListColdSetupMs: firstList ? Number(firstList.durationMs) || 0 : null,
    callRpcTotalMs: callEvents.reduce((n, e) => n + (Number(e.durationMs) || 0), 0),
    callRpcMedianMs: median(callEvents.map(e => Number(e.durationMs))),
    rpcTotalMs: rpcTotal, agentElapsedMs: Number.isFinite(agentElapsed) ? agentElapsed : null,
    promptTokens, rawFinishAnswer: rawFinishAnswer ?? null,
  });
}

const fields = ['runId','questionId','mode','repetition','status','pass','toolCalls','toolErrors','initialToolListBytes','initialToolListTokens','toolResponseTokens','requestArgumentTokens','finalAnswerTokens','finalPayloadTokenProxy','cumulativeInputTokenProxy','outputTokenProxy','inputProxyCostAt1USDPerMTokens','outputProxyCostAt1USDPerMTokens','firstListColdSetupMs','listRpcMs','callRpcTotalMs','callRpcMedianMs','rpcTotalMs','agentElapsedMs','error'];
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'runs.csv'), [fields.join(','), ...rows.map(r => fields.map(f => csvCell(r[f])).join(','))].join('\n') + '\n');
const overall = {};
for (const mode of ['direct','gateway']) {
  const selected = rows.filter(r => r.mode === mode);
  const complete = selected.filter(r => r.status === 'complete');
  overall[mode] = {
    totalRuns: selected.length, completeRuns: complete.length, missingRuns: selected.filter(r => r.status === 'missing').length,
    failedRuns: selected.filter(r => r.status === 'failed').length, passes: complete.filter(r => r.pass).length,
    passRateAmongComplete: complete.length ? complete.filter(r => r.pass).length / complete.length : null,
    medianAgentElapsedMs: median(complete.map(r => r.agentElapsedMs)),
    medianCallRpcMs: median(complete.map(r => r.callRpcTotalMs)),
    medianFinalPayloadTokenProxy: median(complete.map(r => r.finalPayloadTokenProxy)),
    cumulativeInputTokenProxy: complete.reduce((n, r) => n + r.cumulativeInputTokenProxy, 0),
    outputTokenProxy: complete.reduce((n, r) => n + r.outputTokenProxy, 0),
    inputProxyCostAt1USDPerMTokens: complete.reduce((n, r) => n + r.cumulativeInputTokenProxy, 0) / 1_000_000,
    outputProxyCostAt1USDPerMTokens: complete.reduce((n, r) => n + r.outputTokenProxy, 0) / 1_000_000,
  };
}
const groups = [...new Set(rows.map(r => `${r.questionId}\t${r.mode}`))].sort().map(k => {
  const [questionId, mode] = k.split('\t');
  const group = rows.filter(r => r.questionId === questionId && r.mode === mode);
  const complete = group.filter(r => r.status === 'complete');
  return { questionId, mode, runs: group.length, complete: complete.length, passRateAmongComplete: complete.length ? complete.filter(r => r.pass).length / complete.length : null,
    medianAgentElapsedMs: median(complete.map(r => r.agentElapsedMs)), medianCallRpcMs: median(complete.map(r => r.callRpcTotalMs)),
    medianFinalPayloadTokenProxy: median(complete.map(r => r.finalPayloadTokenProxy)) };
});
const pairKeys = [...new Set(rows.map(r => `${r.questionId}\t${r.repetition}`))];
const paired = [];
for (const key of pairKeys) {
  const [questionId, repetition] = key.split('\t');
  const direct = rows.find(r => r.questionId === questionId && String(r.repetition) === repetition && r.mode === 'direct');
  const gateway = rows.find(r => r.questionId === questionId && String(r.repetition) === repetition && r.mode === 'gateway');
  if (direct?.status === 'complete' && gateway?.status === 'complete') paired.push({ questionId, repetition, directPass: direct.pass, gatewayPass: gateway.pass, directElapsedMs: direct.agentElapsedMs, gatewayElapsedMs: gateway.agentElapsedMs });
}
const pairedPassDiff = paired.length ? paired.filter(p => p.gatewayPass).length / paired.length - paired.filter(p => p.directPass).length / paired.length : null;
const summary = { generatedAt: new Date().toISOString(), runsDir, runCount: rows.length, metrics: overall, perQuestionMode: groups, pairedCompleteCount: paired.length,
  pairedPassRateDifferenceGatewayMinusDirect: pairedPassDiff, pairedRuns: paired, caveats: [
    'Token values are UTF-8 text tokenization proxies using o200k_base, not Luna/provider-reported usage.',
    'No billed tokens, provider usage records, or actual Luna pricing are available; cost is unpriced and must not be presented as billed cost.',
    'Agent elapsed time spans first list request to finish request start and includes generic bridge orchestration; it is not model-only latency.',
    'First list RPC duration includes cold connection/setup. Subsequent RPC timings are reported separately.',
    'Accumulated payload and cumulative input are payload estimates and exclude system prompts, built-in tool definitions, reasoning, and provider framing.',
    'Both conditions use the same generic bridge; this is not a native tool registry injection or Copilot deferred-definition baseline.',
    'Daemon payload proxies can exceed model-visible content when the host truncates output; no actual billing savings are established.',
    'The planned design has two repetitions per question and condition, too few to support statistical significance claims.'
  ] };
await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const fmt = n => Number.isFinite(n) ? `${n.toFixed(1)} ms` : 'n/a';
let report = `# Benchmark analysis\n\nSee [interpretation and limitations](README.md). These are daemon payload proxies, not measured model context or usage. Direct large-file output was observed truncated by the host.

Runs analyzed: ${rows.length}. Missing and failed runs remain visible in the run table and are excluded from completed-run medians.\n\n`;
report += `| Condition | Complete | Missing | Failed | Pass rate among complete | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |\n|---|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const mode of ['direct','gateway']) {
  const m = overall[mode];
  report += `| ${mode} | ${m.completeRuns} | ${m.missingRuns} | ${m.failedRuns} | ${m.passRateAmongComplete == null ? 'n/a' : `${(100*m.passRateAmongComplete).toFixed(1)}%`} | ${fmt(m.medianAgentElapsedMs)} | ${fmt(m.medianCallRpcMs)} | ${m.medianFinalPayloadTokenProxy ?? 'n/a'} tokens |\n`;
}
report += `\nPaired complete runs: ${paired.length}. Paired pass-rate difference (gateway minus direct): ${pairedPassDiff == null ? 'n/a' : `${(100*pairedPassDiff).toFixed(1)} percentage points`}. This is descriptive only; two repetitions per question cannot support statistical significance claims.\n\n`;
report += `## Per-question results\n\n| Question | Condition | Complete / runs | Pass rate | p50 elapsed | p50 call RPC total | p50 accumulated payload proxy |\n|---|---|---:|---:|---:|---:|---:|\n`;
for (const g of groups) report += `| ${g.questionId} | ${g.mode} | ${g.complete} / ${g.runs} | ${g.passRateAmongComplete == null ? 'n/a' : `${(100*g.passRateAmongComplete).toFixed(1)}%`} | ${fmt(g.medianAgentElapsedMs)} | ${fmt(g.medianCallRpcMs)} | ${g.medianFinalPayloadTokenProxy ?? 'n/a'} tokens |\n`;
report += `\n## Timing and cost interpretation\n\n`;
report += `The first list request is the cold setup phase; its daemon RPC duration includes connection setup. Later tool-call RPC totals and per-call medians are reported separately in [runs.csv](runs.csv). Agent elapsed time is measured from the first list request start through the finish request start and includes the generic bridge/orchestration path.\n\n`;
report += `Token counts are UTF-8 text tokenization proxies with o200k_base, not reported Luna or provider usage. The accumulated-payload estimate sums prompt, initial tool definitions, serialized tool requests/responses, and final answer once. The cumulative input proxy replays accumulated visible payload for each bridge decision, adding definitions after list returns. Both exclude potentially material content: system prompts, built-in tool definitions, reasoning, and provider framing are excluded. Input and output proxy amounts are also normalized separately to a hypothetical $1 per million tokens; they are scenario units, not actual Luna pricing, bills, or costs.\n\n`;
report += `The two conditions use the same generic bridge. This comparison does not measure native tool registry injection or a Copilot deferred-definition baseline. The planned two repetitions per question are too few for statistical significance claims. See [summary.json](summary.json) and [runs.csv](runs.csv); raw event logs remain in the input run directories.\n`;
await writeFile(path.join(outputDir, 'REPORT.md'), report);
console.log(`Analyzed ${rows.length} runs into ${outputDir}`);
