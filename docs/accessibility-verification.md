# Web accessibility verification

This is bounded development evidence for the signup, connections, posting, reporting, builder chat, and account-deletion journeys. It is not a WCAG conformance certificate or a real screen-reader test.

## Local keyboard and semantic checks

Run the web dev server and the isolated browser harness:

```sh
npm run dev -w @porchday/web -- --host 127.0.0.1
npx tsx scripts/local-accessibility.ts http://127.0.0.1:5173
```

The harness refuses non-loopback targets, starts a fresh headless Chromium context, blocks service workers and external requests, and intercepts every API request with synthetic responses. It never loads operator credentials, contacts a hosted environment, sends email, or changes real accounts. Member journeys use locally generated OpenPGP keys, the real browser remembered-device store, and actual client encryption/decryption. That seeding is fixture setup, not an encryption-onboarding acceptance claim. Browser contexts are closed afterward.

The October 25, 2026 run passed:

| Journey | Observed behavior |
| --- | --- |
| Navigation | Keyboard skip link focuses the main landmark. SPA links focus the page heading. Delayed login/remembered-device loading moves focus to the final heading; subsequent keyboard interaction cancels that pending movement. |
| Signup | Inputs have exact accessible names and help descriptions. Native required-field validation focuses the first missing field. A rejected request retains input and exposes an alert. Successful submission focuses the email-next-step heading. No email is sent. |
| Connections | Accept, decline, and cancel controls identify their target person. Accept/cancel completion announces the result and gives a stable focus target after the request row disappears. A delayed acceptance preserves focus and text when the person starts typing in the surviving search field. |
| Posting | Keyboard navigation reaches the textarea, native audience selector, and Share button. The submitted envelope decrypts to the entered text and selected `only_me` audience; success is a status announcement. |
| Reporting | Keyboard opens the report from post options. Native dialog focus stays inside with forward/backward Tab; Escape restores the persistent post-options button even though the menu item unmounted. Default submission discloses no encrypted evidence. Completion focuses Done, which returns focus to the post options. |
| Builder chat (October 27, 2026) | The sidebar link focuses the page heading. Continue stays disabled until the member checks the disclosure checkbox with the keyboard. The message textbox has an exact name and is described by its character and daily limits. After sending, the reply is announced through a polite live region once the synthetic queued message is answered. |
| Account deletion | Confirmation stays disabled until exact `DELETE`. Escape returns focus to the opening control. A synthetic reauthentication failure keeps the dialog and confirmation text, exposes an alert, and refocuses the confirmation input. A subsequent synthetic success follows normal sign-out and landing-page focus. |

Relevant regression checks:

```sh
npx vitest run apps/web/test
npm run build -w @porchday/web
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --esModuleInterop --skipLibCheck --lib es2022,dom scripts/local-accessibility.ts
```

`apps/web/test/client-security.test.ts` verifies explicit input IDs, label association, composed caller/help descriptions, and existing timer, busy-button and private-cache behavior. The public acceptance tests retain invitation/adult/consent requirements. The full web suite passed 57 tests in 11 files; the build and standalone harness typecheck passed. Signup screenshots at 1280 and 375 pixels were inspected locally, with no horizontal overflow or clipped labels; ignored images are under `artifacts/private/accessibility/`.

## Remaining human validation

A person still needs to use a real screen reader (for example VoiceOver/Safari and NVDA/Firefox or Chrome) to validate spoken order and announcements, dialog transitions, form errors, reaction meanings and image descriptions in these journeys. Automated accessible-name/focus checks cannot establish what is actually spoken. This pass also does not establish full zoom/reflow, touch, every personalized theme, every browser, or native iOS accessibility acceptance. Prior measured contrast and hosted feature evidence remain separate in the build and hosted-verification documents. No hosted deployment or real screen-reader success is claimed by this local check.
