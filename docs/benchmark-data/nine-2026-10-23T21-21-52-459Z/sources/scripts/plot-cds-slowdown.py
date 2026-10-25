"""Plot validated investigation sequences without dropping slow scans."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / "work" / "matplotlib"))
os.environ.setdefault("MPLBACKEND", "Agg")
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

report = json.loads((ROOT / "docs/cds-slowdown-investigation.json").read_text())
assert report["status"] == "validated"
runs = {run["id"]: run for run in report["runs"]}

def series(run_id):
    records = [json.loads(line) for line in (ROOT / runs[run_id]["raw"]).read_text(encoding="utf-8").splitlines() if line.strip()]
    return [record["metrics"]["elapsed_ms"] for record in records if record["kind"] == "scan"]

plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                     "savefig.facecolor": "white", "svg.fonttype": "none"})
figure, axes = plt.subplots(2, 1, figsize=(12, 7.5), gridspec_kw={"height_ratios": [1.25, 1]})
values = series("original_extended")
axes[0].plot(range(1, len(values) + 1), values, color="#375a9c", linewidth=.85)
axes[0].axvspan(1395, 1458, color="#c56b45", alpha=.18)
axes[0].set(title="Original ABAP direct CDS: slowdown and natural recovery", ylabel="Scan time (ms)",
            xlabel="Total scan ordinal (one based; zero warmups)", xlim=(1, len(values)))
axes[0].annotate("1,395–1,458: median 1,360 ms", xy=(1425, 1700), xytext=(850, 4700),
                 arrowprops={"arrowstyle": "->", "color": "#8e4934"}, color="#8e4934")
axes[0].text(.02, .96, "All 2,000 scans retained, including later spikes", transform=axes[0].transAxes,
             ha="left", va="top", fontsize=9)
colors = {"original_short": "#375a9c", "copy": "#8d5aa5", "nojit": "#c16e36", "sat": "#39836b", "phase": "#323232"}
labels = {"original_short": "Original", "copy": "Class rename only", "nojit": "Core PCRE JIT disabled", "sat": "SAT profile enabled", "phase": "Phase clone with probes"}
for run_id in colors:
    if run_id not in runs:
        continue
    data = series(run_id)
    start, end = 1330, min(len(data), 1420)
    axes[1].plot(range(start, end + 1), data[start - 1:end], label=labels[run_id], color=colors[run_id], linewidth=1)
axes[1].set(title="Transition controls (separate requests)", ylabel="Scan time (ms)",
            xlabel="Total scan ordinal", xlim=(1330, 1420))
axes[1].legend(loc="upper left", frameon=False, ncol=2, fontsize=9)
for axis in axes:
    axis.grid(axis="y", alpha=.2)
    axis.set_ylim(bottom=0)
figure.text(.08, .015, "Every scan has the expected 5,000 rows and SHA-256. Separate requests; the extended run had other shared SAP activity.", fontsize=9)
figure.tight_layout(rect=(0, .035, 1, 1))
for extension in ("png", "svg"):
    target = ROOT / f"docs/cds-slowdown-investigation.{extension}"
    figure.savefig(target, dpi=160)
    if extension == "svg":
        target.write_text("\n".join(line.rstrip() for line in target.read_text(encoding="utf-8").splitlines()) + "\n", encoding="utf-8", newline="\n")
plt.close(figure)
