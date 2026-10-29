# Open-tab asset overlap rehearsal, October 29

Real Chromium tests used the retained baseline build source b2b3a069a44e8b9d41feb266671863c23bafa310 and candidate d6fd3faca61d2d5c350d62f4e8ad5bcd50cc8f32. The baseline had32 packaged files, candidate26, and assembled forward/rollback packages34 each. No hosted assets, application, provider state or member records were changed.

Each case first rendered the old login page, confirmed the actual lazy module from its compiled entry had never been requested, entered a synthetic form value, then switched the loopback server’s package. The existing page imported its old lazy module without reloading; a separate fresh browser context loaded the target login page. Service workers and external requests were blocked, responses were no-store, and API requests used an unauthenticated local stub.

| Transition | Old lazy module | Existing document/form | Fresh target tab |
| --- | --- | --- | --- |
| Forward without retention | Failed with module-MIME error | Preserved | Rendered |
| Forward with retention | Loaded; exact baseline entrypoint bytes | Preserved | Rendered |
| Rollback without retention | Failed with module-MIME error | Preserved | Rendered |
| Rollback with retention | Loaded; exact candidate entrypoint bytes | Preserved | Rendered |

The lazy entries were TraceInspector-DpIta2v8.js (baseline) and TraceInspector-D6YqXBwI.js (candidate). Both retained cases loaded their one cold entrypoint with no module-MIME or old-page errors; both controls loaded zero and reported one MIME error. The maintained CLI with --open-tab also passed the forward negative/positive pair. Fourteen asset assembly/verification tests, the asset TypeScript project and formatting checks passed.

This confirms a real failure mode missed by checking only that new tabs render: already-open documents can still break when they request an old lazy module. Both deployment and rollback packages must retain immutable assets. The test imported the real module but did not mount its signed-in feature UI. Hosted owner/picker flows, live asset switching, authenticated sessions, encrypted content, native compatibility and full daily-release acceptance remain outstanding under #3/#41. No zero-downtime or monthly99.99% claim follows from this bounded local rehearsal.
