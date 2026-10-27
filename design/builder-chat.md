# Builder chat design specification

Status: built, October 27, 2026, and shipped switched off. The pause defaults to on and the allowlist starts empty. The bridge install guide is [apps/builder-bridge/README.md](../apps/builder-bridge/README.md).

## Summary

Builder chat lets a small, hand-picked group of Porchday members talk with the Codex session that develops Porchday. A member opens the builder chat page in the web app and types a message. A bridge program on the Mac mini that runs Codex passes the message into the same Codex session that writes and deploys Porchday, and Codex's reply appears on the member's screen while Codex works.

The owners made three decisions that shape this design:

- **Direct access.** A member's message goes straight to the building Codex session, the same way Nick's requests do through `~/nick-requests.txt`. Codex may change code because of a member's message, and that change can reach staging and production through the existing hourly deploy.
- **Live chat.** Replies appear while Codex works, instead of arriving later as a ticket reply.
- **Opt-in allowlist.** Only members that an operator enables can see or use builder chat. The allowlist is a small group of people the maintainers know and trust.

Because Codex keeps shipping changes from these conversations, every change Codex makes from builder chat must be easy to undo. The [rollback](#rollback) section describes how.

Builder chat does not change the community rule that only humans may hold member accounts. Codex is not a member account, and Codex never posts, comments, reacts or connects inside the social network. Codex only answers in builder chat threads.

## Goals

- An approved member can ask what is being built, report a problem, or suggest a change, and see Codex respond within seconds.
- The member can watch Codex's progress on their request, including when Codex commits a change.
- Operators can see every builder chat conversation, pause the feature, and remove a member's access.
- Any change that Codex ships from builder chat can be rolled back quickly, by Codex or by an operator.
- Credentials and other members' data never appear in builder chat replies.
- Adding builder chat must not put the rest of the site at risk.

## Out of scope

- Access for all members. The allowlist stays in place until the owners make a separate decision.
- Chat inside the iOS app. The first version is web and PWA only.
- Group conversations. Each member has one private thread with Codex.
- Attachments and photos. Messages are plain text only.
- Codex starting a conversation. Codex only replies to members.
- A Porchday notification when a reply is complete. The first version shows the reply on the builder chat page only, because the notifications table requires a member as the actor and changing it would touch every notification path. This can be added later.

## Member experience

### Access and first use

An allowlisted member sees a new item, "Builder chat", in the sidebar, and a chat icon in the mobile header. Members who are not on the allowlist don't see the item, and every builder chat API route returns `404` for them, including during a pause, so the feature is not discoverable.

Before the first message, the member sees a notice and must check a box to continue. The notice states these facts:

- Your messages go to an AI coding agent (OpenAI Codex) that builds Porchday, running on a computer operated by a Porchday maintainer.
- Porchday's operators can read everything you send and everything Codex replies. Builder chat is not encrypted on your device the way your posts are.
- Codex may change Porchday because of what you write, and changes can reach every member within about an hour.
- Don't share passwords, recovery codes, private posts or anything about another person.
- Your messages are kept for 90 days and are deleted when you delete your account.

The server records the version of the notice each member accepted. Raising `BUILDER_CHAT.disclosureVersion` in `apps/api/src/builder-chat.ts` requires every member to accept again. The privacy policy has a matching "Builder chat" section.

### Conversation

The chat page shows the member's thread, a text box with a 2,000 character limit, the number of messages left today, and a status line. The status line shows one of these states:

| State | What the member sees |
| --- | --- |
| Offline | "Codex is offline right now. You can send a message and it will be answered when Codex is back." |
| Queued | "Waiting for Codex. 2 messages ahead of yours." |
| Working | Codex's written messages as they arrive, and a progress line such as "Codex is editing files", "Codex is running tests" or "Codex is committing a change". |
| Done | The full reply. When Codex committed a change, links to the commits and "Changes usually reach Porchday within about an hour." |
| Paused | "Builder chat is paused by the Porchday team." |

A member can leave the page while their message is queued or being answered. The reply is saved to the thread. A member can have only one message queued or in progress at a time, and the send button stays disabled until the current reply finishes. Status changes and finished replies are announced through a polite live region for screen reader users. The member can download their builder chat messages as JSON from the page.

## Architecture

```
Member's browser ──HTTPS, polls every 2 s while a reply is on its way──▶ Porchday Worker ──▶ PlanetScale Postgres
                                                                           ▲                 (queue, threads,
Bridge on the Mac mini ──HTTPS, polls every 3 s, bridge token──────────────┘                  allowlist, audit)
        │
        ▼
codex exec resume <builder session>
```

The design has four parts:

- **Web page.** `/app/builder-chat` in `apps/web/src/BuilderChat.tsx`, and a read-only staff section in `apps/web/src/StaffBuilderChat.tsx`.
- **API.** `apps/api/src/builder-chat.ts`, with member routes under `/api/v1/builder-chat`, bridge routes under `/api/builder-bridge` and the staff route `/api/staff/builder-chat`.
- **Bridge program.** `apps/builder-bridge`, a dependency-free Node program that runs on the Mac mini as a launchd agent. It only makes outbound requests, so the Mac mini stays private.
- **Database.** Migration `050_builder_chat.sql`.

Postgres holds the queue, and both the browser and the bridge poll over ordinary HTTPS. An earlier draft used a Cloudflare Durable Object holding WebSocket connections. That approach was dropped to keep the site stable: Porchday doesn't use Durable Objects, and adding one would have changed the Worker's deploy configuration and every deploy that follows. With polling, the only change to the deploy configuration is one new variable, `BUILDER_CHAT_PAUSED`. The browser polls every 2 seconds only while one of its messages is queued or in progress, every 15 seconds otherwise, and never in a hidden tab, so the extra load comes from a few allowlisted members.

### Message flow

1. The member sends a message. The API checks the session, the allowlist, the notice acceptance and the pause, then `app.builder_chat_send` checks the limits under one advisory lock and stores the message with status `queued`.
2. The bridge takes the shared lock file and asks the API for work. `app.builder_chat_claim` returns the oldest queued message from an active, allowlisted member, marks it `working`, and records that the bridge is connected. Only one message is `working` at a time, because there is one builder session.
3. The bridge frames the message as described in [Message framing](#message-framing) and runs it as a new turn in the builder session.
4. While Codex works, the bridge sends Codex's written messages and a progress label to the API at most every 1.5 seconds. The member's page shows them on its next poll.
5. When the turn ends, the bridge sends the final reply, the status and the commits made during the turn. The API stores them and marks the message `answered`, `timed_out` or `failed`.

### The Codex connection

The bridge drives the existing builder session, not a new session for each member, because the owners want members to reach the same session that builds Porchday. It runs `codex exec resume <options> --json <session> -` in the builder checkout, with the framed message on standard input so it never appears in the process list. `codex exec --json` prints one JSON event per line. The bridge reads Codex's messages, the commands Codex runs and file changes from those events. This interface is not marked experimental in Codex 0.164.0, and a test on October 27, 2026 confirmed that a resumed turn remembers the earlier turns of the session. `codex app-server` was not used because it is marked experimental.

Builder chat turns and Nick's file requests must not run at the same time in the same session. The bridge takes the lock file `~/.porchday-builder.lock` before it claims a message, and `AGENTS.md` tells the builder session to take the same lock with `apps/builder-bridge/builder-lock.sh` before working on a file request. While another job holds the lock, the bridge only reports that it is connected, so members see "Waiting for Codex" rather than "offline".

If the builder session is also open in an interactive Codex window, that window keeps its own copy of the conversation in memory and does not see turns the bridge adds until it is resumed again. The bridge install guide asks Bobby to check how the session runs before installing.

Each turn has a 10 minute limit. When a turn runs longer, the bridge interrupts Codex, tells the member "Codex ran out of time on this request", marks the message `timed_out`, and tells Codex at the start of the next turn to check `git status`. If the bridge itself stops during a turn, the server marks the message `timed_out` 12 minutes after the turn started.

A pause stops new turns but lets a running turn finish. Removing a member during their turn stops the replies from being stored, but Codex also finishes that turn. Stopping Codex in the middle of an edit could leave the builder checkout half changed, which is a bigger risk to the site than a few extra minutes of work.

### Message framing

The bridge wraps each member message so that Codex knows who is talking and records the turn correctly:

```
Builder chat message from @handle (member ID 0b6f...), builder chat message ID 8c21....
Follow AGENTS.md, including its "Builder chat turns" section and the rollback rules there.
End every commit message you make for this request with the line: Builder-Chat-Message: 8c21...
--- message ---
<text>
--- end message ---
```

The "Builder chat turns" section of `AGENTS.md` holds the rules Codex follows in these turns.

### Output filtering

The bridge forwards only Codex's own written messages and a progress label from a fixed list (reading files, editing files, running tests, committing a change, working). It doesn't forward commands, command output, file contents, diffs, environment variables or Codex's reasoning. They are dropped when the bridge reads the event, before anything reaches the network.

Before forwarding text, the bridge also checks each paragraph against the patterns in `scripts/check-secrets.py`, plus OpenAI keys, JSON web tokens and assignments such as `SECRET=...`. A paragraph that matches is replaced with "[Part of Codex's reply was held back.]". The audit log records which pattern matched, but never the held back text, so a leaked credential is not copied into the database.

## Data model

Migration `050_builder_chat.sql` adds these tables. Runtime roles have no direct table access. Members, the bridge and staff reach the tables only through `SECURITY DEFINER` functions granted to `porchday_social`, `porchday_jobs` and `porchday_auth` respectively.

| Table | Columns | Notes |
| --- | --- | --- |
| `app.builder_chat_access` | `member_id`, `enabled_by`, `enabled_at`, `disclosure_version`, `disclosure_accepted_at` | The allowlist. A row exists only for enabled members. |
| `app.builder_chat_messages` | `id`, `member_id`, `body`, `status`, `progress`, `reply`, `commits`, `created_at`, `started_at`, `completed_at` | One row per member message and Codex's reply. `status` is `queued`, `working`, `answered`, `timed_out` or `failed`. |
| `app.builder_chat_audit` | `id`, `member_id`, `message_id`, `event`, `detail`, `created_at` | Operator record of access changes, notice acceptance, claims, outcomes, cancellations and held back patterns. Never holds message text. |
| `app.builder_chat_bridge` | `seen_at` | One row, the last time the bridge reached the API. Members see Codex as online when it is less than 30 seconds old. |

Messages and audit entries older than 90 days are deleted when the bridge claims work and when the member opens the page. Every row references `app.members` with `ON DELETE CASCADE`, so account deletion removes it in the same transaction. The member's download comes from `GET /api/v1/builder-chat/export`. Builder chat is kept out of the main encrypted archive export, because that format has its own contract and restore tests and builder chat is not end-to-end encrypted. Nothing from builder chat is visible to other members.

The migration also widens `public.staff_users.roles` to allow `builder_chat`.

## Operator controls

- **Allowlist.** `scripts/builder-chat-access.ts add|remove <handle>` and `list`, run with the environment's `DATABASE_MIGRATION_URL`. Removing a member ends their access on their next request and cancels their queued message.
- **Pause.** `builder_chat_paused` in `infra/resources.json` becomes the Worker variable `BUILDER_CHAT_PAUSED`. Anything other than an explicit `false`, including a missing value, keeps builder chat paused. Operators can also stop the bridge program on the Mac mini directly. See [docs/incident-response.md](../docs/incident-response.md#builder-chat).
- **Staff view.** Staff with the `builder_chat` role see a read-only builder chat section on `/staff`, with the allowlist, every message and reply with its message ID and commits, the audit log, and when the bridge last connected.
- **Bridge credential.** The bridge authenticates with a random token, `BUILDER_BRIDGE_TOKEN`, uploaded to the production Worker with `wrangler secret put`. Without the secret, the bridge routes return `404`. The token is compared in constant time and allows only the bridge routes.

## Limits

| Limit | Value |
| --- | --- |
| Message length | 2,000 characters |
| Messages per member | 20 per day, and one queued or in progress at a time |
| Queue length | 20 messages for the whole service. Further messages are refused with "Codex is busy, try again later." |
| Turn length | 10 minutes |

The values are constants in `apps/api/src/builder-chat.ts`, so changing one needs a code change and a deploy.

## Rollback

Codex keeps deploying hourly, so the plan for a bad change is a fast undo rather than review before each deploy. The rollback path has these parts:

- **Commits are recorded per message.** The bridge records the commits made during each turn in `builder_chat_messages.commits`. These are the commits carrying the message trailer, plus commits made with the checkout's own git identity, so commits pulled from other people during the turn are not counted. Commits are recorded even when the turn timed out or the member lost access. Codex ends each commit message with `Builder-Chat-Message: <message ID>`, so the commits can be found in `git log` without the database.
- **History stays linear.** `AGENTS.md` tells Codex to add only ordinary commits in builder chat turns and never to force push, rebase or rewrite history, so any change can be undone with `git revert`.
- **Codex can undo its own change.** When asked, Codex runs `scripts/builder-chat-rollback.ts` for the message, runs the tests, pushes, and replies with the revert commit.
- **Operators can undo without Codex.** `scripts/builder-chat-rollback.ts <message ID>` finds the message's commits by trailer, skips ones already reverted, and reverts them newest first. `--commit <hash>` adds commits that lack the trailer, `--dry-run` lists them, and nothing is pushed without `--push`.
- **Immediate rollback of the live site.** Cloudflare keeps the Worker's recent versions. `wrangler deployments list` shows them and `wrangler rollback <version ID>` returns to one within seconds. The operator then reverts the commits so the next hourly deploy doesn't ship the change again. The procedure is in `docs/incident-response.md`.
- **Database changes stay compatible.** Codex must not drop or rename columns or tables during a builder chat turn, because a Worker rollback cannot undo a migration.

## Basic safeguards

The allowlisted members are trusted, so the safeguards are ordinary operational controls:

- The allowlist, rate limits, queue limit and turn limit described above.
- The pause control, the bridge token and the staff view.
- The output filter, which keeps command output and credentials out of replies.
- The privacy policy section and the notice, because members' messages go to OpenAI.

## Later phase: separate Codex from deploy credentials

Today the Codex session runs as Bobby's macOS user, so Codex can read `~/.config/inner-circle/secrets.env` and deploys Porchday itself. Builder chat launches without changing this. In a later phase, before the allowlist grows, Bobby can move the credentials out of Codex's reach while keeping hourly deploys. The steps are:

1. Create a separate standard macOS user for Codex, e.g. `sudo sysadminctl -addUser porchday-codex`, and confirm that Bobby's home folder and `~/.config/inner-circle` are not readable by that user (`chmod 700` on the folder and `600` on `secrets.env`).
2. Sign in to Codex as the new user and give the new user its own checkout of `porchday/porchday`, with a GitHub credential that can push to the repository but has no other access.
3. Run the Codex builder session and the bridge program as the new user. The request file and the lock file move to a folder that both users can write.
4. Create a deploy job that runs every hour as Bobby's user through a `launchd` agent. The job pulls `main` into a separate checkout, runs `npm ci`, the tests and the build, applies migrations, deploys staging, runs the staging smoke check, and then deploys production, using `scripts/with-secrets.py` as the current procedure in `docs/operations.md` describes.
5. Have the deploy job write its results, including the deployed commit, the Worker version IDs and any failure, to a status file the Codex user can read. Codex reads the status file to tell members when their change went live.

After this phase, Codex still ships every hour, but no conversation can make Codex read or print a deployment credential, because the Codex user cannot open the credentials file.

## Testing

All checks run locally. There is no separate staging verification for builder chat.

- `apps/api/test/builder-chat.integration.test.ts` runs against PostgreSQL with the real runtime roles. It covers:
  - `404` for members who are not allowlisted, including during a pause
  - the notice requirement, the pause, and a missing pause setting treated as paused
  - the length limit, one message in flight, the daily limit and the queue limit
  - first-in, first-out order, one turn at a time, and progress visible only to the sender
  - the bridge token and the heartbeat mode
  - server timeouts, stopping when access is removed, and a running turn continuing during a pause
  - the member's export and deletion with the account
  - the allowlist command
  - table and function permissions per role, and the staff role
  - a `404` rather than a `503` if the Worker is deployed before the migration
- `apps/builder-bridge/test/bridge.test.ts` covers:
  - the output filter, including command output and secrets never being forwarded
  - progress labels and message framing
  - the lock file and its compatibility with `builder-lock.sh`
  - the Codex runner with a fake Codex, including the timeout
  - commit recording against a scratch repository
  - the bridge's turn handling, retries and settings
- `scripts/builder-chat-rollback.test.ts` reverts the right commits in a scratch repository and leaves other work in place.
- `apps/web/test/builder-chat.test.ts` covers the status line, plain text rendering of replies, commit links and the notice.
- A local end to end run on October 27, 2026 used a disposable database, the API server, the real bridge, a real Codex session in a scratch checkout and a real browser for one of two synthetic allowlisted members. It passed every check:
  - notice acceptance in the browser
  - a queued second member who could not see the first member's thread
  - a commit with the trailer, recorded by the bridge
  - operator rollback, and Codex undoing its own change when asked
  - a pause, and removal of access during a turn
  - a message waiting while the request-file lock was held
  - the live region announcement
  - light, dark and phone layouts
  - the staff view

## Rollout plan

1. Merge the feature to `main` switched off, with the pause on and the allowlist empty. The hourly deploy on the Mac mini ships it, including migration 050.
2. Bobby installs the bridge with [apps/builder-bridge/README.md](../apps/builder-bridge/README.md). That covers checking how the builder session runs, creating and uploading the token, adding the lock to the request-file loop, and installing the launchd agent.
3. An operator sets `builder_chat_paused` to `false` for production and adds the first member.
4. Later, Bobby sets up the separate Codex user and deploy job described in [Later phase](#later-phase-separate-codex-from-deploy-credentials).

## Decisions and open questions

Bobby has agreed to run the bridge on his Mac mini and to the shared lock file between builder chat turns and Nick's request file.

One question remains open. The bridge works best when every turn in the builder session, including Nick's file requests, runs as a separate `codex exec resume` turn. If the builder session is an interactive Codex window that stays open, that window won't see builder chat turns until it is resumed. Bobby checks this in step 1 of the install guide.
