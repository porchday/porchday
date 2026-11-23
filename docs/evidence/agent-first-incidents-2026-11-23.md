# Agent-first incident handling — November 23, 2026

PR [#246](https://github.com/porchday/porchday/pull/246), candidate `8d1fc536bb096de24db4b3564f10ccd3c17941ac`, merged as `8ad8d85070cb9cc11f67be6e3b5dc32f530260ef`. Tracks [#8](https://github.com/porchday/porchday/issues/8); unresolved latency and transport causes remain in [#55](https://github.com/porchday/porchday/issues/55).

## Behavior

Confirmed Mac, Cloudflare aggregate and GitHub backup detections request a recorded investigation before ordinary owner paging. The responder investigates the triggering interval even after recovery and returns an incident-bound, evidence-backed disposition. Benign findings and verified recoveries stay quiet; confirmed impact or an investigation blocker produces a reviewed notification. No completed turn is treated as a resolution without its validated disposition. New failure signatures renew investigation.

A demonstrated privacy failure alerts immediately. Missing, invalid or overdue dispositions produce an explicit responder fallback after 15 minutes. Cloudflare emails are fallback-only when an incident is at least 15 minutes old and the external receiver heartbeat is missing. GitHub backup falls back when handoff is unavailable. These fallbacks identify monitoring/investigation failure rather than claiming application downtime without evidence. Legacy notifications already queued before installation retain their delivery semantics.

Healthy polling is ordinary network/file/daemon work, not model inference. Raw journey/SLO observations, monitor history, durable session evidence and privacy enforcement are preserved. The existing 48-hour review now audits investigation completion and notification decisions across the full interval.

## Dispatch defect and verification

The managed daemon socket pointed to a missing socket. Idempotent startup/bootstrap restored the daemon; its original exit cause is unknown. New connections asynchronously start a missing daemon without restarting active work or blocking probes. A real read-only drill completed with a valid `not_incident` disposition and zero owner events. Exact-turn bounded result reads were also verified.

146 targeted tests in 20 files passed, along with strict monitor/CLI typechecks and direct GitHub backup runtime import. Exact-source release gates passed:

- Full CI [45227452628](https://github.com/porchday/porchday/actions/runs/45227452628), attempt 2; PR full CI also passed on retry.
- Secret scan [45227452815](https://github.com/porchday/porchday/actions/runs/45227452815).
- iOS simulator tests and launch evidence [45227452693](https://github.com/porchday/porchday/actions/runs/45227452693), attempt 3.
- macOS build/tests [45227452600](https://github.com/porchday/porchday/actions/runs/45227452600), attempt 2.

Earlier failures are retained: hosted Mac runner capacity, simulator app/test-runner launch failure, and intermittent unchanged composer/WebKit assertions. No failed gate was bypassed or assertion relaxed. Native parity was explicitly audited; no signed native binary was distributed.

## Installed versions and acceptance

The Mac bundle was installed at 18:10:35 UTC with SHA-256 `551c0510749df922f1109bdbc53d430d9d48fbb73e9c17b6b6454516e8861314`. The existing daemon/configuration/history were preserved with only the reviewed bundle, responder path/checkout and staging inbox capability updates.

Staging monitor: `49db6313-6b87-4b24-aa1b-027683fa931b`. Activation passed nine continuity samples with zero failures, verified logout/revocation and fixture cleanup. Authenticated inbox, unauthorized rejection and real receiver heartbeat passed.

Production monitor: `e190cf1f-bf7e-4f84-a000-f89cf44dc7d0`. Operation `e0173e21-5204-4eac-8181-6be2ab9424e0` finalized at 18:14:40 UTC. The first verification stopped after unchanged asset downloads timed out; all fourteen original continuity samples were healthy. Explicit reconciliation of the same durable operation passed fresh verification and finalized without replaying activation. Original unknown/attention-required evidence is retained. Retained fixture denial, final logout and owned-row cleanup passed. Production authenticated inbox, unauthorized rejection and real receiver heartbeat passed with no active aggregate incidents.

Application API/frontend versions were not changed. Both monitor environments retain their existing behavior and history; added inbox/heartbeat keys remain compatible with rollback.

## Post-release health window

9 complete Mac journeys passed from 2026-11-23T18:15:36.063Z through 2026-11-23T18:18:15.814Z (159.8 seconds), each covering all nine checks. No open incident or pending notifications remained. The installed bundle hash matched the installation receipt, and launchd reported the monitor running.

Normal GitHub backup [45236303402](https://github.com/porchday/porchday/actions/runs/45236303402) passed two complete journeys, found no open incident and created no linked alert comments. Its 4,356.6-second scheduling gap remains retained as diagnostic coverage evidence, not an inferred outage.

## Remaining causes

An actual incident occurred around 18:05–18:06 UTC before the Mac installation. The installer waited for stable recovery and the old notification outbox to drain. The restored responder automatically investigated, verified nine healthy journeys over 159.5 seconds and retained unresolved transport/deadline and synthetic-session evidence. See [incident evidence](https://github.com/porchday/porchday/issues/52#issuecomment-7109745622). Recovery does not establish the root cause or prove 99.99% availability.

Private receipts, original failures, source provenance, activation journals, cleanup evidence and drill output are retained under the owner-only `artifacts/private/agent-first-20261123` directory. Credentials and member content are excluded from this report.
