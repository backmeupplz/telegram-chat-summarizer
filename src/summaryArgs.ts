export type SummaryWindow = {
  label: string
  limit: number
  sinceUnixSeconds?: number
}

const durationPattern = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i

export function resolveSummaryWindow(
  input: string | undefined,
  nowUnixSeconds: number,
  defaults: { defaultMessages: number; maxMessages: number }
): SummaryWindow {
  const raw = input?.trim().toLowerCase()

  if (!raw) {
    return {
      label: `latest ${defaults.defaultMessages} messages`,
      limit: defaults.defaultMessages,
    }
  }

  const countMatch = raw.match(/^(\d+)\s*(messages?|msgs?)?$/i)
  if (countMatch) {
    const requested = Number(countMatch[1])
    const limit = clampMessageLimit(requested, defaults.maxMessages)
    return {
      label: `latest ${limit} messages`,
      limit,
    }
  }

  const durationMatch = raw.match(durationPattern)
  if (!durationMatch) {
    return {
      label: `latest ${defaults.defaultMessages} messages`,
      limit: defaults.defaultMessages,
    }
  }

  const amount = Number(durationMatch[1])
  const unit = durationMatch[2].toLowerCase()
  const secondsByUnit =
    unit.startsWith('m') ? 60 :
    unit.startsWith('h') ? 60 * 60 :
    unit.startsWith('d') ? 24 * 60 * 60 :
    7 * 24 * 60 * 60
  const seconds = amount * secondsByUnit

  return {
    label: `last ${amount}${shortUnit(unit)}`,
    limit: defaults.maxMessages,
    sinceUnixSeconds: nowUnixSeconds - seconds,
  }
}

function clampMessageLimit(requested: number, maxMessages: number) {
  if (!Number.isFinite(requested) || requested < 1) {
    return 1
  }
  return Math.min(Math.floor(requested), maxMessages)
}

function shortUnit(unit: string) {
  if (unit.startsWith('m')) return 'm'
  if (unit.startsWith('h')) return 'h'
  if (unit.startsWith('d')) return 'd'
  return 'w'
}
