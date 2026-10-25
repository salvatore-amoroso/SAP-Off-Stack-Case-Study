#!/usr/bin/env python3
"""Plot a validated fresh comparison of all nine SAP access paths."""
import argparse
import json
import os
from datetime import datetime
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent
os.environ.setdefault("MPLCONFIGDIR", str(project_root / "work" / "matplotlib"))
os.environ.setdefault("MPLBACKEND", "Agg")
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter

LANGUAGES = ("abap", "node", "rust")
APPROACHES = ("http", "cds", "native")
NAMES = {"abap": "ABAP", "node": "Node.js", "rust": "Rust"}
ROUTES = {"http": "HTTP / OData", "cds": "CDS (internal ABAP / external ODBC)", "native": "Direct HANA"}
COLORS = {"abap": "#24816b", "node": "#2569a0", "rust": "#ba602a"}
REPETITION_COLORS = ("#2569a0", "#ba602a", "#24816b")


def number(value, _):
    return f"{value:,.0f}" if value >= 1 else f"{value:g}"


def compact(value, _):
    return f"{value / 1000:g}k" if value >= 1000 else f"{value:g}"


def save(figure, output_directory, stem, title, description):
    for extension in ("png", "svg"):
        figure.savefig(output_directory / f"{stem}.{extension}", dpi=180,
                       metadata={"Title": title, "Description": description})
    plt.close(figure)


def check_report(report, run_directory, output_directory):
    if report.get("status") not in ("validated", "validated_partial") or report.get("protocol") != "sap-nine-path-benchmark-v1":
        raise ValueError("Run the validating nine-path analysis before plotting.")
    if Path(report["source"]["run_directory"]).resolve() != run_directory.resolve():
        raise ValueError("This comparison belongs to a different raw run directory.")
    expected_rounds = 2 if report.get("status") == "validated_partial" else 3
    if len(report.get("blocks", [])) != expected_rounds * 9 or len(report.get("summaries", [])) != 9:
        raise ValueError("All retained complete-round blocks across nine paths are required.")
    if report.get("synthetic_test_data") and output_directory.resolve() == (project_root / "docs").resolve():
        raise ValueError("Synthetic charts must remain outside real docs.")
    for language in LANGUAGES:
        for approach in APPROACHES:
            app = f"{language}-{approach}"
            blocks = [item for item in report["blocks"] if item["app_id"] == app]
            if len(blocks) != expected_rounds or sorted(item["round"] for item in blocks) != list(range(1, expected_rounds + 1)):
                raise ValueError("Every path must have all retained repetitions.")
            for block in blocks:
                if block["failed_scans"] or len(block["latency_series"]) != block["successful_scans"]:
                    raise ValueError("Every measured scan must be validated and included.")
                if min(block["p50_ms"], block["p95_ms"], block["useful_rows_per_second"]) <= 0:
                    raise ValueError("Logarithmic plots require positive validated metrics.")


def summary_plot(report, output_directory):
    figure, axes = plt.subplots(3, 2, figsize=(14, 10.6), sharex="col")
    for row, approach in enumerate(APPROACHES):
        latency, throughput = axes[row]
        for position, language in enumerate(LANGUAGES):
            app = f"{language}-{approach}"
            blocks = sorted((item for item in report["blocks"] if item["app_id"] == app), key=lambda item: item["round"])
            summary = next(item for item in report["summaries"] if item["app_id"] == app)
            color = COLORS[language]
            for offset, block in zip((-0.12, 0.12) if len(blocks) == 2 else (-0.16, 0, 0.16), blocks):
                y = position + offset
                latency.plot([block["p50_ms"], block["p95_ms"]], [y, y], color=color, alpha=0.35, linewidth=1)
                latency.scatter(block["p50_ms"], y, color=color, marker="o", s=30, zorder=3)
                latency.scatter(block["p95_ms"], y, facecolors="white", edgecolors=color, marker="^", linewidths=1.2, s=40, zorder=3)
                throughput.scatter(block["useful_rows_per_second"], y, color=color, s=32, zorder=3)
                throughput.annotate(f"R{block['round']}", (block["useful_rows_per_second"], y),
                                    xytext=(6, 0), textcoords="offset points", va="center", fontsize=8, color=color)
            latency.vlines(summary["p50_ms"]["median"], position - 0.29, position + 0.29, color=color, linewidth=2)
            latency.vlines(summary["p95_ms"]["median"], position - 0.29, position + 0.29, color=color, linewidth=1.4, linestyles="--")
            throughput.vlines(summary["useful_rows_per_second"]["median"], position - 0.29, position + 0.29, color=color, linewidth=2)
        for axis in (latency, throughput):
            axis.set_yticks(range(3), [NAMES[item] for item in LANGUAGES])
            axis.set_ylim(2.5, -0.5)
            axis.set_xscale("log")
            axis.xaxis.set_major_locator(LogLocator(base=10, subs=(1, 2, 5)))
            axis.xaxis.set_major_formatter(FuncFormatter(compact))
            axis.xaxis.set_minor_formatter(NullFormatter())
            axis.grid(axis="x", which="major", alpha=0.2)
            axis.set_axisbelow(True)
            axis.margins(x=0.24)
            axis.tick_params(axis="x", which="both", labelbottom=True)
        latency.set_xlim(min(item["p50_ms"] for item in report["blocks"]) / 1.5,
                         max(item["p95_ms"] for item in report["blocks"]) * 1.5)
        throughput.set_xlim(min(item["useful_rows_per_second"] for item in report["blocks"]) / 1.5,
                            max(item["useful_rows_per_second"] for item in report["blocks"]) * 1.5)
        latency.set_title(ROUTES[approach], loc="left", fontweight="bold", fontsize=11)
        throughput.set_title(ROUTES[approach], loc="left", fontweight="bold", fontsize=11)
    axes[2, 0].set_xlabel("Complete-scan latency (ms, logarithmic scale) · lower is better")
    axes[2, 1].set_xlabel("Useful positions / measured wall second (log) · higher is better")
    figure.legend(handles=[Line2D([], [], marker="o", color="#555555", linestyle="None", label="Repetition p50"),
                           Line2D([], [], marker="^", markerfacecolor="white", color="#555555", linestyle="None", label="Repetition p95"),
                           Line2D([], [], color="#555555", linewidth=2, label=f"Median of {report['configuration']['main_completed_rounds']} trial statistics")],
                  frameon=False, ncols=3, loc="upper left", bbox_to_anchor=(0.075, 0.086), fontsize=9)
    title = "Nine application paths — two complete retained rounds" if report.get("status") == "validated_partial" else "Nine application paths — every fresh repetition"
    if report.get("synthetic_test_data"):
        title = "SYNTHETIC TEST DATA — no performance claim"
    figure.suptitle(title, x=0.075, y=0.983, ha="left", fontsize=16, fontweight="bold")
    figure.text(0.075, 0.944, f"{report['configuration']['main_completed_rounds']} × 180 measured seconds per path · 5,000 positions per scan · identical validation and canonical SHA-256", fontsize=10, color="#444444")
    note = "Third round excluded because host conditions did not meet the comparison protocol. Retained Node CDS warmup timeout and diagnostic pause disclosed." if report.get("status") == "validated_partial" else "Fresh run: all three rounds included. Historical interrupted attempts are preserved separately."
    figure.text(0.075, 0.922, note, fontsize=9, color="#555555")
    figure.text(0.075, 0.024, "Complete access paths have different drivers, sessions, conversions and placements. External clients: 1 CPU / 256 MiB; ABAP: shared SAP resources.", fontsize=9, color="#555555")
    figure.subplots_adjust(top=0.875, bottom=0.143, left=0.075, right=0.98, hspace=0.38, wspace=0.16)
    save(figure, output_directory, "nine-comparison", title,
         "Nine access paths in three rows by approach. Every included trial p50/p95 and useful-throughput statistic, logarithmic axes.")


def sequence_plot(report, output_directory):
    figure, axes = plt.subplots(3, 3, figsize=(15, 11.2), sharey=True)
    for row, approach in enumerate(APPROACHES):
        for column, language in enumerate(LANGUAGES):
            axis = axes[row, column]
            blocks = sorted((item for item in report["blocks"] if item["app_id"] == f"{language}-{approach}"), key=lambda item: item["round"])
            for color, block in zip(REPETITION_COLORS, blocks):
                series = block["latency_series"]
                x = [item["measured_index"] for item in series]
                y = [item["elapsed_ms"] for item in series]
                if min(y) <= 0:
                    raise ValueError("Chronology requires positive timings for its explicit logarithmic axis.")
                axis.plot(x, y, color=color, alpha=0.8, linewidth=0.65,
                          label=f"R{block['round']} / block {block['block_index']}", rasterized=True)
            axis.axhline(1000, color="#888888", linestyle=":", linewidth=0.7)
            axis.set_yscale("log")
            axis.yaxis.set_major_formatter(FuncFormatter(number))
            axis.set_title(f"{NAMES[language]} · {ROUTES[approach] if approach != 'cds' else ('Internal CDS' if language == 'abap' else 'CDS via ODBC')}", loc="left", fontsize=10, fontweight="bold")
            axis.set_xlabel("Measured scan index (zero based)", fontsize=9)
            if column == 0:
                axis.set_ylabel("Scan latency (ms, log)")
            axis.grid(axis="y", which="major", alpha=0.18)
            axis.legend(frameon=False, fontsize=7.5, loc="upper right")
    title = "Every measured scan in the first two retained rounds" if report.get("status") == "validated_partial" else "Every measured scan — preserving the complete latency sequence"
    if report.get("synthetic_test_data"):
        title = "SYNTHETIC TEST DATA — no performance claim"
    figure.suptitle(title, x=0.065, y=0.984, ha="left", fontsize=15, fontweight="bold")
    figure.text(0.065, 0.947, "One panel per application; one line per retained trial. All retained measured scans included; no trimming or downsampling.", fontsize=10, color="#444444")
    figure.text(0.065, 0.923, "Scan order is not wall time: equal x positions across panels or repetitions are not synchronized. Dotted guide: 1,000 ms.", fontsize=9, color="#555555")
    note = "Third round excluded because host conditions did not meet the comparison protocol. Node CDS: one retained warmup TIMEOUT, then explicit retry after a diagnostic pause; see report." if report.get("status") == "validated_partial" else "All measured scans from all three rounds remain included. See the report for host conditions and access-path differences."
    figure.text(0.065, 0.022, note, fontsize=9, color="#555555")
    figure.subplots_adjust(top=0.875, bottom=0.085, left=0.065, right=0.985, hspace=0.46, wspace=0.15)
    save(figure, output_directory, "nine-scan-latency", title,
         "All included measured scan latencies in exact sequence, nine application panels, logarithmic latency axis.")


def attempt_plot(report, output_directory):
    if not report.get("continuation"):
        return
    attempts = [item for item in report["continuation"]["attempts"] if item["planned_block_index"] <= 18]
    timestamp = lambda value: datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    origin = timestamp(attempts[0]["started_utc"])
    figure, axis = plt.subplots(figsize=(14, 9))
    labels = []
    for position, attempt in enumerate(attempts):
        start = (timestamp(attempt["started_utc"]) - origin) / 60
        duration = (timestamp(attempt["finished_utc"]) - timestamp(attempt["started_utc"])) / 60
        color = "#bb3434" if attempt["status"] == "failed" else COLORS[attempt["app_id"].split("-")[0]]
        axis.barh(position, duration, left=start, height=0.68, color=color, alpha=0.85)
        labels.append(f"{attempt['planned_block_index']:02d} · {attempt['app_id']} · attempt {attempt['attempt_index']}")
        if attempt["status"] == "failed":
            axis.annotate("Warmup TIMEOUT; zero measured scans", (start + duration, position), xytext=(7, 0),
                          textcoords="offset points", va="center", fontsize=9, color=color)
    amendment = report["continuation"]["amendment"]
    pause = (timestamp(amendment["paused_at_utc"]) - origin) / 60
    resume = (timestamp(amendment["resumed_at_utc"]) - origin) / 60
    axis.axvspan(pause, resume, color="#aaa26d", alpha=0.15)
    axis.text((pause + resume) / 2, -0.9, "Diagnostic pause", ha="center", fontsize=9, color="#66603e")
    axis.set_yticks(range(len(attempts)), labels, fontsize=9)
    axis.set_ylim(len(attempts) - 0.3, -1.3)
    axis.set_xlabel("Actual elapsed minutes since first retained attempt began")
    axis.grid(axis="x", alpha=0.2)
    axis.set_axisbelow(True)
    title = "Retained rounds: 19 attempts, 18 measured-block successes, one failed warmup"
    figure.suptitle(title, x=0.04, y=0.975, ha="left", fontsize=14, fontweight="bold")
    figure.text(0.04, 0.935, "Bars show full control duration including process/ADT dispatch, warmup, measurement and final output — not scan latency.", fontsize=9, color="#555555")
    figure.text(0.04, 0.025, "Entire third round excluded because host conditions did not meet the comparison protocol. Original failed attempt and explicit retry remain visible.", fontsize=9, color="#555555")
    figure.subplots_adjust(left=0.235, right=0.985, top=0.89, bottom=0.09)
    save(figure, output_directory, "nine-attempt-timeline", title,
         "Chronological control-duration timeline of the first two retained rounds, including failed warmup, diagnostic pause and explicit retry. Excludes third round.")


def plot(run_directory, output_directory):
    report = json.loads((output_directory / "nine-comparison.json").read_text(encoding="utf-8"))
    check_report(report, run_directory, output_directory)
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                         "savefig.facecolor": "white", "svg.fonttype": "none", "path.simplify": False})
    summary_plot(report, output_directory)
    sequence_plot(report, output_directory)
    attempt_plot(report, output_directory)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--output-dir", type=Path, default=project_root / "docs")
    options = parser.parse_args()
    try:
        plot(options.run_directory, options.output_dir)
    except (OSError, KeyError, ValueError) as error:
        parser.exit(1, f"Plot refused: {error}\n")
    print(f"Wrote nine-path comparison PNG/SVG charts to {options.output_dir}")
