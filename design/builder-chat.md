# Builder chat design specification

Status: implementation specification, October 27, 2026. This document describes a feature that is not built yet.

## Summary

Builder chat lets a small, hand-picked group of Porchday members talk in real time with the Codex session that develops Porchday. A member opens a chat page in the web app and types a message. A bridge program on the Mac mini that runs Codex passes the message into the same Codex session that writes and deploys Porchday, and Codex's reply streams back to the member's screen as Codex writes it.

The owners made three decisions that shape this design:

- **Direct access.** A member's message goes straight to the building Codex session, the same way Nick's requests do today through `~/nick-requests.txt`. Codex may change code because of a member's message, and that change can reach staging and production through the existing hourly deploy.
- **Live chat.** Replies stream to the member while Codex works, instead of arriving later as a ticket reply.
- **Opt-in allowlist.** Only members that an operator enables can see or use builder chat. The allowlist is a small group of people the maintainers know and trust.

Because Codex keeps shipping changes from these conversations, every change Codex makes from builder chat must be easy to undo. The [rollback](#rollback) section describes how.

Builder chat does not change the community rule that only humans may hold member accounts. Codex is not a member account, and Codex never posts, comments, reacts or connects inside the social network. Codex only answers in builder chat threads.

## Goals

- An approved member can ask what is being built, report a problem, or suggest a change, and see Codex respond within seconds.
- The member can watch Codex's progress on their request, including when Codex commits a change and when the change is scheduled to deploy.
- Operators can see every builder chat conversation, pause the feature immediately, and remove a member's access.
- Any change that Codex ships from builder chat can be rolled back quickly, by Codex or by an operator.
- Credentials and other members' data never appear in builder chat replies.

## Out of scope

- Access for all members. The allowlist stays in place until the owners make a separate decision.
- Chat inside the iOS app. The first version is web and PWA only.
- Group conversations. Each member has one private thread with Codex.
- Attachments and photos. Messages are plain text only.
- Codex starting a conversation. Codex only replies to members.

## Member experience

### Access and first use

An allowlisted member sees a new item, "Builder chat", in the main navigation. Members who are not on the allowlist don't see the item, and the API returns `404` for them, so the feature is not discoverable.

Before the first message, the member sees a disclosure screen and must check a box to continue. The disclosure screen states these facts in plain words:

- Your messages go to an AI coding agent (OpenAI Codex) that builds Porchday, running on a computer operated by a Porchday maintainer.
- Porchday's operators can read everything you send and everything Codex replies. Builder chat is not encrypted on your device the way your posts are.
- Codex may change Porchday because of what you write, and changes can reach every member within about an hour.
- Don't share passwords, recovery codes, private posts or anything about another person.
- Your messages are kept for 90 days and are deleted when you delete your account.

The server records the date and version of the disclosure each member accepted. A new disclosure version requires a new acceptance.

### Conversation

The chat page shows the member's thread, a text box with a 2,000 character limit, and a status line. The status line shows one of these states:

| State | What the member sees |
| --- | --- |
| Offline | "Codex is offline right now. You can send a message and it will be answered when Codex is back." |
| Queued | "Waiting for Codex. 2 messages ahead of yours." |
| Working | Codex's reply streaming in, with progress lines such as "Editing files", "Running tests" or "Committed 4c7ef31". |
| Done | The full reply, plus "Deploys to staging at 14:00" when Codex committed a change. |
| Paused | "Builder chat is paused by the Porchday team." |

A member can leave the page while their message is queued or being answered. The reply is saved to the thread, and the member gets an ordinary Porchday notification when the reply is complete.

A member can have only one message queued or in progress at a time. The send button stays disabled until the current reply finishes.

## Architecture

```
Member's browser ──WebSocket──▶ Cloudflare Worker ──▶ BuilderChatRelay (Durable Object)
                                       │                         ▲
                                       ▼                         │ outbound WebSocket
                                 PlanetScale Postgres            │ (bridge token)
                                 (threads, allowlist,     Bridge program on the Mac mini
                                  audit log)                     │
                                                                 ▼
                                                    Codex builder session (existing)
```

The design has four parts:

- **Web client.** A new route, `/app/builder-chat`, in `apps/web`.
- **API and relay.** New routes in `apps/api` and one Cloudflare Durable Object, `BuilderChatRelay`. A Durable Object is a Cloudflare object with a single running instance that can hold many WebSocket connections at once. Porchday doesn't use Durable Objects yet, so the implementer must add the binding to `scripts/configure-worker.py` and both generated Wrangler configurations.
- **Bridge program.** A small long-running program on the Mac mini, kept in a new folder, `apps/builder-bridge`. It connects out to the relay, so the Mac mini needs no open inbound port and stays private on the tailnet.
- **Database tables.** New tables added by a new migration, `048_builder_chat.sql`.

### Message flow

1. The member's browser opens a WebSocket to `/api/v1/builder-chat/socket`. The Worker checks the member's session, the allowlist, the disclosure acceptance and the pause flag, then hands the connection to the relay.
2. The member sends a message. The Worker validates the length, applies rate limits, stores the message in Postgres with status `queued`, and tells the relay.
3. The relay keeps one first-in, first-out queue for the whole service, because there is only one Codex builder session. When the bridge is connected and idle, the relay sends it the oldest queued message.
4. The bridge wraps the message as described in [Message framing](#message-framing) and sends it into the Codex session as a new turn.
5. While Codex works, the bridge receives Codex's events and forwards only the allowed kinds to the relay, after the output filter in [Output filtering](#output-filtering) runs. The relay streams them to the member's open sockets.
6. When the turn ends, the bridge sends the final reply and any commit hashes. The Worker stores the reply, marks the message `answered`, and creates a notification for the member.

### The Codex connection

The bridge must drive the existing builder session, not start a new Codex session for each member, because the owners want members to reach the same session that builds Porchday. The implementer should use Codex's programmatic interface on the installed version (for example `codex app-server`, which exposes threads, turns and streaming events, or `codex exec resume` with a fixed session ID). The implementer must check which interface the installed Codex version supports and record the choice in `apps/builder-bridge/README.md`.

Codex already reads `~/nick-requests.txt` about once a minute. Builder chat turns and Nick's file requests must not run at the same time in the same session. The bridge must take a lock file, `~/.porchday-builder.lock`, before starting a turn, and the existing request-file loop must take the same lock. Bobby has agreed to this change.

Each turn has a 10 minute limit. When a turn runs longer, the bridge interrupts it, sends "Codex ran out of time on this request" to the member, and marks the message `timed_out`.

### Message framing

The bridge wraps each member message in a short template so that Codex knows who is talking and records the turn correctly:

```
Builder chat message from @handle (member ID 0b6f...), builder chat message ID 8c21....
Follow AGENTS.md and the builder chat rules in design/builder-chat.md, including the rollback rules.
--- message ---
<text>
--- end message ---
```

### Output filtering

The bridge forwards only these Codex event kinds to the relay:

- Codex's own reply text.
- A short progress label for each step, chosen from a fixed list (reading files, editing files, running tests, committing, waiting).
- Commit hashes and changed file paths inside the repository.

The bridge doesn't forward raw command output, file contents, diffs, environment variables or Codex's reasoning text, because they are long, hard to read in a chat, and can contain credentials by accident. Before forwarding any text, the bridge also runs the same patterns as `scripts/check-secrets.py`. If a pattern matches, the bridge replaces that event with "Part of Codex's reply was held back", stores the original only in the operator audit log, and alerts the operators.

## Data model

Migration `048_builder_chat.sql` adds these tables. Only the API's social runtime role may read or write them, and members can only reach them through the API.

| Table | Columns | Notes |
| --- | --- | --- |
| `builder_chat_access` | `member_id`, `enabled_by`, `enabled_at`, `disclosure_version`, `disclosure_accepted_at` | The allowlist. A row exists only for enabled members. |
| `builder_chat_messages` | `id`, `member_id`, `role` (`member` or `codex`), `body`, `status`, `commits`, `created_at`, `completed_at` | `status` is `queued`, `working`, `answered`, `timed_out`, `withheld` or `failed`. |
| `builder_chat_audit` | `id`, `message_id`, `event`, `detail`, `created_at` | Operator-only record of bridge connections, filter matches, pauses and access changes. |

Messages are kept for 90 days and then deleted by the existing cleanup jobs. Deleting a member account deletes the member's builder chat rows in the same transaction as the other social deletion. Builder chat messages are included in the member's own data export and are never included in anything other members can see.

## Operator controls

- **Allowlist.** Operators add and remove members with a new command, `scripts/builder-chat-access.ts add|remove <handle>`, following the pattern of `scripts/invite.ts`. Removing a member closes their open sockets immediately.
- **Pause.** A new incident control, `BUILDER_CHAT_PAUSED`, joins the existing pauses in `infra/resources.json` and `docs/incident-response.md`. When the pause is on, the API refuses new messages, the relay stops sending turns to the bridge, and members see the paused state. Operators can also stop the bridge program on the Mac mini directly. The pause defaults to on, and the allowlist starts empty, so the feature code can be merged and deployed by the hourly deploy before the bridge is installed without any member seeing it.
- **Staff view.** The staff console gains a read-only builder chat page, protected by the existing Cloudflare Access staff login and a new `builder_chat` staff role, showing every thread, the queue and the audit log.
- **Bridge credential.** The bridge authenticates to the relay with a dedicated random token, `BUILDER_BRIDGE_TOKEN`, uploaded with `scripts/upload-worker-secrets.py`. The token allows only the bridge connection, and rotating the token disconnects the bridge.

## Limits

| Limit | Value |
| --- | --- |
| Message length | 2,000 characters |
| Messages per member | 20 per day, and one queued or in progress at a time |
| Queue length | 20 messages for the whole service. Further messages are refused with "Codex is busy, try again later." |
| Turn length | 10 minutes |
| Open sockets per member | 3 |

Operators can change these values in `infra/resources.json` without a code change.

## Rollback

Codex keeps deploying hourly, so the plan for a bad change is a fast undo rather than review before each deploy. The rollback path has these parts:

- **Commits are recorded per message.** The bridge records the commit hashes Codex makes during each builder chat turn in `builder_chat_messages.commits`. Codex also ends each commit message made during a builder chat turn with a line `Builder-Chat-Message: <message ID>`, so the commits can be found in `git log` even without the database.
- **History stays linear and complete.** Codex only adds ordinary commits to `main` during builder chat turns. Codex never force pushes, rebases or rewrites published history, so any change can be undone with `git revert`.
- **Codex can undo its own change.** When a member or operator asks Codex to undo a builder chat change, Codex reverts that message's commits with `git revert`, runs the tests, and lets the next deploy ship the revert. Codex replies with the revert commit hash.
- **Operators can undo without Codex.** A new command, `scripts/builder-chat-rollback.ts <message ID>`, reverts the commits recorded for a message and pushes the revert. The staff view shows the same message IDs and commit hashes.
- **Immediate rollback of the live site.** Before each deploy, the deploy job records the currently active Cloudflare Worker version for staging and production. When a change breaks the live site, an operator runs `npx wrangler rollback <version ID>` to return to the recorded version within seconds, and then reverts the commits so the next hourly deploy doesn't ship the broken change again. The procedure goes in `docs/incident-response.md`.
- **Database changes must be reversible.** A builder chat change that adds a database migration must keep the previous application version working, which the repository already does for migrations such as 041 and 042. Codex must not drop or rename columns or tables during a builder chat turn, because a Worker rollback cannot undo a migration.

## Basic safeguards

The allowlisted members are trusted, so the safeguards are ordinary operational controls:

- The allowlist, rate limits, queue limit and turn limit described above.
- The pause control and the staff view.
- The output filter, which keeps credentials out of replies even if Codex prints one by mistake.
- An updated privacy policy and the disclosure screen, because members' messages go to OpenAI and the current privacy policy doesn't mention builder chat.

## Later phase: separate Codex from deploy credentials

Today the Codex session runs as Bobby's macOS user, so Codex can read `~/.config/inner-circle/secrets.env` and deploys Porchday itself. Builder chat can launch without changing this. In a later phase, before the allowlist grows, Bobby can move the credentials out of Codex's reach while keeping hourly deploys. The steps are:

1. Create a separate standard macOS user for Codex, e.g. `sudo sysadminctl -addUser porchday-codex`, and confirm that Bobby's home folder and `~/.config/inner-circle` are not readable by that user (`chmod 700` on the folder and `600` on `secrets.env`).
2. Sign in to Codex as the new user and give the new user its own checkout of `porchday/porchday`, with a GitHub credential that can push to the repository but has no other access.
3. Run the Codex builder session and the bridge program as the new user. The request file and the lock file move to a folder that both users can write.
4. Create a deploy job that runs every hour as Bobby's user through a `launchd` agent. The job pulls `main` into a separate checkout, runs `npm ci`, the tests and the build, applies migrations, deploys staging, runs the staging smoke check, and then deploys production, using `scripts/with-secrets.py` as the current procedure in `docs/operations.md` describes. The job also records the active Worker versions for rollback.
5. Have the deploy job write its results, including the deployed commit, the Worker version IDs and any failure, to a status file the Codex user can read. Codex reads the status file to tell members when their change went live, and a builder chat rollback then works through `git revert` and the next deploy.

After this phase, Codex still ships every hour, but no conversation can make Codex read or print a deployment credential, because the Codex user cannot open the credentials file.

## Testing and acceptance criteria

All of these checks run locally. There is no separate staging verification for builder chat. The feature is ready for its first allowlisted member when all of these pass:

- API tests show that non-allowlisted members, members without a current disclosure acceptance, and all members during a pause cannot open a socket or send a message, and that non-allowlisted members receive `404`.
- API tests cover the rate limits, the single in-flight message rule, the queue limit and the 2,000 character limit.
- Relay tests with a fake bridge show first-in, first-out ordering, streaming to every open socket of the right member and to no other member, reconnection after a bridge disconnect, and the 10 minute timeout.
- Bridge tests show that raw command output, environment variables and text matching `scripts/check-secrets.py` patterns are never forwarded, and that a held back reply creates an audit entry.
- Deletion tests show that account deletion removes builder chat rows, and export tests show that the member's own export includes them.
- Rollback tests against a scratch checkout show that Codex reverts a builder chat change when asked and that `scripts/builder-chat-rollback.ts` reverts the commits recorded for a message.
- A local end to end run, using the local development setup, `wrangler dev` for the relay and a real local Codex session working in a scratch checkout, shows a full conversation with two synthetic allowlisted accounts, a queued second member, a pause, and a removal of access while connected.
- The web page passes the existing keyboard and screen reader checks in `scripts/local-accessibility.ts`, including announcements of streamed replies through a polite live region.

## Build and rollout plan

1. Nick builds the whole feature locally: the migration, allowlist command, API routes, relay, web page, staff view, bridge program, rollback recording and rollback command, and the privacy and disclosure text. The bridge is developed against a real local Codex session working in a scratch checkout, never against the builder session.
2. Nick merges the feature to `main` switched off, with the pause on and the allowlist empty. The hourly deploy on the Mac mini ships it, including migration 048 and the new Durable Object binding.
3. Bobby installs the bridge on the Mac mini, points it at the builder session, adds the shared lock file to the request-file loop, confirms `codex app-server` works on his Codex version, and uploads `BUILDER_BRIDGE_TOKEN`.
4. An operator turns off the pause and adds the first member to the allowlist on production.
5. Later, Bobby sets up the separate Codex user and deploy job described in [Later phase](#later-phase-separate-codex-from-deploy-credentials).

## Decisions and open questions

Bobby has agreed to run the bridge on his Mac mini and to the shared lock file between builder chat turns and Nick's request file.

One question remains open. Codex `0.164.0`, installed on Nick's machine, includes `codex app-server`, marked experimental, so the bridge can be built against it locally. Bobby needs to confirm that the Codex version on the Mac mini supports driving an existing session the same way. If it does not, the fallback is to have the bridge write member messages into a second request file that the builder session reads. The fallback removes live streaming of progress but keeps the rest of this design.
