// Pure decisions over sanitized, synthetic-member measurements. No credentials.
export const minimumSamples = 30;
export const memberRoutes = ['/api/v1/me?bootstrap=1', '/api/v1/feed?limit=10'];
const valid = n => Number.isFinite(n) && n >= 0;
export function assessPlacement(sample, baseline) {
  const reasons = [], warnings = [], missing = [];
  for (const path of memberRoutes) {
    const a = baseline.routes?.[path], b = sample.routes?.[path];
    if (!a || !b || ![a, b].every(x => Number.isInteger(x.attempts) && x.attempts >= minimumSamples &&
      Number.isInteger(x.errors) && x.errors >= 0 && x.errors <= x.attempts &&
      Array.isArray(x.durations) && x.durations.length + x.errors === x.attempts && x.durations.every(valid))) {
      missing.push(path); continue;
    }
    if (b.errors >= 3 && b.errors / b.attempts > a.errors / a.attempts + .02) reasons.push(path + ':errors');
    if (Math.min(a.durations.length, b.durations.length) < minimumSamples) { missing.push(path + ':latency'); continue; }
    const stats = x => { const t = [...x].sort((a,b) => a-b), n = t.length;
      return {median: n % 2 ? t[(n-1)/2] : (t[n/2-1]+t[n/2])/2, p95:t[Math.ceil(n*.95)-1]}; };
    const before = stats(a.durations), after = stats(b.durations);
    if (after.median > Math.max(before.median * 1.15, before.median + 20)) reasons.push(path + ':median');
    if (after.p95 > Math.max(before.p95 * 1.15, before.p95 + 20)) reasons.push(path + ':p95');
  }
  const a = baseline.allErrors, b = sample.allErrors;
  const validErrors = x => x && valid(x.requests) && valid(x.server_errors) && x.server_errors <= x.requests;
  if (!validErrors(a) || !validErrors(b)) missing.push('aggregate_errors');
  else if (b.requests >= 20 && b.server_errors >= 3 && b.server_errors/b.requests > a.server_errors/Math.max(1,a.requests) + .02) reasons.push('aggregate_errors');
  // Operational health remains visible, but never contributes a rollback reason.
  if (sample.operationsWarning) warnings.push('operations_health');
  return {reasons, warnings, missing};
}
export function sustainedReasons(previous, current) {
  return current.reasons.filter(x => previous?.reasons?.includes(x));
}
