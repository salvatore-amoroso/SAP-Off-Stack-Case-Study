#!/usr/bin/env python3
"""Plot validated native HANA and historical HTTP/CDS repetition metrics."""
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


def number(value, _):
    return f"{value:,.0f}" if value >= 1 else f"{value:g}"


def save(figure, output_directory, stem, title, description):
    for extension in ("png", "svg"):
        figure.savefig(output_directory / f"{stem}.{extension}", dpi=180,
                       metadata={"Title": title, "Description": description})
    plt.close(figure)


def sequence_plot(report, output_directory):
    blocks = report["blocks"]
    if not any(item["scans_over_1000_ms"] or item["relative_slow_scans"]["count"] for item in blocks):
        return
    colors = ["#2468a0", "#b96026", "#28816a"]
    figure, axes = plt.subplots(3, 1, figsize=(13, 9), sharex=False)
    for axis, client, name in zip(axes, ("node", "rust", "abap"), ("Node.js", "Rust", "ABAP")):
        repetitions = sorted((item for item in blocks if item["implementation"] == f"{client}_native"), key=lambda item: item["round"])
        largest_ordinal = 0
        for color, block in zip(colors, repetitions):
            series = block["latency_series"]
            if len(series) != block["successful_scans"]:
                raise ValueError("Full latency sequences must match measured scan counts.")
            x = [item["total_scan_ordinal"] for item in series]
            y = [item["elapsed_ms"] for item in series]
            largest_ordinal = max(largest_ordinal, max(x))
            axis.plot(x, y, color=color, alpha=0.75, linewidth=0.65,
                      label=f"Round {block['round']} (block {block['block_index']})")
        axis.axhline(1000, color="#777777", linestyle=":", linewidth=0.8)
        if largest_ordinal >= 1395:
            axis.axvline(1395, color="#999999", linestyle=":", linewidth=0.8)
        axis.set_yscale("log")
        axis.yaxis.set_major_formatter(FuncFormatter(number))
        axis.set_title(name, loc="left", fontweight="bold")
        axis.set_ylabel("Scan latency (ms, log)")
        axis.set_xlabel("Within-block total scan ordinal (one-based; five warmups excluded from lines)")
        axis.grid(axis="y", alpha=0.18)
        axis.legend(frameon=False, ncols=3, loc="upper right", fontsize=8)
    title = "Every native HANA measured scan — no outlier removal"
    if report.get("synthetic_test_data"):
        title = "SYNTHETIC TEST DATA — no performance claim"
    figure.suptitle(title, x=0.08, ha="left", y=0.98, fontsize=15, fontweight="bold")
    figure.text(0.08, 0.935, "Each line is one complete 180-second block; x is scan order, not elapsed time. All phases and spikes remain included.", fontsize=9, color="#555555")
    figure.text(0.08, 0.025, "Dotted guides: 1,000 ms and ordinal 1,395 (saved CDS onset, when in range). Guides imply no shared cause or phase alignment.", fontsize=9, color="#555555")
    figure.subplots_adjust(top=0.88, bottom=0.09, left=0.08, right=0.98, hspace=0.68)
    save(figure, output_directory, "native-scan-latency", title,
         "Every measured native HANA scan in all nine blocks. Logarithmic latency axis; no scans removed.")


def plot(run_directory: Path, output_directory: Path) -> None:
    report = json.loads((output_directory / "native-comparison.json").read_text(encoding="utf-8"))
    if report.get("status") != "validated" or report.get("protocol") != "sap-native-hana-benchmark-v1":
        raise ValueError("Run the validating native HANA analysis before plotting.")
    if Path(report["source"]["run_directory"]).resolve() != run_directory.resolve():
        raise ValueError("This comparison belongs to another raw run directory.")
    if len(report.get("blocks", [])) != 9 or len(report.get("historical_blocks", [])) != 12 or len(report.get("summaries", [])) != 7:
        raise ValueError("Nine native blocks and twelve saved blocks across seven paths are required.")
    if report.get("synthetic_test_data") and output_directory.resolve() == (project_root / "docs").resolve():
        raise ValueError("Synthetic charts must remain outside the real docs output.")

    implementations = ["abap_native", "node_native", "rust_native", "abap_cds", "abap_http", "node_http", "rust_http"]
    names = ["ABAP native HANA · new", "Node.js native HANA · new", "Rust native HANA · new",
             "ABAP direct CDS · saved", "ABAP HTTP · saved", "Node.js HTTP · saved", "Rust HTTP · saved"]
    colors = {"abap_native": "#28816a", "node_native": "#2468a0", "rust_native": "#b96026",
              "abap_cds": "#694aa0", "abap_http": "#28816a", "node_http": "#2468a0", "rust_http": "#b96026"}
    blocks = report["blocks"] + report["historical_blocks"]
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                         "savefig.facecolor": "white", "svg.fonttype": "none"})
    figure, (latency, throughput) = plt.subplots(1, 2, figsize=(14, 7.2), sharey=True)
    for position, implementation in enumerate(implementations):
        repetitions = sorted((item for item in blocks if item["implementation"] == implementation), key=lambda item: item["round"])
        if len(repetitions) != 3:
            raise ValueError("Each access path must have exactly three repetitions.")
        summary = next(item for item in report["summaries"] if item["implementation"] == implementation)
        color = colors[implementation]
        for offset, block in zip((-0.14, 0, 0.14), repetitions):
            y = position + offset
            p50, p95, rate = block["p50_ms"], block["p95_ms"], block["useful_rows_per_second"]
            if min(p50, p95, rate) <= 0:
                raise ValueError("Logarithmic comparisons require positive validated metrics.")
            latency.plot([p50, p95], [y, y], color=color, alpha=0.3, linewidth=1)
            latency.scatter(p50, y, color=color, marker="o", s=35, zorder=3)
            latency.scatter(p95, y, facecolors="white", edgecolors=color, marker="^", linewidths=1.3, s=43, zorder=3)
            throughput.scatter(rate, y, color=color, s=36, zorder=3)
            throughput.annotate(f"R{block['round']}", (rate, y), xytext=(6, 0),
                                textcoords="offset points", va="center", fontsize=8, color=color)
        latency.vlines(summary["p50_ms"]["median"], position - 0.27, position + 0.27, color=color, linewidth=2)
        latency.vlines(summary["p95_ms"]["median"], position - 0.27, position + 0.27, color=color, linewidth=1.4, linestyles="--")
        throughput.vlines(summary["useful_rows_per_second"]["median"], position - 0.27, position + 0.27, color=color, linewidth=2)
    for axis in (latency, throughput):
        axis.set_yticks(range(7), names)
        axis.set_ylim(6.5, -0.5)
        axis.set_xscale("log")
        axis.xaxis.set_major_formatter(FuncFormatter(number))
        axis.grid(axis="x", which="major", alpha=0.2)
        axis.set_axisbelow(True)
        axis.margins(x=0.2)
        axis.axhline(2.5, color="#aaaaaa", linestyle=":", linewidth=1)
    latency.set_title("Complete-scan latency · logarithmic scale", loc="left", fontweight="bold")
    latency.set_xlabel("Milliseconds per validated 5,000-position scan")
    latency.legend(handles=[Line2D([], [], marker="o", color="#555555", linestyle="None", label="Repetition p50"),
                            Line2D([], [], marker="^", markerfacecolor="white", color="#555555", linestyle="None", label="Repetition p95")],
                   frameon=False, loc="upper left", bbox_to_anchor=(0, -0.16), ncols=2, fontsize=9)
    throughput.set_title("Useful throughput · logarithmic scale", loc="left", fontweight="bold")
    throughput.set_xlabel("Validated positions per measured wall second")
    title = "Native HANA with saved HTTP and direct CDS results"
    if report.get("synthetic_test_data"):
        title = "SYNTHETIC TEST DATA — no performance claim"
    figure.suptitle(title, fontsize=16, fontweight="bold", x=0.035, ha="left", y=0.98)
    figure.text(0.035, 0.92, "Three repetitions per path · every measured scan included · 5,000 rows and identical canonical SHA-256", fontsize=10, color="#555555")
    figure.text(0.035, 0.052, "Points show all repetition statistics; short vertical marks show medians. Historical rows are preserved earlier runs, not controlled reruns.", fontsize=9, color="#555555")
    figure.text(0.035, 0.02, "Different times, source/runtime versions, session lifecycles, drivers and placement; shared SAP resources. No isolated language-speed or HTTP-overhead claim.", fontsize=9, color="#555555")
    figure.subplots_adjust(top=0.83, bottom=0.21, left=0.21, right=0.97, wspace=0.17)
    save(figure, output_directory, "native-comparison", title,
         "Seven access paths, three repetitions per path; latency and useful throughput on explicit logarithmic axes.")
    sequence_plot(report, output_directory)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--output-dir", type=Path, default=project_root / "docs")
    options = parser.parse_args()
    try:
        plot(options.run_directory, options.output_dir)
    except (OSError, KeyError, ValueError) as error:
        parser.exit(1, f"Plot refused: {error}\n")
    print(f"Wrote native HANA/historical comparison charts to {options.output_dir}")
