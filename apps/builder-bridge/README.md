# Builder chat bridge

The bridge is a small program that runs on the Mac mini next to the Codex session that builds Porchday. It connects builder chat on porchday.org to that Codex session. Every few seconds the bridge asks the Porchday API whether an allowlisted member has sent a message. When there is one, the bridge runs the message as a turn in the builder session with `codex exec resume`, sends Codex's written replies back to the member while Codex works, and records the commits Codex made so the change can be rolled back.

The bridge only makes outbound HTTPS requests to porchday.org, so the Mac mini needs no open port. It forwards Codex's own messages and a short progress label such as "Running tests". It never forwards commands, command output, diffs, file contents or Codex's reasoning, and it replaces any paragraph that looks like a credential with "Part of Codex's reply was held back." The full design is in [design/builder-chat.md](../../design/builder-chat.md).

This guide is for the person who installs the bridge on the Mac mini (Bobby). It takes about 20 minutes.

## How builder chat ships

Builder chat ships switched off. The code reaches production through the normal hourly deploy with the pause on (`BUILDER_CHAT_PAUSED=true`) and an empty allowlist, so no member sees it. It is turned on in these steps:

1. The hourly deploy ships the code and migration `050_builder_chat.sql`. Nothing is visible yet.
2. Bobby installs the bridge with this guide.
3. An operator turns off the pause and adds the first member, as described in [Turning builder chat on](#turning-builder-chat-on).

## What you need

- The Mac mini user that runs the Codex builder session. The bridge runs as the same user, so it can use that user's Codex sign-in and git identity.
- Node.js 22.18 or newer (`node --version`). The bridge has no dependencies and runs its TypeScript files directly.
- Codex CLI with `codex exec resume`. Check with `codex exec resume --help`. Version 0.164.0 has it.
- The checkout of `porchday/porchday` that the builder session works in, updated to a commit that includes `apps/builder-bridge`.
- The deployment credentials file `~/.config/inner-circle/secrets.env`, to upload the bridge token to Cloudflare.

## Step 1. Check how the builder session runs

The bridge sends each member message into the builder session as a new turn, using `codex exec resume <session>`. Each turn starts a short-lived Codex process that loads the session history, runs the turn, saves it and exits. Nick's requests from `~/nick-requests.txt` must go through the same session one at a time, so both use the shared lock file `~/.porchday-builder.lock`.

This is a saved-session bridge, not a live connection to an open Codex desktop chat. Before enabling members, verify the chosen workflow with a harmless message and confirm that both the member reply and the resumed builder session contain the turn. Do not treat a successful `check` command as proof of desktop synchronization.

Before you install, check which of these describes the builder session today:

- **Codex runs each request as a separate turn** (for example, a script that runs `codex exec resume` for each new line in `~/nick-requests.txt`). This works with the bridge as it is. Wrap that script's Codex call in the lock as described in [Step 6](#step-6-add-the-lock-to-the-request-file-loop).
- **A Codex window stays open and checks the request file by itself.** In this case the open window keeps the conversation in memory, and it doesn't see turns that the bridge adds to the same session until the window is restarted. The builder chat turns still run, commit and reply correctly, but the open window won't remember them. Either restart the open window with `codex resume <session>` after builder chat turns, or switch the request-file loop to separate `codex exec resume` turns. Tell Nick which setup you have, because it decides whether the open window can keep running as it does now.

## Step 2. Find the builder session ID

The bridge needs the ID of the builder session. Use one of these:

- In the open Codex window, type `/status`. The session ID is shown there.
- Or list the newest session files. The ID is the UUID at the end of each file name.

  ```sh
  ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -5
  ```

Write the ID down. It looks like `01a17bc7-2f4d-7531-8d9b-7a691c61cf36`.

## Step 3. Create the bridge token

The token lets the bridge, and only the bridge, call `https://porchday.org/api/builder-bridge`. It is stored in one file on the Mac mini and as the `BUILDER_BRIDGE_TOKEN` secret of the production Worker.

```sh
mkdir -p ~/.config/porchday-builder-bridge
chmod 700 ~/.config/porchday-builder-bridge
( umask 077; openssl rand -base64 48 | tr -d '\n' > ~/.config/porchday-builder-bridge/token )
```

Don't print the token or paste it anywhere else.

## Step 4. Upload the token to the production Worker

Run this from the Porchday checkout. It reads the token from the file through standard input, so the value never appears on screen or in the shell history.

```sh
python3 scripts/configure-worker.py production
python3 scripts/with-secrets.py npx wrangler secret put BUILDER_BRIDGE_TOKEN \
  --config apps/api/wrangler.production.jsonc < ~/.config/porchday-builder-bridge/token
```

Uploading a secret creates a new Worker version with the same code, so it doesn't change the site. The secret stays in place across later deploys and `upload-worker-secrets.py` runs. To rotate the token later, repeat steps 3 and 4 and restart the bridge.

The bridge serves production only. Don't upload the token to staging unless you also run a second bridge for staging.

## Step 5. Write the bridge settings

Create `~/.config/porchday-builder-bridge/config.json` with your values:

```json
{
  "api_url": "https://porchday.org",
  "token_file": "~/.config/porchday-builder-bridge/token",
  "codex_session": "01a17bc7-2f4d-7531-8d9b-7a691c61cf36",
  "repo_dir": "~/path/to/the/builder/checkout",
  "lock_file": "~/.porchday-builder.lock",
  "codex_command": "codex",
  "codex_args": []
}
```

| Setting | Meaning |
| --- | --- |
| `api_url` | The Porchday origin. Use `https://porchday.org`. |
| `token_file` | The token file from step 3. It must have mode 600. |
| `codex_session` | The builder session ID from step 2. |
| `repo_dir` | The checkout the builder session works in. The bridge runs Codex there and reads its git history to record commits. |
| `lock_file` | The shared lock. Keep the default unless the request-file loop uses another path. |
| `codex_command` | The Codex program. Use a full path, such as `/opt/homebrew/bin/codex`, if `codex` isn't on launchd's `PATH`. |
| `codex_args` | Extra Codex options placed before the session ID. Use the same sandbox and approval options the builder session already uses, for example `["--dangerously-bypass-approvals-and-sandbox"]` if it runs with full access, so builder chat turns can commit and push like the builder's other turns. |
| `poll_seconds` | Optional. How often the bridge asks for work. The default is 3. |

Make sure the checkout has a git identity, because the bridge uses it to tell Codex's commits apart from commits pulled from other people:

```sh
git -C ~/path/to/the/builder/checkout config user.email
```

Then check everything:

```sh
node apps/builder-bridge/src/main.ts check
```

Every line should start with `ok`. The API line should say `production, builder chat paused` until an operator turns it on. If a line starts with `FAIL`, it says what to fix. A `401` from the API means the token file and the uploaded secret differ. A `404` means the secret isn't uploaded yet or the deployed Worker is older than builder chat.

## Step 6. Add the lock to the request-file loop

Builder chat turns and Nick's file requests must never run at the same time in the builder session. The bridge takes `~/.porchday-builder.lock` before each turn. The request-file loop must take the same lock before it starts work on a request and release it afterwards. Use the helper in this folder:

```sh
apps/builder-bridge/builder-lock.sh acquire --wait request-file   # waits until the lock is free
# ... work on the request ...
apps/builder-bridge/builder-lock.sh release request-file
```

`AGENTS.md` already tells Codex to do this for requests from `~/nick-requests.txt`, so a builder session that reads `AGENTS.md` follows it on its next request. If the loop is a script, add the two lines around its Codex call instead.

`builder-lock.sh status` shows who holds the lock. A lock left behind by the request-file loop expires after one hour. A lock left behind by the bridge is released as soon as the bridge process is gone.

## Step 7. Install the bridge as a launchd agent

launchd starts the bridge when Bobby's user logs in and restarts it if it stops. Copy the template and replace the three placeholders:

```sh
CHECKOUT=~/path/to/the/builder/checkout
sed -e "s#NODE_PATH#$(command -v node)#" -e "s#CHECKOUT#$(cd "$CHECKOUT" && pwd)#g" -e "s#HOME_DIR#$HOME#g" \
  "$CHECKOUT/apps/builder-bridge/com.porchday.builder-bridge.plist" > ~/Library/LaunchAgents/com.porchday.builder-bridge.plist
plutil -lint ~/Library/LaunchAgents/com.porchday.builder-bridge.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.porchday.builder-bridge.plist
```

If `codex` or `git` live somewhere other than `/opt/homebrew/bin`, `/usr/local/bin` or `/usr/bin`, add that folder to the `PATH` entry in the installed plist.

Check that the bridge is running:

```sh
launchctl print gui/$(id -u)/com.porchday.builder-bridge | grep -E 'state|pid'
tail -f ~/Library/Logs/porchday-builder-bridge.log
```

The log should show `bridge started for https://porchday.org` and then `state paused`. The log records message IDs, statuses and commit hashes only, never message text.

## Turning builder chat on

An operator with deployment access does this after the bridge reports `state paused`.

1. Set `"builder_chat_paused": false` under `environments.production` in `infra/resources.json`, commit the change, and deploy as usual. The bridge log changes to `state idle`.
2. Add the first member. The member must already have a Porchday account.

   ```sh
   python3 scripts/with-secrets.py node scripts/builder-chat-access.ts add <handle>
   python3 scripts/with-secrets.py node scripts/builder-chat-access.ts list
   ```

   Select the production migration database URL in `DATABASE_MIGRATION_URL` first, the same way as for `scripts/invite.ts`.
3. The member signs in, opens **Builder chat** in the sidebar, accepts the notice and sends a first message. The bridge log shows `turn <message ID> started` and then `answered`.

## Day-to-day operation

| Task | How |
| --- | --- |
| Pause builder chat | Set `builder_chat_paused` to `true` in `infra/resources.json` and deploy. A turn already running finishes; no new turn starts. For an immediate stop on the Mac mini, run `launchctl bootout gui/$(id -u)/com.porchday.builder-bridge`. |
| Remove a member | `node scripts/builder-chat-access.ts remove <handle>` with production database access. The member loses access on their next request, and their queued message is cancelled. |
| Undo a builder chat change | Ask Codex in builder chat to undo it, or run `node scripts/builder-chat-rollback.ts <message ID>` in a clean checkout, run the tests, then push. The message ID and commit hashes are in the staff view and in the bridge log. See [docs/incident-response.md](../../docs/incident-response.md#builder-chat). |
| See all conversations | The staff console at `/staff` shows a read-only builder chat view to staff with the `builder_chat` role. |
| Restart the bridge | `launchctl kickstart -k gui/$(id -u)/com.porchday.builder-bridge`. A running turn finishes before the old process exits. |
| Update the bridge | Pull the checkout, then restart the bridge. |
| Uninstall | `launchctl bootout gui/$(id -u)/com.porchday.builder-bridge`, delete the plist and `~/.config/porchday-builder-bridge`, and run `npx wrangler secret delete BUILDER_BRIDGE_TOKEN --config apps/api/wrangler.production.jsonc` through `with-secrets.py`. |

## How a turn works

1. The bridge takes the shared lock. If the request-file loop holds it, the bridge only tells the API it is still connected and tries again a few seconds later, so members see "Waiting for Codex" instead of "offline".
2. The bridge claims the oldest queued message and records the current `HEAD` of the checkout.
3. The bridge runs `codex exec resume <codex_args> --json <session> -` in the checkout, with the framed message on standard input. The frame names the member and the message ID and asks Codex to follow the "Builder chat turns" rules in `AGENTS.md`, including the `Builder-Chat-Message: <message ID>` commit trailer.
4. While Codex works, the bridge keeps its heartbeat alive even during commands that produce no events. Only one progress or heartbeat request can be in flight at a time. The bridge sends Codex's written messages and a progress label to the API at most every 1.5 seconds. If the member loses access during the turn, the bridge stops sending, but Codex finishes the turn so the checkout is never left half edited.
   Replies are filtered for credentials before being shortened to fit the API character and encoded-byte limits. Shortened replies include an explicit truncation notice; completion status, timeout explanations and commit records are retained.
5. After 10 minutes the bridge interrupts Codex, tells the member that Codex ran out of time, and tells Codex at the start of the next turn to check `git status` first.
6. The bridge records the commits made during the turn. These are the commits with the message trailer, plus commits made with the checkout's own git identity, so commits pulled from other people during the turn aren't counted. Then it releases the lock.

If the bridge stops in the middle of a turn, the server marks the message as timed out 12 minutes after the turn started, so no member waits forever.

## Queue status

Migration `051_builder_queue_status.sql` adds fixed activity labels to the member status. The page shows whether the bridge is waiting for a request-file task, another builder task, or another chat message, plus the member’s own chat-queue position and elapsed waiting time. It does not expose other members’ messages or estimate completion times. Deploy migration 051 and the API before restarting an updated bridge. Older bridge payloads remain accepted and report a generic builder task while locked.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `FAIL ... must not be readable by other users` | `chmod 600 ~/.config/porchday-builder-bridge/token` |
| `401 ... the bridge token does not match` | The token file and the Worker secret differ. Repeat step 4 with the current token file. |
| `404 ... BUILDER_BRIDGE_TOKEN is not set` | Upload the token (step 4), or wait for the hourly deploy to ship builder chat. |
| The log repeats `state locked` for a long time | `apps/builder-bridge/builder-lock.sh status` shows the holder. If the request-file loop crashed while holding it, run `builder-lock.sh release request-file`. |
| Members see "Codex is offline" | The bridge hasn't reached the API in 30 seconds. Check `launchctl print` and the log. |
| `Codex could not start` in the log | `codex_command` isn't on launchd's `PATH`. Use the full path in `config.json`. |
| Turns fail right away | Run the same command by hand in the checkout: `echo 'Reply with OK.' \| codex exec resume --json <session> -`. Fix any sign-in or session error it prints. |

## Development

Run the bridge tests with `npx vitest run apps/builder-bridge` from the repository root, and the type check with `npm run typecheck -w @porchday/builder-bridge`. For a local run against a development API, point `api_url` at `http://127.0.0.1:8787`, use a scratch checkout for `repo_dir`, and start a scratch session with `codex exec --json "Reply READY"` in that checkout. Never point a development bridge at the real builder session.
