<p align="center">
  <img src="docs/images/logo.png" alt="Alicia Tracker logo" width="140">
</p>

<h1 align="center">Alicia Tracker</h1>

<p align="center">
  <strong>Discord-first Roblox presence tracking with per-user storage that stays readable.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#storage">Storage</a> ·
  <a href="#deployment">Deploy</a>
</p>

## The short version

| Default | Value |
| --- | ---: |
| Discord servers | 1 |
| Tracked users | 50 |
| Files per user | 5 |
| History and error retention | Unlimited |

Alicia Tracker watches Roblox presence, sends Discord alerts, groups players by server instance, and stores every tracked user in a separate folder. It is built for one configured Discord server and does not require a database.

## Why use it?

- **Readable by user:** profile, status, history, games, and errors stay isolated per Roblox username.
- **Safe during imports:** full writes are staged, backed up, and recovered after interruption.
- **Fast on large histories:** logs load lazily and rotate into unlimited JSONL segments.
- **Useful at 50 users:** live boards support focused views for in-game, online, offline, paused, and problem states.
- **Simple to operate:** Discord slash commands handle configuration; no web dashboard is required.

## Quick start

### 1. Requirements

- Node.js 18 or newer
- A Discord application with the `bot` and `applications.commands` scopes
- Access to the target guild, alert channels, and server members

### 2. Install

```bash
npm install
```

### 3. Configure

Create a private `.env` file:

```dotenv
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-discord-guild-id
PORT=3000
HOST=127.0.0.1
LOG_ACCESS_TOKEN=choose-a-long-random-log-token
```

Never commit `.env`, cookies, `data/`, backups, or logs.

### 4. Start

```bash
npm start
```

The first startup creates the storage layout automatically. Legacy `state.json` and `guilds.json` migrations create a backup before conversion.

### 5. Configure Discord

Run these commands in the target server:

```text
/setup
/notify channel
/cookie add
/track add
```

Use `/track usernotify` when one user needs a dedicated alert channel.

## Commands

### Presence

| Command | Result |
| --- | --- |
| `/track add` | Track a Roblox username |
| `/track list` | List tracked users and linked accounts |
| `/track pause` / `/track resume` | Stop or resume polling for one user |
| `/track info` | Show profile, account, channel, and effective alerts |
| `/status <username>` | Show one user's latest presence |
| `/board` | Show the filtered live board |
| `/together` | Group users currently in the same server instance |
| `/poll now` | Run an immediate tracker poll |

### Alerts

| Command | Result |
| --- | --- |
| `/notify channel` | Set the default alert channel |
| `/track usernotify` | Route one user to a dedicated channel |
| `/track usernotify-clear` | Return one user to the default channel |
| `/track alerts` | Override one alert type for one user |
| `/track alerts-reset` | Restore server-default alert behavior |
| `/notify test` | Send a safe test notification |

### Diagnostics and data

| Command | Result |
| --- | --- |
| `/tracker inspect` | Show detailed live state for one user |
| `/stats <username>` | Summarize events and linked-account state |
| `/history <username>` | Read a user's recent history tail |
| `/topgames <username>` | Summarize playtime from complete history |
| `/health` | Show Roblox API and tracker health |
| `/export` | Download a complete private JSON backup |
| `/import` | Validate and transactionally restore a backup |

Sensitive or mutating commands require **Manage Server**.

## Filtered live board

```text
/board view:all
/board view:ingame
/board view:online
/board view:offline
/board view:paused
/board view:issues
```

- `paused` never displays stale presence as current.
- `issues` includes unresolved users, missing snapshots, and account failures.
- One board command performs at most one tracker poll.
- Long names and rows are escaped and split across valid Discord embeds.

## Alert inheritance

Server settings are defaults. A user only stores an alert value when they intentionally override it.

```text
/settings notifications type:Game Leave enabled:false
/track alerts username:ExampleUser type:Game Leave enabled:true
/track alerts-reset username:ExampleUser type:Game Leave
/track alerts-reset username:ExampleUser
```

- New users inherit every server default.
- `/track info` and `/tracker inspect` show the effective value and whether it comes from the user or server.
- Resetting one type restores only that setting.
- Omitting the type resets every personal override.

## Storage

Alicia Tracker keeps global configuration separate from user data:

```text
data/
  manifest.json
  settings.json
  accounts.json
  users/
    ExampleUser/
      profile.json
      status.json
      history.jsonl
      games.json
      errors.jsonl
  backups/
  removed-users/
  .transactions/
```

<details>
<summary><strong>Storage behavior and safety</strong></summary>

### Lazy loading

- Startup reads the manifest, settings, accounts, and user profiles.
- Status, history, games, and errors load only when accessed.
- Limited history commands read the newest log segments.
- Exports and full statistics read every segment.

### Segmented logs

- Active logs use `history.jsonl` and `errors.jsonl`.
- Files rotate at 5 MiB by default into timestamped archives.
- Segments are never deleted automatically.
- `LOG_SEGMENT_MAX_BYTES` changes the rotation threshold.
- A positive `MAX_HISTORY_PER_USER` enables an optional cap.

### Failure protection

- Missing, malformed, incomplete, or newer storage layouts stop startup instead of being replaced with empty defaults.
- Imports validate users, accounts, IDs, usernames, duplicates, and account references before writing.
- Full writes create a private backup and a staged transaction.
- Interrupted transactions recover on the next startup.
- Failed flushes retry with bounded exponential backoff.
- Removing a user archives their folder under `removed-users/`.

</details>

Storage schema version remains `2`, so 2.5.6 reads 2.5.5 data directly. After log rotation, downgrading to 2.5.5 shows the active tail while older segments remain stored on disk.

## Reliability

- Discord login retries network failures and rate limits.
- Roblox API degradation holds last-known states instead of fabricating offline events.
- Poll failures use bounded backoff and never create mass false transitions.
- Tracker metadata caches are pruned and session timing does not scan complete history.
- Graceful shutdown flushes pending writes.
- The health endpoint reports readiness, poll state, API health, and failure counts.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Required | Discord bot token |
| `DISCORD_GUILD_ID` | Required | Only guild the bot may serve |
| `PORT` | `3000` | Health and protected logs HTTP port |
| `HOST` | `127.0.0.1` | Health server bind address |
| `LOG_ACCESS_TOKEN` | Disabled | Required token for `/logs` |
| `MAX_TRACKERS_PER_GUILD` | `50` | Maximum tracked users |
| `MAX_ACCOUNTS_PER_GUILD` | `25` | Maximum cookie accounts |
| `MAX_HISTORY_PER_USER` | Unlimited | Optional positive history cap |
| `LOG_SEGMENT_MAX_BYTES` | `5242880` | JSONL rotation threshold |
| `STATUS_HEARTBEAT_MS` | `60000` | Unchanged status persistence interval |
| `DISCORD_WEBHOOK_TIMEOUT_MS` | `15000` | Compatibility webhook timeout |

## Deployment

`deploy.bat` uploads code only. It never uploads `.env`, `data/`, backups, cookies, or logs.

<details>
<summary><strong>SFTP deployment commands</strong></summary>

Set private deployment variables:

```bat
set ALICIA_DEPLOY_HOST=your-host
set ALICIA_DEPLOY_USER=your-sftp-user
set ALICIA_DEPLOY_PORT=2022
set ALICIA_DEPLOY_PASSWORD=your-password
```

Verify the host key in `%USERPROFILE%\.ssh\known_hosts`, then run:

```bat
deploy.bat
```

The script refuses unknown or changed SSH host keys.

</details>

## Testing

```bash
npm test
```

The suite covers migration, corruption refusal, transactional imports, segmented history, remove/re-add and rename races, Unicode usernames, alert inheritance, board filtering, status write reduction, and logger redaction.

## Security

- Treat `.ROBLOSECURITY` values as passwords.
- Account cookies remain in `data/accounts.json` with restrictive permissions.
- Error contexts redact cookie, token, password, secret, and authorization fields.
- Commands and embeds never print complete cookies.
- `/logs` returns `404` unless `LOG_ACCESS_TOKEN` is configured and matched.
- The health server binds to `127.0.0.1` by default.
- Rotate credentials immediately if they are exposed.

## Project structure

```text
bot/                 Discord commands and event handling
services/            Storage, tracker, Roblox API, embeds, logging
test/                Native assertion test suite
docs/images/         README logo
server.js            HTTP health host and process lifecycle
LICENSE              MIT license
```

## License

Released under the [MIT License](LICENSE).

Alicia Tracker is intentionally locked to one configured Discord guild. If it joins another guild, it leaves automatically.
