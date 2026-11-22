# Incident remediation — November 21

Owner escalated recurring recovery-only responses to remediation. The overall
connectivity problem remains open and explicitly blocked on router/WAN evidence.

## Delivered monitor correction

Commit `6d01692` retains exact synthetic-session cookies owner-only before logout
and reconciles them with bounded read-only checks after interruption/restart.
It never replays logout or resets credentials. Confirmed rejection removes the
secret; retention expiry is recorded as unconfirmed. Ordinary observations and
notifications never include the secret. This fixes the evidence-loss defect,
not the underlying connection outage.

75 monitor/dispatcher tests, strict monitor type checking, format, diff and secret
checks passed. Tests include restart, continued authorization, failed reads,
retention expiry, capture-before-logout ordering, and exactly one logout attempt.
The installed baseline was rebuilt and matched byte-for-byte before replacement.
The previous process exited before the sole launchd service restarted. Configuration,
incident history, and pending notifications were preserved with a private rollback
copy. No web/API/native release, schema/provider mutation or deployment lease change.

The new bundle passed nine real full journeys over 160.007 seconds, from
2026-11-22 00:14:22.742Z to 00:17:02.749Z. All nine exact-cookie rejections were
recorded and the pending evidence list was empty. Remote full/native CI was still
running at this checkpoint; local monitor checks passed, not a claimed web/API
release gate. Source branch: `codex/incident-root-cause-20261121`.

## Evidence and explicit blockers

Most widespread TLS failures recur approximately every six hours. During the
November 21 21:07–21:08 UTC event, kernel records show TCP connections completing
in milliseconds but receiving zero incoming data and retransmitting across the
monitor, GitHub CLI and other applications. This is cross-process host/network-path
evidence, not a Porchday-only outage. No Tailscale exit node is configured. The
active interface is wired. DHCP renewed during that event, but another renewal
does not match a failure; DHCP alone is not a proven cause. Router/WAN/security
logs are required to discriminate the failing component. Authenticated router
access has been requested; no speculative network reconfiguration was performed.

Read-only inspection of the dedicated monitor identity found 20 unexpired old
session rows with no independent denial records, all from earlier failed-monitor
periods. No bearer token was read or exported. Ordinary authenticated revocation
of only these synthetic sessions requires the owner's exception to the existing
no-session-reset instruction; that exact authorization is pending. Real member
sessions and credentials remain untouched. The new retention mechanism cannot
reconstruct historical cookies discarded by the old monitor.

Raw kernel, provider, synthetic-session and installation evidence is owner-only
under the private root-cause-20261121 directory. Operational updates go to #52;
#55/#8 remain the existing investigations. No duplicate responder or recurring
ChatGPT polling task was created.
