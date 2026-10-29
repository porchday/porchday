# Monitor recovery state and compatibility

The low-level recovery controller and shared deployment lease now recognize
explicit staging/production monitor targets separately from API/edge targets.
Canonical monitor version/source fields and monitor-specific reader floors are
required. Finalization updates only the selected monitor's provenance plus its
recovery receipt and provider snapshot pointer; application, edge, other monitor
and availability-objective fields are preserved. A monitor cannot carry an
application asset manifest, and finalization requires a provider snapshot.

The application activation CLI still rejects monitor plans before any network
access. These primitives do not yet constitute a monitor activation command:
monitor-specific compatibility evidence, live status/history verification and
fresh full-inventory checks must be composed before hosted activation.
Canonical `monitorSources` are required by the lease and must be established
from verified deployed artifacts, not guessed from an application source field.

A new public monitor-state validator rejects stale/invalid timestamps, HTTP
failure, invalid counts/percentages and a changed history origin. Continuity
checks reject lost passed/failed observations except those actually expiring
from a full rolling window, and reject regression from ready metrics. Baselines
older than 30 minutes require renewed review. This is aggregate-history evidence,
not proof of byte-identical private storage. The existing 90-second freshness
predicate remains intact.

## Verification

Eighty focused tests passed, covering recovery, monitor canonical finalization
and rollback, invalid monitor provenance/floors, application-CLI exclusion,
provider transport, upload target separation and public-history validation.
Release TypeScript and whitespace checks passed.

At 14:35:59.570 UTC a separate local workerd rehearsal compiled baseline monitor
source `005454607c98ffdb7c430a947bedb4586a14a45b` and the runtime mitigation at
`685d891628f57b12c460db5b9fc4e0d390e0d6b9`. A test-only subclass exposed storage
snapshots inside the local test process; it was not added to deployed code.
The baseline wrote a successful scheduled observation to SQLite-backed Durable
Object storage. Restarting with the candidate preserved every stored key/value
exactly. A candidate tick added an observation while preserving the history
origin. Restarting with baseline code read the candidate state exactly, and a
duplicate tick left it unchanged. Outbound requests were synthetic stubs.
An initial local attempt correctly recorded failure because its healthy-response
stub lacked the required cleanup snapshot; that test fixture was corrected.

This rehearsal verifies healthy-state read/write overlap and duplicate-tick
behavior locally. It does not reproduce provider internal errors, validate
hosted storage persistence, test pending-email delivery across interruption, or
establish production recovery. No remote deployment or database mutation was
performed.

Mitigation commit 685d891 completed push Verify 40891834943, Secret scan
40891835000 and browser checks 40891834899 successfully. The new recovery-tooling
commit needs its own exact-source CI. Issue #8 remains open; production freshness
and scheduled Durable Object failures are unresolved.
