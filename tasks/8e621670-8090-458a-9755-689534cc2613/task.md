## Objective

P1: make maintained configuration generation deterministically preserve explicitly reviewed operational flags and the HEALTH_MONITOR binding, without implicitly authorizing feature activation or changing live configuration.

## Origin and context

Bobby’s operator desktop request of November 22, 2026. Structured operation `6cc2b27e-2467-4349-a997-f670528d5334`, job `7bc21f30-83cb-42e9-952a-afccdd6c33aa`, recorded a failed runtime-config-review check with exit code 1 and complete output capture for candidate snapshot `63e0c99fffd5aed5dc8800811e13abde2ca69213211907bced6b4ea48e6c8030`. Source: `5c5c1adc76cb0a32dbc80cd56d7e3da7d10290d2`.

The operator’s private review reports omitted API flags KEY_RECOVERY_ENABLED, LOGOUT_PHASE_TIMING, SESSION_DENIAL_CLEANUP_V1, SESSION_DENIAL_WRITER_V1 and VIDEO_UPLOADS_V2; staging additionally omits SESSION_DENIAL_PARTITIONS_V1 and SESSION_DENIAL_QUEUE_TOPOLOGY_V1. HEALTH_MONITOR is also omitted. These are attributed operator observations, not independent inspection of private provider files.

Related context: [fixture correction](../e0cab286-0d93-4f28-b3c6-b4f602ec2fdd/task.md), [Thanksgiving validation](../460c54df-49ef-42d5-8bc6-20b7b4c4f21b/task.md), and [Small Potato integration #94](https://github.com/porchday/porchday/issues/94). Existing tasks do not cover this generator correction. GitHub duplicate search returned HTTP 401; remote reconciliation is pending and no issue was published.

## Scope

- Inspect [API generator](../../scripts/configure-worker.py), [edge generator](../../scripts/configure-edge.py), [existing renderer tests](../../scripts/configure-worker.test.ts), and relevant admission, recovery-reader, writer and rollback requirements.
- Propose a bounded schema for explicit environment-specific reviewed inputs, then implement the scoped generator correction only when execution is separately authorized. Validate types, supported names, binding targets and documented combinations before writing output. Specify missing-input behavior that prevents silent loss of required admitted settings.
- Preserve reviewed true and false values explicitly. Defaults and live observations do not authorize enabling flags. Keep secret/private runtime values outside source and chat; obtain required reviewed inputs through the approved operator channel.
- Add focused tests with synthetic inputs for staging and production, deterministic regeneration, invalid and missing inputs, rollback constraints and preservation of existing configuration safeguards.
- Separate source corrections from provider normalization. Edge API_BACKEND names the expected service, but the provider’s additional environment field requires evidence before declaring equivalence or changing generated bindings.
- Preserve disabled sensitive logging, tracing persistence and logpush. Missing provider observability metadata is unknown state, not evidence of enabled logging or equivalence.
- Record release blockers and outstanding operator decisions. Reconcile matching GitHub tracking and ROADMAP priority when access and scope permit, searching open and closed issues before creating any issue.

No deployment, upload, migration, runtime changes, secret access, commit, push or CI dispatch is authorized by task creation. Do not broaden feature-voting policy or alter the fixture/validation tasks’ criteria or dependencies.

## Acceptance criteria

- Reviewed input contract covers every reported flag and HEALTH_MONITOR, with explicit environment applicability and validation; no blind copying of provider settings or implicit activation.
- Repeated generation from identical synthetic reviewed inputs produces identical configuration, preserving both enabled and disabled choices and documented admission/rollback invariants.
- Focused tests demonstrate valid configurations for both environments and rejection of malformed inputs or unsafe combinations before overwriting valid output. Existing renderer safeguards remain intact.
- Binding representation differences are either supported by recorded equivalence evidence or retained as unresolved release blockers; no speculative normalization is accepted as proof.
- Sensitive log/tracing persistence remains explicitly disabled. Absent provider metadata is reported honestly.
- Evidence identifies the exact source, checks performed, remaining reviewed inputs and limitations. Any later publication, source-bound release checks and production verification require their own authorization and evidence.

## Implementation status

Planned; not dispatched. No implementation changes made in this planning turn. automaticTaskExecution is disabled. Existing task documents and proposals remain unchanged.

## Verification evidence

The supplied structured receipt establishes runtime-config-review failure, not its detailed cause. Operator review supplies the reported omissions. Main-chat source inspection confirms the API generator explicitly handles other admission flags but lacks explicit handling for the listed flags and HEALTH_MONITOR; the edge generator emits API_BACKEND without an environment field. Both generators explicitly disable observability persistence. Existing tests cover logging controls and reader/writer regeneration safeguards. No new tests or provider inspection ran in this turn.

## Human acceptance

Not human-accepted. Explicit application sign-off is required. Acceptance, execution authorization, publication, deployment and production verification remain separate.

## Open questions

- What exact per-environment flag values and monitor binding target has the operator reviewed, and which may be retained as nonsecret configuration inputs?
- Which missing inputs must block generation to preserve already admitted readers/writers?
- Does the provider’s API_BACKEND environment field represent the same binding, and what evidence establishes that?
- What additional evidence is needed to resolve absent provider observability metadata while retaining disabled sensitive logging?
- GitHub issue reconciliation remains blocked by HTTP 401; retain this task as the unpublished follow-up record.
