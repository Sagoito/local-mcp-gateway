#!/usr/bin/env node
// Compare completed benchmark summaries without claiming a causal speedup.
import fs from 'node:fs/promises';
const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath)
  throw Error(
    'Usage: node benchmark/compare.mjs BEFORE/summary.json AFTER/summary.json',
  );
const [before, after] = await Promise.all(
  [beforePath, afterPath].map(async (p) =>
    JSON.parse(await fs.readFile(p, 'utf8')),
  ),
);
console.log(
  JSON.stringify(
    {
      warning:
        'Historical versus current hosted-agent timing is descriptive; consult contemporaneous direct controls and per-question results.',
      before: before.metrics,
      after: after.metrics,
      gatewayMedianChangePercent:
        100 *
        (after.metrics.gateway.medianAgentElapsedMs /
          before.metrics.gateway.medianAgentElapsedMs -
          1),
      questions: after.perQuestionMode
        .filter((x) => x.mode === 'gateway')
        .map((x) => ({
          question: x.questionId,
          beforeGatewayMs: before.perQuestionMode.find(
            (y) => y.mode === 'gateway' && y.questionId === x.questionId,
          )?.medianAgentElapsedMs,
          afterGatewayMs: x.medianAgentElapsedMs,
          currentDirectMs: after.perQuestionMode.find(
            (y) => y.mode === 'direct' && y.questionId === x.questionId,
          )?.medianAgentElapsedMs,
        })),
    },
    null,
    2,
  ),
);
