#!/usr/bin/env python3
"""Plot validated native CDS and historical HTTP repetition metrics."""
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
from matplotlib.ticker import FuncFormatter


def plot(run_directory: Path, output_directory: Path) -> None:
    report = json.loads((output_directory / "cds-comparison.json").read_text(encoding="utf-8"))
    if report.get("status") != "validated" or report.get("protocol") != "sap-cds-benchmark-v1":
        raise ValueError("Run the validating CDS analysis script before plotting.")
    if Path(report["source"]["run_directory"]).resolve() != run_directory.resolve():
        raise ValueError("The comparison belongs to another run directory.")
    if len(report.get("blocks", [])) != 3 or len(report.get("http_blocks", [])) != 9 or len(report.get("summaries", [])) != 4:
        raise ValueError("Three native and nine historical HTTP blocks are required.")
    if report.get("synthetic_test_data") and output_directory.resolve() == (project_root / "docs").resolve():
        raise ValueError("Synthetic charts must remain outside the real docs output.")

    implementations = ["abap_cds", "abap_http", "node_http", "rust_http"]
    names = ["ABAP direct CDS\nnew run", "ABAP HTTP\nsaved", "Node.js HTTP\nsaved", "Rust HTTP\nsaved"]
    colors = {"abap_cds": "#694aa0", "abap_http": "#28816a", "node_http": "#2468a0", "rust_http": "#b96026"}
    blocks = report["blocks"] + report["http_blocks"]
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False, "savefig.facecolor": "white", "svg.fonttype": "none"})
    figure = plt.figure(figsize=(13, 10))
    layout = figure.add_gridspec(2, 2, height_ratios=(1, 0.85))
    latency = figure.add_subplot(layout[0, 0])
    throughput = figure.add_subplot(layout[0, 1])
    sequence = figure.add_subplot(layout[1, :])
    for position, implementation in enumerate(implementations):
        repetitions = sorted((item for item in blocks if item["implementation"] == implementation), key=lambda item: item["round"])
        if len(repetitions) != 3:
            raise ValueError("Each access path needs three repetition blocks.")
        summary = next(item for item in report["summaries"] if item["implementation"] == implementation)
        color = colors[implementation]
        for offset, block in zip((-0.15, 0, 0.15), repetitions):
            x = position + offset
            p50, p95, rate = block["p50_ms"], block["p95_ms"], block["useful_rows_per_second"]
            if min(p50, p95, rate) <= 0:
                raise ValueError("Logarithmic plots require positive validated metrics.")
            latency.plot([x, x], [p50, p95], color=color, alpha=0.25, linewidth=1)
            latency.scatter(x, p50, marker="o", color=color, s=43, zorder=3)
            latency.scatter(x, p95, marker="^", facecolors="white", edgecolors=color, linewidths=1.4, s=49, zorder=3)
            throughput.scatter(x, rate, color=color, s=45, zorder=3)
            throughput.annotate(f"R{block['round']}", (x, rate), xytext=(0, 8), textcoords="offset points", ha="center", fontsize=8, color=color)
        latency.hlines(summary["p50_ms"]["median"], position - 0.29, position + 0.29, color=color, linewidth=2)
        latency.hlines(summary["p95_ms"]["median"], position - 0.29, position + 0.29, color=color, linewidth=1.5, linestyles="--")
        throughput.hlines(summary["useful_rows_per_second"]["median"], position - 0.29, position + 0.29, color=color, linewidth=2)
    for axis in (latency, throughput):
        axis.set_xticks(range(4), names)
        axis.set_xlim(-0.55, 3.55)
        axis.set_yscale("log")
        axis.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:,.0f}" if value >= 1 else f"{value:g}"))
        axis.grid(axis="y", which="major", alpha=0.2)
        axis.set_axisbelow(True)
        axis.margins(y=0.18)
        axis.axvline(0.5, color="#bbbbbb", linewidth=1, linestyle=":")
    latency.set_title("Complete-scan latency · logarithmic scale", loc="left", fontweight="bold")
    latency.set_ylabel("Milliseconds per validated 5,000-position scan")
    latency.legend(handles=[Line2D([], [], marker="o", color="#555555", linestyle="None", label="Repetition p50"), Line2D([], [], marker="^", markerfacecolor="white", color="#555555", linestyle="None", label="Repetition p95")], frameon=False, loc="best")
    throughput.set_title("Useful throughput · logarithmic scale", loc="left", fontweight="bold")
    throughput.set_ylabel("Validated positions per measured wall second")
    sequence_colors = ["#694aa0", "#28816a", "#b96026"]
    first_slow = []
    for color, block in zip(sequence_colors, sorted(report["blocks"], key=lambda item: item["round"])):
        series = block.get("latency_series", [])
        if len(series) != block["successful_scans"]:
            raise ValueError("Native sequence samples must match the measured scan count.")
        sequence.plot([item["scan_index"] for item in series], [item["elapsed_ms"] for item in series], color=color, linewidth=0.8, alpha=0.8, label=f"Repetition {block['round']}")
        if block["late_slowdown"]["first_scan_index"] is not None:
            first_slow.append(block["late_slowdown"]["first_scan_index"])
    if first_slow and len(set(first_slow)) == 1:
        onset = first_slow[0]
        sequence.axvline(onset, color="#555555", linestyle=":", linewidth=1.2)
        sequence.annotate(f"All three: scans >1 s from index {onset}\nCause of the late change is unresolved", xy=(onset, 1000), xytext=(0.37, 0.64), textcoords="axes fraction", arrowprops={"arrowstyle": "->", "color": "#555555"}, fontsize=9, color="#444444")
    sequence.set_title("Native latency over the complete measured sequence · linear scales", loc="left", fontweight="bold")
    sequence.set_xlabel("Measured scan index (zero-based; warmup excluded)")
    sequence.set_ylabel("Milliseconds per scan")
    sequence.set_ylim(bottom=0)
    sequence.grid(axis="y", alpha=0.18)
    sequence.legend(frameon=False, loc="upper left", ncols=3)
    synthetic = report.get("synthetic_test_data", False)
    title = "SYNTHETIC TEST DATA — no performance claim" if synthetic else "Direct CDS and saved HTTP access paths"
    figure.suptitle(title, fontsize=16, fontweight="bold", x=0.075, ha="left", y=0.98)
    figure.text(0.075, 0.935, "Three repetitions per path · frozen 5,000 rows and shared digest · HTTP points are historical", fontsize=10, color="#555555")
    ratio = report["ratios"]["cds_to_saved_abap_http_throughput"]
    figure.text(0.075, 0.903, f"Whole-window CDS / saved ABAP HTTP throughput: {ratio:,.2f}×; unresolved late slowdown prevents a steady-state claim", fontsize=10, color="#444444")
    figure.text(0.075, 0.075, "Top: repetition p50/p95 and throughput (log axes); horizontal marks show medians. Bottom: every native measured scan (linear axes).", fontsize=9, color="#555555")
    figure.text(0.075, 0.047, "Historical comparison: different times/source versions, OData, authentication, network, JSON and cursor/paging. No HTTP-only or language-speed claim.", fontsize=9, color="#555555")
    figure.text(0.075, 0.019, "Native: one SELECT/cursor, 50 application packages. HTTP: 51 responses per scan. ABAP shares the SAP system resources.", fontsize=9, color="#555555")
    figure.subplots_adjust(top=0.83, bottom=0.15, left=0.075, right=0.98, wspace=0.30, hspace=0.62)
    for extension in ("png", "svg"):
        figure.savefig(output_directory / f"cds-comparison.{extension}", dpi=180, metadata={"Title": title, "Description": "Native and historical HTTP repetition-level latency and useful throughput. Logarithmic axes; no causal or language ranking claim."})
    plt.close(figure)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--output-dir", type=Path, default=project_root / "docs")
    options = parser.parse_args()
    try:
        plot(options.run_directory, options.output_dir)
    except (OSError, KeyError, ValueError) as error:
        parser.exit(1, f"Plot refused: {error}\n")
    print(f"Wrote native/historical PNG and SVG plots to {options.output_dir}")
