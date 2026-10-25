#!/usr/bin/env python3
"""Plot repetition-level metrics from the validated Node.js analysis report."""
import argparse
import json
import os
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent
os.environ.setdefault("MPLCONFIGDIR", str(project_root / "work" / "matplotlib"))
os.environ.setdefault("MPLBACKEND", "Agg")
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


def plot(run_directory: Path, output_directory: Path) -> None:
    analysis_path = output_directory / "performance-comparison.json"
    report = json.loads(analysis_path.read_text(encoding="utf-8"))
    if report.get("status") != "validated" or report.get("protocol") != "sap-http-benchmark-v1":
        raise ValueError("Run the validating analysis script before plotting.")
    if Path(report["source"]["run_directory"]).resolve() != run_directory.resolve():
        raise ValueError("The analysis report belongs to another run directory.")
    if len(report.get("blocks", [])) != 9 or len(report.get("summaries", [])) != 3:
        raise ValueError("All nine repetition blocks are required.")
    real_docs = Path(__file__).resolve().parent.parent / "docs"
    if report.get("synthetic_test_data") and output_directory.resolve() == real_docs.resolve():
        raise ValueError("Synthetic charts must remain outside the real docs output.")

    colors = {"node": "#2468a0", "rust": "#b96026", "abap": "#28816a"}
    names = {"node": "Node.js", "rust": "Rust", "abap": "ABAP"}
    implementations = ["node", "rust", "abap"]
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False, "savefig.facecolor": "white", "svg.fonttype": "none"})
    figure, (latency, throughput) = plt.subplots(1, 2, figsize=(12, 5.7))
    for position, implementation in enumerate(implementations):
        blocks = sorted((block for block in report["blocks"] if block["implementation"] == implementation), key=lambda block: block["round"])
        if len(blocks) != 3:
            raise ValueError("Each client needs three repetition blocks.")
        summary = next(item for item in report["summaries"] if item["implementation"] == implementation)
        color = colors[implementation]
        for offset, block in zip((-0.14, 0, 0.14), blocks):
            x = position + offset
            p50, p95 = block["p50_ms"] / 1000, block["p95_ms"] / 1000
            latency.plot([x, x], [p50, p95], color=color, alpha=0.25, linewidth=1)
            latency.scatter(x, p50, marker="o", color=color, s=42, zorder=3)
            latency.scatter(x, p95, marker="^", facecolors="white", edgecolors=color, linewidths=1.4, s=48, zorder=3)
            throughput.scatter(x, block["useful_rows_per_second"], color=color, s=45, zorder=3)
            throughput.annotate(f"R{block['round']}", (x, block["useful_rows_per_second"]), xytext=(0, 7), textcoords="offset points", ha="center", fontsize=8, color=color)
        latency.hlines(summary["p50_ms"]["median"] / 1000, position - 0.27, position + 0.27, color=color, linewidth=2)
        latency.hlines(summary["p95_ms"]["median"] / 1000, position - 0.27, position + 0.27, color=color, linewidth=1.5, linestyles="--")
        throughput.hlines(summary["useful_rows_per_second"]["median"], position - 0.27, position + 0.27, color=color, linewidth=2)
    for axis in (latency, throughput):
        axis.set_xticks(range(3), [names[item] for item in implementations])
        axis.set_xlim(-0.5, 2.5)
        axis.set_ylim(bottom=0)
        axis.grid(axis="y", alpha=0.18)
        axis.set_axisbelow(True)
    latency.set_title("Complete-scan latency", loc="left", fontweight="bold")
    latency.set_ylabel("Seconds per validated 5,000-position scan")
    latency.legend(handles=[Line2D([], [], marker="o", color="#555555", linestyle="None", label="Repetition p50"), Line2D([], [], marker="^", markerfacecolor="white", color="#555555", linestyle="None", label="Repetition p95")], frameon=False, loc="best")
    throughput.set_title("Useful throughput", loc="left", fontweight="bold")
    throughput.set_ylabel("Validated positions per measured wall second")
    synthetic = report.get("synthetic_test_data", False)
    title = "SYNTHETIC TEST DATA — no performance claim" if synthetic else "SAP polling over real HTTP"
    figure.suptitle(title, fontsize=16, fontweight="bold", x=0.075, ha="left", y=0.98)
    figure.text(0.075, 0.905, f"Three repetitions per client · at least {report['configuration']['duration_seconds']} s each · fresh client per scan", fontsize=10, color="#555555")
    figure.text(0.075, 0.075, "Points show individual repetitions; horizontal marks show their median. No confidence interval is implied.", fontsize=9, color="#555555")
    figure.text(0.075, 0.035, "ABAP shares SAP resources and has a different network placement. Results describe these implementations and this local topology.", fontsize=9, color="#555555")
    figure.subplots_adjust(top=0.83, bottom=0.19, left=0.075, right=0.98, wspace=0.28)
    for extension in ("png", "svg"):
        figure.savefig(output_directory / f"performance-comparison.{extension}", dpi=180, metadata={"Title": title, "Description": "Repetition-level latency and useful throughput; no pooled significance or language ranking."})
    plt.close(figure)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent.parent / "docs")
    options = parser.parse_args()
    try:
        plot(options.run_directory, options.output_dir)
    except (OSError, KeyError, ValueError) as error:
        parser.exit(1, f"Plot refused: {error}\n")
    print(f"Wrote PNG and SVG plots to {options.output_dir}")
