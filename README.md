# Telegram Chat Summarizer

Telegram group bot that stores incoming group messages in a local SQLite database and lets anyone in the group ask Kimi K2.6 Turbo for a summary of recent topics.

Bot: [@chad_summary_bot](https://t.me/chad_summary_bot)

## What It Does

- Stores incoming text, captions, and basic media placeholders separately per Telegram group.
- Lets any group member run `/summary`, `/summary 24h`, `/summary 7d`, or `/summary 100`.
- Uses Kimi K2.6 Turbo through Fireworks for concise summaries.
- Keeps secrets in environment variables, not in git.

Important Telegram limitation: bots can only store messages they receive after being added. The bot needs permission to receive normal group messages.

## Telegram Setup

1. Create or configure the Telegram bot.
2. Allow it to receive normal group messages.
3. Add the bot to a group.
4. Send `/start` or `/help` in the group.
5. After some chat happens, run `/summary` or `/summary 24h`.

## Environment

Copy `.env.example` to `.env` locally, or set these variables in Easypanel:

- `TELEGRAM_BOT_TOKEN`
- `FIREWORKS_API_KEY`
- `FIREWORKS_BASE_URL`
- `FIREWORKS_MODEL`
- `DATABASE_PATH`
- `SUMMARY_DEFAULT_MESSAGES`
- `SUMMARY_MAX_MESSAGES`
- `AI_TEMPERATURE`
- `AI_MAX_TOKENS`

Use a persistent volume for `DATABASE_PATH`, for example `/app/data/chat-summaries.sqlite`.

## Deployment

Use Nixpacks on Hetzner Easypanel. Set the env vars above in Easypanel and mount a persistent data volume at `/app/data`.

## Development

```bash
bun install
bun test
bun run typecheck
bun run start
```
