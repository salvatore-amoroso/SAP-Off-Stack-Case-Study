// UTC is an independent sanity check; the monotonic controller clock bounds work.
export function controlTimingValid(block, summary, warmup) {
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const wall = summary?.measured_wall_ms, control = block?.control_wall_ms;
  const utc = Date.parse(block?.finished_utc) - Date.parse(block?.started_utc);
  if (!Array.isArray(warmup) || !warmup.every(scan => finite(scan.metrics?.elapsed_ms))) return false;
  const warmupMs = warmup.reduce((sum, scan) => sum + scan.metrics?.elapsed_ms, 0);
  return finite(wall) && finite(control) && control > 0 && finite(warmupMs) &&
    Number.isFinite(utc) && utc > 0 && Math.abs(control - utc) <= 100 &&
    wall + warmupMs <= control + 2;
}
