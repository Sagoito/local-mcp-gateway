#!/usr/bin/env python3
"""Render the public-v9 report after the independent audit has passed."""
import json
import sys
from pathlib import Path


METRICS = ["ndcg10", "hit1", "hit5", "hit10", "recall10", "completeness10", "mrr10"]
LABELS = {
    "ndcg10": "nDCG@10", "hit1": "Hit@1", "hit5": "Hit@5", "hit10": "Hit@10",
    "recall10": "Recall@10", "completeness10": "Completeness@10", "mrr10": "MRR@10",
}


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cannot read {path}: {exc}")


def fmt(value):
    return f"{value:.4f}"


def row(label, metrics):
    return "| " + label + " | " + " | ".join(fmt(metrics[m]) for m in METRICS) + " |"


def build(root):
    manifest = read_json(root / "manifest.json")
    audit = read_json(root / "audit.json")
    meta = manifest.get("metadata", {})
    validation = manifest.get("validation", {})
    if manifest.get("executionDone") is not True or validation.get("passed") is not True:
        raise SystemExit("Refusing to report: manifest executionDone and validation.passed must both be true")
    if audit.get("passed") is not True:
        raise SystemExit("Refusing to report: audit.passed must be true")
    expected = int(meta.get("queries", 0))
    if expected != 7961 or int(meta.get("tools", 0)) != 44453:
        raise SystemExit("Refusing to report: expected ToolRet-full counts (44,453 tools, 7,961 queries) are absent")
    cond = audit.get("conditions", {})
    for name in ("gateway", "bm25"):
        if name not in cond or cond[name].get("queriesAudited") != expected:
            raise SystemExit(f"Refusing to report: {name} did not audit all {expected} queries")
    summary = manifest.get("summary", {})
    if any(name not in summary for name in ("gateway", "bm25")):
        raise SystemExit("Refusing to report: missing primary condition summaries")
    errors = {name: cond[name].get("errors") for name in ("gateway", "bm25")}
    for name in ("gateway", "bm25"):
        if errors[name] != summary[name].get("errors"):
            raise SystemExit(f"Refusing to report: audited {name} error count does not match manifest")
    if errors["gateway"] != int(meta.get("queriesOverGateway500CharacterLimit", -1)):
        raise SystemExit("Refusing to report: audited gateway errors do not match the recorded over-limit query count")
    for name in ("gateway", "bm25"):
        official = cond[name].get("officialBackendMacroScores", {})
        if not all(metric in official for metric in ("ndcg10", "recall10", "precision10")):
            raise SystemExit(f"Refusing to report: audited {name} official macro scores are incomplete")
        for metric, value in official.items():
            if metric not in summary[name] or abs(float(value) - float(summary[name][metric])) >= 1e-10:
                raise SystemExit(f"Refusing to report: audited {name} {metric} does not match manifest summary")
    boot = audit.get("pairedQueryBootstrap", {}).get("percentile95CI", {})
    if not all(k in boot for k in ("gateway", "bm25", "gatewayMinusBM25")):
        raise SystemExit("Refusing to report: missing paired bootstrap intervals")
    matched = audit.get("matchedAcceptedInputDiagnostic", {})
    n = expected
    out = [
        "# Public retrieval benchmark: public-v9",
        "",
        "## Result",
        "",
        "On this public retrieval task, the production gateway retrieved relevant tools weakly compared with the fixed local BM25 baseline. This is a retrieval-only result: it does not measure tool execution, answer quality, or live vendor systems.",
        "",
        "## Scores",
        "",
        f"The primary denominator is all **{n:,} original queries**. Failed requests remain in the denominator with zero retrieval scores. Metrics are macro averages; nDCG uses the benchmark's linear gains.",
        "",
        "| Condition | " + " | ".join(LABELS[m] for m in METRICS) + " |",
        "|---|" + "---:|" * len(METRICS),
        row("Gateway (primary)", summary["gateway"]),
        row("Fixed BM25 (primary)", summary["bm25"]),
        "",
        f"Paired query bootstrap (1,000 resamples; seed {audit.get('pairedQueryBootstrap', {}).get('seed', 'not recorded')}), 95% percentile intervals for nDCG@10: gateway **[{fmt(boot['gateway'][0])}, {fmt(boot['gateway'][1])}]**, BM25 **[{fmt(boot['bm25'][0])}, {fmt(boot['bm25'][1])}]**, gateway minus BM25 **[{fmt(boot['gatewayMinusBM25'][0])}, {fmt(boot['gatewayMinusBM25'][1])}]**. This captures query-population resampling, not model sampling variance.",
        "",
        f"The accepted-input subset is secondary and diagnostic only ({matched.get('queries', 0):,} queries: no error in either condition). It must not be read as the primary result because it excludes rejected and failed inputs.",
        "",
        "| Accepted-input diagnostic | nDCG@10 |",
        "|---|---:|",
        f"| Gateway | {fmt(matched.get('scores', {}).get('gateway', 0))} |",
        f"| Fixed BM25 | {fmt(matched.get('scores', {}).get('bm25', 0))} |",
        "",
        "## Breakdown by query category",
        "",
        "Values below are nDCG@10, with query counts. The category results are descriptive; small groups can be noisy.",
        "",
        "| Category | Queries | Gateway | BM25 |",
        "|---|---:|---:|---:|",
    ]
    by_cat = summary["gateway"].get("byCategorySource", {}).get("category", {})
    bcat = summary["bm25"].get("byCategorySource", {}).get("category", {})
    for category in sorted(set(by_cat) | set(bcat)):
        gs, bs = by_cat.get(category, {}), bcat.get(category, {})
        count = int(gs.get("queries", bs.get("queries", 0)))
        out.append(f"| {category} | {count:,} | {fmt(gs.get('ndcg10', 0))} | {fmt(bs.get('ndcg10', 0))} |")
    out += [
        "",
        "Source-level nDCG@10 results are included in the root manifest's category/source summaries to avoid reproducing a very wide table here.",
        "",
        "## Dataset and protocol",
        "",
        "The run used the complete ToolRet-full corpus: **44,453 tools, 7,961 queries, 14,106 relevance labels, 35 sources, and all three tool categories**. Queries were sent unchanged, without generated instructions, label hints, rewrites, or truncation. Tool descriptions were the complete published documentation. Names preserved the original capability name in sanitized form with an opaque stable hash; source IDs map rankings to relevance labels. This preserves documentation and mapping fidelity while avoiding vendor-specific exact configuration claims. Query and document texts are not distributed in this report.",
        "",
        f"The gateway rejects inputs over its 500 UTF-16-code-unit limit. **{meta.get('queriesOverGateway500CharacterLimit', 'Recorded')}** queries exceeded it and remain zero-scored in the primary denominator. Audited errors: gateway {errors['gateway']:,}; BM25 {errors['bm25']:,}.",
        "",
        "The comparison is retrieval only. BM25 uses the frozen local implementation (k1=1.2, b=0.75; lowercase alphanumeric tokens; name plus documentation; deterministic name/ID tie-break). It is not the production gateway's internal BM25 configuration or a vendor's BM25 implementation. All rankings were checked with ToolRet's `pytrec_eval` API; maximum metric discrepancies and backend scores are in `audit.json`.",
        "",
        "## Runtime and execution history",
        "",
    ]
    prefix = manifest.get("sequentialPrefix", {})
    gr = prefix.get("gatewayRuntimeMs", {})
    br = prefix.get("bm25RuntimeMs", {})
    out.append(f"The first **1,000 source-order queries** ran sequentially. Their measured p50/p95 times were gateway SDK round-trip **{gr.get('p50', 0):.1f}/{gr.get('p95', 0):.1f} ms** and BM25 rank-only **{br.get('p50', 0):.1f}/{br.get('p95', 0):.1f} ms**. This prefix is not an answer-latency measurement and is not a representative latency sample for the full benchmark. SDK in-memory RPC excludes process I/O, network, upstream startup, and model inference; BM25 timings cover ranking only. The prefix data is retained as `sequential-prefix.json` inside the audit bundle.")
    out += [
        "",
        "Execution began with eight full-corpus workers; memory pressure caused three shards (1, 4, 5) to be killed. The retry pass targeted only failed shards, with up to three workers, while preserving successful shard outputs and verifying prefix and success hashes. An interrupted first recovery was restarted. These infrastructure events did not change the frozen query set or scoring protocol. Contended worker timings are not used as answer latency.",
        "",
        "## What this does not establish",
        "",
        "This run used no LLM, provider tokens, billing data, response-quality grading, or live vendor retrieval results. StackOne's public ToolRet figures are related published context, not measurements reproduced in our environment; differences in query mode, names, documentation, tie-breaking, and undisclosed vendor settings prevent exact-score claims. MCP-Atlas was not executed because Docker and a native model/judge endpoint were unavailable. Historical small pilots remain smoke/regression tests and are not competitive benchmark evidence.",
        "",
        "## Reproduction and artifacts",
        "",
        "Reproduce the frozen Tier 1 run with the instructions in [`COMPARABILITY_PLAN.md`](../../COMPARABILITY_PLAN.md). In brief: install `benchmark/public-requirements.txt`, run `public-prepare.py` (then `--offline` after download), run `public-retrieval.mjs`, independently audit with `public-audit.py`, then run this report generator. The public dataset is downloaded locally and is not redistributed here.",
        "",
        "Primary sources: [ToolRet evaluation code](https://github.com/mangopy/tool-retrieval-benchmark/blob/c4181d914a227134705ecb6bab13fbd92ccd2938/toolret/eval.py) and [StackOne Tool Discovery / ToolRet-full context](https://www.stackone.com/platform/tools-discovery/). See the [comparability plan](../../COMPARABILITY_PLAN.md), [protocol](protocol.json), [execution deviation record](execution-deviation.json), [manifest](manifest.json), [independent audit](audit.json), [gateway rankings](gateway.jsonl.gz), [BM25 rankings](bm25.jsonl.gz), [audit bundle (including sequential-prefix.json)](audit-bundle.tar.gz), and [retained infrastructure attempt archive](infrastructure-attempt.json.gz).",
        "",
        "The raw ranking files and `audit-bundle.tar.gz` are preserved with the run artifacts. Do not distribute query or document text from the source dataset.",
        "",
    ]
    return "\n".join(out)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python benchmark/public-report.py benchmark/results/public-v9")
    root = Path(sys.argv[1]).resolve()
    report = build(root)
    (root / "README.md").write_text(report, encoding="utf-8")
    print(f"Wrote {root / 'README.md'}")


if __name__ == "__main__":
    main()
