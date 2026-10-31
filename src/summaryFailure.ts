import { GrammyError, HttpError } from 'grammy'
import { SummaryLlmError } from './ai'

// A short, non-secret reason for the chat, so a failed /summary can be triaged
// without the bot logs. Provider response bodies stay in the logs only.
export function summaryFailureMessage(error: unknown) {
  if (error instanceof SummaryLlmError) {
    if (error.kind === 'empty') {
      return 'Summary failed: the AI model returned no usable answer several times. Please try again in a minute.'
    }
    if (error.status === 429) {
      return 'Summary failed: the AI provider is rate limiting requests. Please try again in a few minutes.'
    }
    return (
      'Summary failed: the AI provider returned an error' +
      (error.status ? ` (HTTP ${error.status})` : '') +
      '. Please try again later.'
    )
  }
  if (error instanceof GrammyError || error instanceof HttpError) {
    return 'Summary failed because of a Telegram error. Please try again.'
  }
  return 'Summary failed because of an unexpected error. Check the bot logs.'
}
