# Telegram Chat Summarizer

Telegram group bot that stores incoming group messages in a local SQLite database and lets anyone in the group ask a configured OpenAI-compatible LLM for a summary of recent topics.

Bot: [@chad_summary_bot](https://t.me/chad_summary_bot)

## What It Does

- Stores incoming text, captions, and basic media placeholders separately per Telegram group.
- In forum (topic) groups, `/summary` summarizes only the topic it is sent in (General covers non-topic messages).
- Lets any group member run `/summary` for the last 24 hours, or pass a window like `/summary 7d` or `/summary 100`.
- Uses the configured LLM endpoint for concise summaries.
- Streams summaries by editing a plain-text placeholder message.
- Keeps secrets in environment variables, not in git.

Important Telegram limitation: bots can only store messages they receive after being added. The bot needs permission to receive normal group messages.

## Telegram Setup

1. Create or configure the Telegram bot.
2. Allow it to receive normal group messages.
3. Add the bot to a group.
4. Send `/start` or `/help` in the group.
5. After some chat happens, run `/summary`.

## Environment

Copy `.env.example` to `.env` locally, or set these variables in Easypanel:

- `TELEGRAM_BOT_TOKEN`
- `LLM_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `DATABASE_PATH`
- `SUMMARY_DEFAULT_MESSAGES`
- `SUMMARY_MAX_MESSAGES`
- `AI_TEMPERATURE`
- `AI_MAX_TOKENS` (defaults to `1800`; the first attempt's completion budget. Reasoning models spend hidden reasoning out of it, so when an answer is cut off before any visible text (`finish_reason: length`) the bot retries with double the budget, up to 3 attempts and 16000 tokens. Provider errors (429/5xx, network, timeouts) are retried after a short pause that honours `Retry-After` up to 5 s. An attempt is aborted when the stream goes quiet for 60 s (3 min before the first visible text; keepalive comments count as activity) or after 5 min (more for raised budgets), and all attempts together stop after 10 min. If no attempt finishes, the longest answer cut off by the token limit or a timeout is posted with a "(summary cut off)" note; an attempt that used its whole time cap while still writing is posted right away instead of retried.)
- `DISABLE_REASONING` (defaults to `true`; asks OpenRouter to use low reasoning effort and exclude reasoning tokens, while legacy endpoints receive their native disable-thinking flag. Set to `false` to use the selected model's default reasoning behavior.)

Use a persistent volume for `DATABASE_PATH`, for example `/app/data/chat-summaries.sqlite`.

## Deployment

Build the Dockerfile (Bun 1.4.4), as Tugport does on Hetzner. Set the env vars above in the service and mount a persistent data volume at `/app/data`.

## Development

```bash
bun install
bun test
bun run typecheck
bun run start
```
