#!/usr/bin/env python3
"""Plot validated native HANA diagnostic phase components and controls."""
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
from matplotlib.patches import Patch

clients = ["rust", "node", "abap"]
names = {"rust": "Rust", "node": "Node.js", "abap": "ABAP"}
phases = [("database_ms", "Database + driver", "#3779ad"),
          ("validation_ms", "Validation + ordering", "#dd963c"),
          ("hashing_ms", "Canonical bytes + SHA-256", "#40856c"),
          ("cleanup_ms", "Cursor cleanup", "#9064a5"),
          ("residual_ms", "Residual + timers", "#b2b8bf")]


def buffer_plot(report, output_directory):
    control = report.get("buffer_control")
    if not control:
        return
    figure, axes = plt.subplots(1, 2, figsize=(12, 5.4))
    for position, item in enumerate(control["summaries"]):
        left = 0
        for key, label, color in phases:
            value = item["additive_mean_ms"][key]
            axes[0].barh(position, value, left=left, height=0.42, color=color)
            left += value
        for offset, total in zip((-0.10, 0, 0.10), item["phases_ms"]["total_ms"]["repetitions"]):
            axes[0].scatter(total, position + offset, color="#24282e", s=17, zorder=4)
        axes[0].annotate(f"{item['additive_mean_ms']['total_ms']:.2f} ms", (left, position),
                         xytext=(7, 0), textcoords="offset points", va="center", fontsize=9)
        values = item["next_async_calls"]["repetitions"]
        axes[1].barh(position, sum(values) / len(values), height=0.42, color="#3779ad")
        axes[1].scatter(values, [position] * len(values), color="#24282e", s=18, zorder=4)
    for axis in axes:
        axis.set_yticks([0, 1], ["128 KiB", "1024 KiB"])
        axis.set_ylim(1.5, -0.5)
        axis.grid(axis="x", alpha=0.15)
        axis.set_axisbelow(True)
        axis.margins(x=0.23)
    axes[0].set_title("Same scan: timed components", loc="left", fontweight="bold")
    axes[0].set_xlabel("Milliseconds per validated 5,000-row scan")
    axes[1].set_title("Driver advances that may block", loc="left", fontweight="bold")
    axes[1].set_xlabel("Async next calls per scan · not measured wire requests")
    title = "Node.js: change only the native row-set cache limit"
    figure.suptitle(title, x=0.04, ha="left", y=0.98, fontsize=15, fontweight="bold")
    figure.text(0.04, 0.91, "Three alternating trials per setting · 15 seconds + five warmups · full validation and canonical SHA-256", fontsize=9, color="#555555")
    figure.legend(handles=[Patch(color=color, label=label) for _, label, color in phases], loc="lower center", bbox_to_anchor=(0.5, 0.09), ncols=3, frameon=False, fontsize=8)
    figure.text(0.04, 0.025, "Source diff verified: one setting substitution; all other source bytes, SQL, image and container limits match. All scans retained.", fontsize=8, color="#555555")
    figure.subplots_adjust(top=0.79, bottom=0.30, left=0.09, right=0.94, wspace=0.29)
    for extension in ("png", "svg"):
        figure.savefig(output_directory / f"native-profile-buffer-control.{extension}", dpi=180,
                       metadata={"Title": title, "Description": "Node.js 128 versus 1024 KiB native row-set cache control; identical contract and all other source bytes."})
    plt.close(figure)


def plot(run_directory: Path, output_directory: Path):
    report = json.loads((output_directory / "native-profile-investigation.json").read_text(encoding="utf-8"))
    if report.get("status") != "validated" or report.get("protocol") != "sap-native-hana-profile-v1":
        raise ValueError("A validated native profile report is required.")
    if Path(report["source"]["run_directory"]).resolve() != run_directory.resolve():
        raise ValueError("This report belongs to another raw run directory.")
    if len(report["blocks"]) != 36 or len(report["summaries"]) != 12:
        raise ValueError("Thirty-six complete diagnostic blocks are required.")
    summaries = {(item["implementation"], item["mode"]): item for item in report["summaries"]}
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                         "savefig.facecolor": "white", "svg.fonttype": "none"})
    figure, axes = plt.subplots(2, 2, figsize=(14, 9))
    for axis, mode, title in [(axes[0, 0], "live_profile", "Live HANA: directly timed components"),
                              (axes[0, 1], "replay_full", "CPU replay: same values, validation and hash")]:
        maximum = 0
        for position, client in enumerate(clients):
            item = summaries[client, mode]
            values = item["additive_mean_ms"]
            left = 0
            for key, label, color in phases:
                value = values[key]
                if value < -0.01:
                    raise ValueError("Cannot draw a negative exclusive component.")
                axis.barh(position, max(0, value), left=left, height=0.48, color=color)
                left += max(0, value)
            for offset, total in zip((-0.10, 0, 0.10), item["phases_ms"]["total_ms"]["repetitions"]):
                axis.scatter(total, position + offset, color="#24282e", s=14, zorder=4)
                maximum = max(maximum, total)
            axis.annotate(f"{values['total_ms']:.2f} ms", (values["total_ms"], position),
                          xytext=(8, 0), textcoords="offset points", va="center", fontsize=9)
        axis.set_yticks(range(3), [names[client] for client in clients])
        axis.set_ylim(2.6, -0.6)
        axis.set_xlim(0, maximum * 1.28)
        axis.grid(axis="x", alpha=0.15)
        axis.set_axisbelow(True)
        axis.set_title(title, loc="left", fontweight="bold", fontsize=11)
        axis.set_xlabel("Milliseconds per 5,000-row scan · linear scale")

    axis = axes[1, 0]
    for position, client in enumerate(clients):
        for mode, offset, color in [("live_control", -0.15, "#617f95"), ("db_only", 0.15, "#a9bdc9")]:
            totals = summaries[client, mode]["mean_total_ms"]["repetitions"]
            average = sum(totals) / len(totals)
            axis.barh(position + offset, average, height=0.26, color=color)
            axis.scatter(totals, [position + offset] * len(totals), color="#24282e", s=13, zorder=4)
    axis.set_title("Ablation control: drain the same driver rows", loc="left", fontweight="bold", fontsize=11)
    axis.set_yticks(range(3), [names[client] for client in clients])
    axis.set_ylim(2.6, -0.6)
    axis.set_xlabel("Milliseconds per scan · mean of three trial means")
    axis.grid(axis="x", alpha=0.15)
    axis.set_axisbelow(True)
    axis.legend(handles=[Patch(color="#617f95", label="Live, profiling disabled"),
                         Patch(color="#a9bdc9", label="DB-only drain, profiled")], frameon=False, fontsize=8,
                loc="upper left", bbox_to_anchor=(0, -0.20), ncols=2)

    axis = axes[1, 1]
    for position, client in enumerate(clients):
        item = next(value for value in report["comparisons"] if value["implementation"] == client)
        ratios = item["profile_to_control_mean_ratio"]
        axis.hlines(position, ratios["minimum"], ratios["maximum"], color="#718898", linewidth=2)
        for offset, value in zip((-0.10, 0, 0.10), ratios["repetitions"]):
            axis.scatter(value, position + offset, s=26, color="#3779ad")
        axis.annotate(f"median {ratios['median']:.3f}×", (ratios["maximum"], position),
                      xytext=(7, 0), textcoords="offset points", va="center", fontsize=8)
    axis.axvline(1, color="#777777", linestyle=":", linewidth=1)
    axis.set_title("Observed profiling effect (paired rounds)", loc="left", fontweight="bold", fontsize=11)
    axis.set_yticks(range(3), [names[client] for client in clients])
    axis.set_ylim(2.6, -0.6)
    axis.margins(x=0.42)
    axis.set_xlabel("Profiled mean / profiling-disabled mean · 1 = equal")
    axis.grid(axis="x", alpha=0.15)
    axis.text(0, -0.32, "Includes timer/counter overhead, code paths and temporal variation.", transform=axis.transAxes,
              fontsize=8, color="#555555")

    title = "Why the native HANA clients differ"
    figure.suptitle(title, x=0.05, ha="left", y=0.98, fontsize=17, fontweight="bold")
    figure.text(0.05, 0.936, "Three diagnostic trials per client and mode · five warmups · same 5,000 rows; full scans verify canonical SHA-256", fontsize=10, color="#555555")
    figure.legend(handles=[Patch(color=color, label=label) for _, label, color in phases] +
                  [Line2D([], [], color="#24282e", marker="o", linestyle="None", markersize=4, label="Each trial mean total")],
                  loc="upper center", bbox_to_anchor=(0.51, 0.91), ncols=3, frameon=False, fontsize=9)
    figure.text(0.05, 0.035, "Stacks use equal-weight arithmetic means of trial component means and add to the displayed total. All measured scans retained.", fontsize=9, color="#555555")
    figure.text(0.05, 0.013, "Database includes driver/network/decoding; profiling and replay alter execution. These are diagnostic implementations, not isolated language-speed estimates.", fontsize=9, color="#555555")
    figure.subplots_adjust(top=0.79, bottom=0.16, left=0.09, right=0.95, wspace=0.22, hspace=0.68)
    for extension in ("png", "svg"):
        figure.savefig(output_directory / f"native-profile-investigation.{extension}", dpi=180,
                       metadata={"Title": title, "Description": "Exclusive native HANA client phase timings, CPU replay, DB-only drain and observed instrumentation effect."})
    plt.close(figure)
    buffer_plot(report, output_directory)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--output-dir", type=Path, default=project_root / "docs")
    options = parser.parse_args()
    try:
        plot(options.run_directory, options.output_dir)
    except (OSError, KeyError, ValueError) as error:
        parser.exit(1, f"Plot refused: {error}\n")
    print(f"Wrote native HANA diagnostic charts to {options.output_dir}")
