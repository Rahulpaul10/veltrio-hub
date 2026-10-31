/** Turns wallet and RPC failures into plain messages and a safe-to-retry flag. */

export type TxErrorKind =
  | 'rejected'
  | 'insufficient_funds'
  | 'wrong_chain'
  | 'underpriced'
  | 'reverted'
  | 'network'
  | 'unknown'

export interface ClassifiedError {
  kind: TxErrorKind
  message: string
  /**
   * True only when we are certain nothing was broadcast. For `network` and `unknown`
   * failures the wallet may already have submitted the transaction, so the UI must
   * ask the user to check before sending again.
   */
  definitelyNotSent: boolean
}

function collectText(error: unknown): { text: string; codes: number[] } {
  const parts: string[] = []
  const codes: number[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth++) {
    seen.add(current)
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (typeof current !== 'object') break
    const record = current as Record<string, unknown>
    for (const key of ['name', 'message', 'shortMessage', 'details', 'reason']) {
      if (typeof record[key] === 'string') parts.push(record[key])
    }
    if (typeof record.code === 'number') codes.push(record.code)
    if (typeof record.code === 'string') parts.push(record.code)
    current = record.cause ?? record.error
  }
  return { text: parts.join(' | ').toLowerCase(), codes }
}

export function isUserRejection(error: unknown): boolean {
  const { text, codes } = collectText(error)
  return (
    codes.includes(4001) ||
    /user rejected|user denied|rejected the request|request rejected|action_rejected|userrejectedrequest|denied transaction/.test(text)
  )
}

export function classifyTxError(error: unknown): ClassifiedError {
  if (isUserRejection(error)) {
    return { kind: 'rejected', message: 'You declined the request in your wallet. Nothing was sent.', definitelyNotSent: true }
  }
  const { text, codes } = collectText(error)

  if (/chain mismatch|chainmismatch|does not match the target chain|unrecognized chain|wrong network/.test(text) || codes.includes(4902)) {
    return {
      kind: 'wrong_chain',
      message: 'Your wallet is not on Arc Mainnet. Switch network and try again.',
      definitelyNotSent: true,
    }
  }
  if (/insufficient funds|exceeds balance|insufficient balance|transfer amount exceeds/.test(text)) {
    return {
      kind: 'insufficient_funds',
      message: 'Not enough USDC to cover the amount and the network fee. Nothing was sent.',
      definitelyNotSent: true,
    }
  }
  if (/underpriced|fee too low|max fee per gas less than block base fee|replacement transaction/.test(text)) {
    return {
      kind: 'underpriced',
      message: 'The network fee was too low for Arc. Nothing was sent. Try again to get a fresh fee estimate.',
      definitelyNotSent: true,
    }
  }
  // viem labels an "Internal JSON-RPC error" from the wallet as a contract revert. It is not: the wallet
  // may or may not have broadcast the transaction, so it must be treated as ambiguous.
  const ambiguousInternal = /internal json-rpc error|an internal error was received|internal error/.test(text)
  if (!ambiguousInternal && /revert|blocklist|blocked/.test(text)) {
    return {
      kind: 'reverted',
      message: 'The transfer would fail on Arc. The sender or recipient may be restricted.',
      definitelyNotSent: true,
    }
  }
  if (!ambiguousInternal && /timeout|timed out|network|failed to fetch|fetch failed|http request failed|disconnected|econn|socket|rate limit|429|503|502/.test(text)) {
    return {
      kind: 'network',
      message: 'The network did not respond. Your transfer may or may not have been submitted. Check Activity and your wallet before trying again.',
      definitelyNotSent: false,
    }
  }
  return {
    kind: 'unknown',
    message: 'Something went wrong. Your transfer may or may not have been submitted. Check Activity and your wallet before trying again.',
    definitelyNotSent: false,
  }
}

/** Short, user-facing message for a failed read (balance, history, fee). */
export function describeReadError(error: unknown): string {
  const { text } = collectText(error)
  if (/429|rate limit|too many requests/.test(text)) return 'The RPC is rate limiting requests. Please wait a moment and retry.'
  if (/timeout|timed out/.test(text)) return 'The RPC request timed out.'
  if (/failed to fetch|fetch failed|network|http request failed|econn|socket/.test(text)) {
    return 'Could not reach the Arc RPC. Check your connection.'
  }
  return 'The Arc RPC returned an error.'
}
