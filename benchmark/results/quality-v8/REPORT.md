# Fresh quality benchmark analysis

32 run outcomes are retained. Completed runs are evaluated by canonical whole-answer equality and required-field accuracy. Evidence-reference precision and recall score exact reference strings only; they do not establish trace grounding or source use. Extra fields are reported as unexpectedFields without claims about factual support. Elapsed times include the generic bridge. Tool definitions and token proxies are not billed usage.

| Mode | Complete / runs | Exact answers | Required fields correct / total | Median evidence precision | Median evidence recall | Median elapsed | Runs with extra fields |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct | 16 / 16 | 14 | 32 / 34 | 1.000 | 1.000 | 6779.5 ms | 0 |
| gateway | 16 / 16 | 13 | 31 / 34 | 1.000 | 1.000 | 7373.0 ms | 0 |

Per-run outcomes and completeness are in [runs.csv](runs.csv); machine-readable definitions and caveats are in [summary.json](summary.json).
