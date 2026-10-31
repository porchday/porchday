/** Durable decisions for the approved one-hour placement experiment.
 * Input contains aggregate measurements only; no sessions or member content.
 * The caller must hold the deployment lease and persist each returned record
 * before taking another sample or deciding whether to retain the rollout.
 */
import {createHash} from 'node:crypto';
import {assessPlacement, sustainedReasons} from './placement-watch-policy.mjs';

export const trialDurationMs = 60 * 60 * 1000;
const minute = 60 * 1000;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = n => Number.isSafeInteger(n) && n > 0;
const need = (v, code) => { if (!v) throw Error(code); };
function connection(value) {
  return value && Number.isInteger(value.total) && value.total >= 0 &&
    Number.isInteger(value.usable) && value.usable >= 18 && value.usable <= 10000 &&
    typeof value.refused === 'boolean';
}
export function validateTrialBaseline(baseline, startedAt) {
  need(timestamp(startedAt) && baseline && Array.isArray(baseline.connections) &&
    baseline.connections.length >= 6 && Array.isArray(baseline.windows) &&
    baseline.windows.length === 2, 'TRIAL_BASELINE_INCOMPLETE');
  let previous;
  for (const sample of baseline.connections) {
    need(timestamp(sample.at) && connection(sample) && !sample.refused &&
      sample.total < 18 && sample.total < sample.usable &&
      (!previous || sample.at - previous.at >= 50000 && sample.at - previous.at <= 90000) &&
      (!previous || previous.usable === sample.usable), 'TRIAL_BASELINE_HEADROOM_UNSUITABLE');
    previous = sample;
  }
  need(previous.at - baseline.connections[0].at >= 5 * minute &&
    startedAt >= previous.at && startedAt - previous.at <= 2 * minute,
  'TRIAL_BASELINE_STALE');
  for (const window of baseline.windows) {
    need(timestamp(window.startedAt) && timestamp(window.endedAt) &&
      window.startedAt < window.endedAt && window.endedAt <= startedAt &&
      startedAt - window.startedAt <= 20 * minute &&
      assessPlacement(window, window).missing.length === 0 && window.allErrors.requests>0,
    'TRIAL_BASELINE_WINDOWS_INCOMPLETE');
  }
  need(baseline.windows[0].endedAt <= baseline.windows[1].startedAt &&
    baseline.auth === true && baseline.revocation === true && baseline.privacy === true &&
    baseline.readiness === true && baseline.publicAssets === true,
  'TRIAL_BASELINE_ACCEPTANCE_FAILED');
  return baseline;
}
export function startTrial(operationId, startedAt, baseline) {
  need(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId), 'TRIAL_OPERATION_INVALID');
  validateTrialBaseline(baseline, startedAt);
  return {v:1, operationId, baselineHash:sha(baseline), revision:1, startedAt,
    at:startedAt, status:'watching', reasons:[], lastConnectionAt:startedAt,
    lastWindowAt:startedAt, connectionSamples:0, windows:0,
    previousHigh:false, previousReadinessFailure:false, previousAssessment:null,
    previousHash:null, sample:null};
}
export function advanceTrial(previous, sample, baseline) {
  need(previous?.v === 1 && previous.status === 'watching' &&
    previous.baselineHash === sha(baseline), 'TRIAL_STATE_OR_BASELINE_CHANGED');
  need(sample && timestamp(sample.at) && sample.at > previous.at &&
    sample.at >= previous.startedAt &&
    Math.floor((sample.at-previous.startedAt)/minute)>Math.floor((previous.at-previous.startedAt)/minute),
  'TRIAL_SAMPLE_TIME_INVALID');
  const reasons = [];
  if (sample.at - previous.at >= 2 * minute) reasons.push('observation_gap');
  for (const name of ['auth','revocation','privacy']) {
    need(typeof sample[name] === 'boolean', 'TRIAL_SAFETY_SAMPLE_REQUIRED');
    if (!sample[name]) reasons.push(name);
  }
  need(typeof sample.readiness === 'boolean' && typeof sample.publicAssets === 'boolean' &&
    typeof sample.refused === 'boolean', 'TRIAL_SAFETY_SAMPLE_REQUIRED');
  if (sample.refused) reasons.push('connection_refusal');
  if (!sample.publicAssets) reasons.push('public_assets');
  if (!sample.readiness && previous.previousReadinessFailure) reasons.push('sustained_readiness');
  const current = sample.connection;
  need(current === null || connection(current), 'TRIAL_CONNECTION_INVALID');
  if(current?.at!==undefined)need(timestamp(current.at)&&current.at<=sample.at&&sample.at-current.at<=45000,'TRIAL_CONNECTION_STALE');
  if (current?.refused) reasons.push('connection_refusal');
  if (current && current.usable !== baseline.connections[0].usable) reasons.push('capacity_changed');
  if (current && current.total >= current.usable) reasons.push('usable_slots_exhausted');
  const high = !!current && current.total >= 18;
  if (high && previous.previousHigh) reasons.push('sustained_connection_headroom');
  const lastConnectionAt = current ? current.at??sample.at : previous.lastConnectionAt;
  if (sample.at - previous.lastConnectionAt >= 2 * minute) reasons.push('connection_coverage_gap');
  let assessment = previous.previousAssessment, lastWindowAt = previous.lastWindowAt;
  need(sample.window === null || typeof sample.window === 'object', 'TRIAL_WINDOW_INVALID');
  if (sample.window) {
    const window = sample.window;
    need(timestamp(window.startedAt) && window.startedAt >= previous.lastWindowAt &&
      timestamp(window.endedAt) && window.endedAt > window.startedAt &&
      window.endedAt <= sample.at && sample.at - window.endedAt <= minute,
    'TRIAL_WINDOW_TIME_INVALID');
    // Compare each window with both pre-change windows, retaining the more
    // conservative result instead of blending away the slower route's tail.
    const assessed = baseline.windows.map(b => assessPlacement(window, b));
    assessment = {reasons:[...new Set(assessed.flatMap(x => x.reasons))],
      missing:[...new Set(assessed.flatMap(x => x.missing))],
      warnings:[...new Set(assessed.flatMap(x => x.warnings))]};
    reasons.push(...sustainedReasons(previous.previousAssessment, assessment));
    if (assessment.missing.length && previous.previousAssessment?.missing.length)
      reasons.push('latency_error_coverage_gap');
    lastWindowAt = window.endedAt;
  }
  if (sample.at - previous.lastWindowAt >= 10 * minute) reasons.push('window_coverage_gap');
  const next = {...previous, revision:previous.revision+1, at:sample.at,
    lastConnectionAt, lastWindowAt, connectionSamples:previous.connectionSamples + (current ? 1 : 0),
    windows:previous.windows + (sample.window ? 1 : 0), previousHigh:high,
    previousReadinessFailure:!sample.readiness, previousAssessment:assessment,
    previousHash:sha(previous), sample:structuredClone(sample), reasons:[...new Set(reasons)]};
  if (next.reasons.length) next.status = 'rollback-required';
  else if (sample.at - previous.startedAt >= trialDurationMs &&
    next.connectionSamples >= 60 && next.windows >= 12 && current &&
    sample.readiness && !high && !assessment?.missing.length &&
    !assessment?.reasons.length && sample.at - lastWindowAt <= minute)
    next.status = 'retain';
  return next;
}

/** Recompute every decision on resume. A terminal stop cannot be discarded,
 * edited into success, or replaced with a newly started one-hour watch.
 */
export function validateTrialHistory(records, baseline) {
  need(Array.isArray(records) && records.length > 0, 'TRIAL_HISTORY_EMPTY');
  let expected = startTrial(records[0].operationId, records[0].startedAt, baseline);
  need(sha(records[0]) === sha(expected), 'TRIAL_HISTORY_CHANGED');
  for (const record of records.slice(1)) {
    expected = advanceTrial(expected, record.sample, baseline);
    need(sha(record) === sha(expected), 'TRIAL_HISTORY_CHANGED');
  }
  return expected;
}
