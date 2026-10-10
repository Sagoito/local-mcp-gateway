#!/usr/bin/env python3
"""Independently audit JS rankings using ToolRet's pytrec_eval metric backend."""
import gzip
import hashlib
import json
import random
import sys
from pathlib import Path
import pytrec_eval

def main():
    dataset_path = Path(sys.argv[1])
    root = Path(sys.argv[2])
    raw = dataset_path.read_bytes()
    dataset = json.loads(raw)
    manifest = json.loads((root / "manifest.json").read_text())
    assert manifest.get("executionDone") is True and manifest.get("validation", {}).get("passed") is True, "Refusing incomplete infrastructure results"
    assert hashlib.sha256(raw).hexdigest() == manifest["hashes"]["datasetSha256"]
    qrels = {q["id"]: q["relevance"] for q in dataset["queries"]}
    tool_ids = {t["id"] for t in dataset["tools"]}
    evaluator = pytrec_eval.RelevanceEvaluator(qrels, {"ndcg_cut.5,10", "recall.5,10", "P.5,10"})
    audits, conditions = {}, {}
    metric_map = {"ndcg5": "ndcg_cut_5", "ndcg10": "ndcg_cut_10", "recall5": "recall_5", "recall10": "recall_10", "precision5": "P_5", "precision10": "P_10"}
    for condition in ["gateway", "bm25"]:
        with gzip.open(root / (condition + ".jsonl.gz"), "rt") as handle:
            rows = [json.loads(line) for line in handle]
        assert len(rows) == len(dataset["queries"])
        conditions[condition] = rows
        scores, max_difference = {}, 0.0
        for query, row in zip(dataset["queries"], rows):
            assert row["queryId"] == query["id"]
            assert row["querySha256"] == hashlib.sha256(query["query"].encode()).hexdigest()
            assert row["qrels"] == query["relevance"]
            assert len(row["ranking"]) <= 10 and len(row["ranking"]) == len(set(row["ranking"]))
            assert set(row["ranking"]) <= tool_ids
            assert not row["error"] or not row["ranking"], "Error rows must have empty rankings and zero scores"
            # Empty rankings must remain in the denominator, even if the backend
            # omits an empty result row. A real corpus document receives score 0.
            scores[row["queryId"]] = {tool_id: float(10 - rank) for rank, tool_id in enumerate(row["ranking"])}
        trec = evaluator.evaluate(scores)
        for row in rows:
            expected = trec.get(row["queryId"], {})
            for local, official in metric_map.items():
                diff = abs(row["metrics"][local] - expected.get(official, 0.0))
                max_difference = max(max_difference, diff)
                assert diff < 1e-10, (condition, row["queryId"], local, diff)
            for k in [5, 10]:
                complete = int(row["metrics"]["recall" + str(k)] == 1)
                assert row["metrics"]["completeness" + str(k)] == complete
        averages = {local: sum(trec.get(row["queryId"], {}).get(official, 0.0) for row in rows) / len(rows) for local, official in metric_map.items()}
        for metric, value in averages.items():
            assert abs(value - manifest["summary"][condition][metric]) < 1e-10
        audits[condition] = {"queriesAudited": len(rows), "maxMetricDifference": max_difference, "officialBackendMacroScores": averages,
                             "errors": sum(bool(row["error"]) for row in rows), "noErrorSubset": {"queries": sum(not row["error"] for row in rows),
                             "ndcg10": sum(row["metrics"]["ndcg10"] for row in rows if not row["error"]) / sum(not row["error"] for row in rows)}}
    # Paired query bootstrap: uncertainty over this public query population;
    # deterministic retrieval has no model sampling uncertainty here.
    rng = random.Random(901)
    values = {c: [row["metrics"]["ndcg10"] for row in rows] for c, rows in conditions.items()}
    samples = {"gateway": [], "bm25": [], "gatewayMinusBM25": []}
    n = len(dataset["queries"])
    for _ in range(1000):
        indices = [rng.randrange(n) for _ in range(n)]
        g = sum(values["gateway"][i] for i in indices) / n
        b = sum(values["bm25"][i] for i in indices) / n
        samples["gateway"].append(g); samples["bm25"].append(b); samples["gatewayMinusBM25"].append(g - b)
    ci = {c: [sorted(v)[24], sorted(v)[974]] for c, v in samples.items()}
    accepted_indices = [i for i in range(n) if not conditions["gateway"][i]["error"] and not conditions["bm25"][i]["error"]]
    matched_subset = {"queries": len(accepted_indices), "primary": False, "definition": "queries with no errors in either condition", "scores": {
        c: sum(values[c][i] for i in accepted_indices) / len(accepted_indices) if accepted_indices else 0.0 for c in values}}
    output = {"passed": True, "backend": "pytrec-eval-terrier 0.5.10 (pytrec_eval API)", "authorProtocol": "toolret/eval.py trec_eval", "conditions": audits,
              "matchedAcceptedInputDiagnostic": matched_subset,
              "pairedQueryBootstrap": {"seed": 901, "samples": 1000, "percentile95CI": ci, "note": "Query resampling only; not model variance, vendor comparison, or latency significance."}}
    (root / "audit.json").write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()
