import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  FIREWORKS_API_KEY: z.string().min(1, 'FIREWORKS_API_KEY is required'),
  FIREWORKS_BASE_URL: z
    .string()
    .url()
    .default('https://api.fireworks.ai/inference/v1'),
  FIREWORKS_MODEL: z
    .string()
    .min(1)
    .default('accounts/fireworks/routers/kimi-k2p6-turbo'),
  DATABASE_PATH: z.string().min(1).default('./data/chat-summaries.sqlite'),
  SUMMARY_DEFAULT_MESSAGES: z.coerce.number().int().positive().default(200),
  SUMMARY_MAX_MESSAGES: z.coerce.number().int().positive().default(500),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.35),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(1800),
  AI_REASONING_EFFORT: z
    .enum(['none', 'low', 'medium', 'high', 'max'])
    .default('none'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n')
  throw new Error(`Configuration validation failed:\n${issues}`)
}

export const config = parsed.data

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true })
