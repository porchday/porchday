# Hidden builder navigation — November 10, 2026

Builder chat and Feature additions are hidden from mobile More menus and desktop sidebars. Web/shared hosted native shells and alternate SwiftUI iOS/macOS navigation are updated. Underlying routes, screens, APIs and data remain intact. Direct URLs remain reachable under existing authorization; this is navigation containment, not access revocation. The reported Feature additions loading failure remains unresolved.

Tracked in #29 and #44; implementation and release in [PR #218](https://github.com/porchday/porchday/pull/218).

Runtime source: `e0f6ac9fef11542994667a557700f70755d5c11d`. No backend or schema deployment.

| Environment | Active edge/UI version |
| --- | --- |
| staging | `952638a4-32f1-438f-a6b4-d6f3e4053561` |
| production | `edd6c273-6088-4d0a-9ffc-31bd847eed20` |

## Validation

Local typecheck, web build and the updated existing browser navigation acceptance passed. Staging and production authenticated checks verified that mobile More and desktop sidebar have neither builder link while Settings remains available. Existing encrypted-photo, draft-preservation, automatic-update, routing and simulated native-shell checks passed; synthetic fixtures were cleaned. Retained assets and rollback were verified.

- [Verify Porchday](https://github.com/porchday/porchday/actions/runs/42847604657).
- [Secret scan](https://github.com/porchday/porchday/actions/runs/42847605131).
- [Verify native iOS](https://github.com/porchday/porchday/actions/runs/42847604888).
- [Verify native macOS](https://github.com/porchday/porchday/actions/runs/42847605026).

Independent production monitoring: 8 healthy samples over 140014 ms, zero failures.

The initial staging rollback-ready activation stopped before candidate journey/browser verification. Its authenticated continuity samples stayed healthy. The same durable operation was reconciled and rolled back; owned fixtures were cleaned before retry. The first production candidate attempt stopped in prepared state before any provider-write intent; it was cancelled through maintained tooling and its owned fixtures cleaned before a fresh activation. Original evidence remains retained under release-verification follow-up #3. The macOS push run was requeued once while waiting without a runner; no check or source was weakened.

## Remaining verification

Physical iPhone/Mac menu confirmation remains `needs verification` in #29/#44. Native source and automated builds are verified; no new signed installer, TestFlight or App Store binary is claimed. The default hosted native shells receive the web navigation change; alternate SwiftUI changes require a subsequent binary distribution.
