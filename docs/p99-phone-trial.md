# Physical-phone latency trial

The owner has offered an iPhone in California and Nick's Android in Manila.
These cover prospective US West and Manila physical-device measurements. Models,
OS/browser versions, carriers and cellular availability still need confirmation.
US East is unassigned. Android cannot establish native iOS performance; the
California iPhone needs separate web/PWA and native iOS runs. Do not pool results.

This first trial checks the measurement workflow with a small staging workload.
It does not replace the goal's 10,000 observations per critical server operation
and region, representative device journeys, or seven-day production observation.
No production load is authorized by this document.

## Before the tester starts

The operator must supply the verified staging build and a dedicated synthetic
account with a small, non-sensitive encrypted JPEG post already prepared. Use an
image of at most 250 KiB for this initial workflow check; record its actual size
and dimensions. Do not use real member content or send passwords/recovery keys in
issues, chat, screenshots or trace exports. Verify expiry/deletion and that tracing
is available on the candidate. Do not ask the tester to reinstall or clear storage:
that would destroy the saved-credentials/unlocked-keys condition being measured.

Record location/region, phone model, OS, browser/version, browser vs installed PWA
vs native app, connection type/carrier, Wi-Fi state, VPN state, battery/low-power
mode, build and UTC start/end. Actual signal strength and changing network
conditions are observations, not reasons to discard a slow or failed run.

## Short web/PWA run (operator-assisted)

1. Open staging and sign into the synthetic account. Enable the existing
   **Settings → My data → Share performance traces from this browser** control
   after reading its disclosure. Keep the app visible while timing.
2. With Wi-Fi off, verify that cellular data is working. Run five warm returns to
   the feed and three cold page launches with saved credentials and usable keys.
   Record the precise launch method. A reload is not equivalent to a terminated
   app launch; a background return is not a cold launch. Record key-unlock prompts
   as a different journey rather than silently excluding their delay.
3. Open the prepared photo post. Record whether the photo is visible, any errors,
   and whether content was already loaded. Preserve cache-state differences.
4. Make one short synthetic text post, edit it once, and add one reaction. Record
   immediate feedback separately from confirmed save and subsequent readback.
   If a write times out, do not replay it: let the operator reconcile it read-only.
5. Send the traces using **Send now** before signing out. Note the visit's trace ID
   privately, then sign out. The operator verifies rejection of the old session
   separately; a return to the login screen alone does not prove revocation.
6. The operator exports only this consenting tester's synthetic traces to private
   evidence, records errors/timeouts and missing spans, deletes the synthetic
   content, verifies absence, and confirms session cleanup. Turn tracing off when
   finished. Native iOS needs its own instrumentation and installation verification;
   web trace success does not certify the native app.

For visible-post/photo milestones, require the candidate containing the visible
rendering fixes. Browser frame opportunities are proxies for display readiness,
not physical screen measurements. Native and web launch timings must use matching
start/end definitions. Keep client timing separate from nested server spans.

## Evidence and open gates

Store per-attempt results and conditions, including failures; never replace a slow
sample with a retry. Report counts and exploratory distributions with the small
sample warning. Mark regional/operation/client cells missing until measured.
The three cold and five warm attempts above are workflow checks, not sufficient
p99 evidence. US East, Android/iPhone model details, ordinary-cellular conditions,
native installation and native measurements remain open until independently
verified. A successful two-region trial must not be called full goal completion.
