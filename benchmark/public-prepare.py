#!/usr/bin/env python3
"""Download pinned ToolRet evaluation files and preserve their queries/qrels.

Dependencies: Python 3.10+, pyarrow==21.0.0. Downloads are outside git by default.
No model, embedding service, SaaS account, or training data is used.
"""
import argparse
import concurrent.futures
import hashlib
import json
import re
import urllib.request
from pathlib import Path
import pyarrow.parquet as pq

PINS = {
    "ToolRet-Tools": "e06c38c75612b6536bd959e08cdd345894aba6a7",
    "ToolRet-Queries": "b8c76ad3349ff17497b6bdb28bb5b8f61a0f6445",
}
CATEGORIES = ["code", "customized", "web"]
SOURCES = "apibank apigen appbench autotools-food autotools-music autotools-weather craft-math-algebra craft-tabmwp craft-vqa gorilla-huggingface gorilla-pytorch gorilla-tensor gpt4tools gta metatool mnms restgpt-spotify restgpt-tmdb reversechain rotbench t-eval-dialog t-eval-step taskbench-daily taskbench-huggingface taskbench-multimedia tool-be-honest toolace toolalpaca toolbench-sam toolbench toolemu tooleyes toolink toollens ultratool".split()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("work", nargs="?", default=".local/public-data")
    parser.add_argument("--offline", action="store_true", help="use already downloaded pinned files")
    args = parser.parse_args()
    root = Path(args.work).resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock = json.loads((Path(__file__).with_name("public-dataset-lock.json")).read_text())
    files = [(repo, part, f"{part}/{'tools' if repo.endswith('Tools') else 'queries'}-00000-of-00001.parquet")
             for repo, parts in [("ToolRet-Tools", CATEGORIES), ("ToolRet-Queries", SOURCES)] for part in parts]

    def acquire(item):
        repo, _, filename = item
        dest = root / repo / filename
        if not dest.exists():
            if args.offline:
                raise FileNotFoundError(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            url = f"https://huggingface.co/datasets/mangopy/{repo}/resolve/{PINS[repo]}/{filename}"
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read()
            if not data.startswith(b"PAR1"):
                raise ValueError(f"Not Parquet: {filename}")
            temp = dest.with_suffix(".part")
            temp.write_bytes(data)
            temp.replace(dest)
        actual = digest(dest.read_bytes())
        if actual != lock["files"][f"{repo}/{filename}"]["sha256"]:
            raise ValueError(f"Dataset hash mismatch: {dest}")
        return dest

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        downloaded = list(pool.map(acquire, files))
    tools, queries = [], []
    for (repo, part, _), filename in zip(files, downloaded):
        for row in pq.read_table(filename).to_pylist():
            if repo.endswith("Tools"):
                # Preserve capability names; a stable opaque suffix resolves
                # duplicate function names without adding source/category hints.
                document = json.loads(row["documentation"])
                original_name = document.get("name") if isinstance(document, dict) else None
                if not isinstance(original_name, str) or not original_name:
                    original_name = "unnamed"
                prefix = re.sub(r"[^a-zA-Z0-9_-]", "_", original_name)[:49]
                name = prefix + "__" + digest(row["id"].encode())[:12]
                tools.append({"id": row["id"], "name": name, "description": row["documentation"], "category": part})
            else:
                labels = json.loads(row["labels"])
                relevance = {x["id"]: int(x["relevance"]) for x in labels}
                if len(relevance) != len(labels) or not relevance or any(v <= 0 for v in relevance.values()):
                    raise ValueError(f"Invalid relevance labels: {row['id']}")
                queries.append({"id": row["id"], "query": row["query"], "relevance": relevance, "category": row["category"], "source": part})
    if len(tools) != 44453 or len(queries) != 7961:
        raise ValueError("Unexpected corpus size")
    tool_ids = {t["id"] for t in tools}
    if len(tool_ids) != len(tools) or len({q["id"] for q in queries}) != len(queries):
        raise ValueError("Duplicate source IDs")
    if any(set(q["relevance"]) - tool_ids for q in queries):
        raise ValueError("Unresolved relevance ID")
    metadata = {
        "benchmark": "ToolRet-full", "source": "https://github.com/mangopy/tool-retrieval-benchmark",
        "datasetRevisions": PINS, "lockSha256": digest(Path(__file__).with_name("public-dataset-lock.json").read_bytes()),
        "queryMode": "without instruction; original query unchanged", "toolMode": "MCP name=sanitized original capability name plus opaque ID hash; description=verbatim documentation; placeholder empty object inputSchema; retrieval only",
        "tools": len(tools), "queries": len(queries), "queriesOverGateway500CharacterLimit": sum(len(q["query"].encode('utf-16-le')) // 2 > 500 for q in queries),
        "generatedInstructionsUsed": False, "trainingDataUsed": False,
    }
    output = root / "toolret-full.json"
    output.write_text(json.dumps({"metadata": metadata, "tools": tools, "queries": queries}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "sha256": digest(output.read_bytes()), **metadata}, indent=2))

if __name__ == "__main__":
    main()
