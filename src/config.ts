import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  LLM_API_KEY: z.string().min(1, 'LLM_API_KEY is required'),
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL: z.string().min(1),
  DATABASE_PATH: z.string().min(1).default('./data/chat-summaries.sqlite'),
  SUMMARY_DEFAULT_MESSAGES: z.coerce.number().int().positive().default(200),
  SUMMARY_MAX_MESSAGES: z.coerce.number().int().positive().default(500),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.35),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(1800),
  DISABLE_REASONING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
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
