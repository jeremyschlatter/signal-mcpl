# signal-mcpl

An [MCPL](https://github.com/anima-research/mcpl) server bridging Signal via the
`signal-cli` daemon (HTTP JSON-RPC + SSE).

Exposes Signal DMs and group chats as MCPL channels, plus `signal_send` and
`signal_react` tools.

| Conversation | Channel id             | Tags                                       |
| ------------ | ---------------------- | ------------------------------------------ |
| DM           | `signal:dm:<uuid>`     | `chat:dm`, `chat:addressed`, `chat:from-human` |
| Group        | `signal:group:<gid>`   | `chat:ambient`, `chat:from-human`          |
| Reaction     | *(either)*             | `chat:reaction`, `chat:ambient`, `chat:from-human` |

The `chat:addressed` / `chat:ambient` split is the useful part for a host: DMs
are addressed to the agent and generally warrant waking it; group traffic is
ambient and can be archived for continuity without spending inference on every
message.

## Requirements

- Node >= 20
- A running [`signal-cli`](https://github.com/AsamK/signal-cli) daemon with the
  HTTP JSON-RPC + SSE interface enabled

## Usage

    signal-mcpl --stdio

## Configuration

All configuration is via environment variables. Nothing is hardcoded.

| Variable                   | Default                                          | Purpose |
| -------------------------- | ------------------------------------------------ | ------- |
| `SIGNAL_DAEMON_URL`        | `http://127.0.0.1:8090`                          | signal-cli daemon base URL |
| `SIGNAL_ACCOUNT`           | *(unset)*                                        | Your own E.164 number; used to detect reactions to your own messages |
| `SIGNAL_SELF_UUID`         | *(unset)*                                        | Your own account UUID, same purpose |
| `SIGNAL_DM_USERS`          | *(unset — open)*                                 | Comma-separated allowlist of UUIDs/numbers. **Unset means no filtering.** |
| `SIGNAL_CONTACTS_FILE`     | *(unset)*                                        | JSON file persisting the uuid/group -> display-name map |
| `SIGNAL_ATTACH_DIR`        | `$HOME/.local/share/signal-cli/attachments`      | Where signal-cli writes attachments |
| `SIGNAL_ATTACH_MAX_BYTES`  | `4000000`                                        | Max image size bridged as base64 |
| `SIGNAL_DEBUG_LOG`         | *(unset — off)*                                  | Append-only JSONL debug log |

## Notes

- Markdown bold/italic/strikethrough/code is converted to Signal text styles
  (BodyRange); headers, links and lists pass through as plain text.
- Image attachments under `SIGNAL_ATTACH_MAX_BYTES` are bridged as base64 image
  blocks; anything else becomes a text note.
- Author and group name are embedded in the message text, not just metadata,
  because hosts commonly render only the text — bare text would otherwise arrive
  anonymous.
- Read receipts are sent for delivered messages.
