import type { Hex } from 'viem'

/**
 * State machine for a single transfer. Every state is something we actually know:
 * "confirmed" is only reachable from a successful on-chain receipt.
 */
export type SendState =
  | { step: 'form' }
  | { step: 'review' }
  | { step: 'preparing' }
  | { step: 'awaiting_wallet' }
  | { step: 'pending'; hash: Hex; slow: boolean }
  | { step: 'confirmed'; hash: Hex; blockNumber: bigint }
  | { step: 'failed'; hash: Hex; blockNumber?: bigint }
  | { step: 'unverified'; hash: Hex; blockNumber?: bigint }
  | { step: 'rejected' }
  | { step: 'error'; message: string; definitelyNotSent: boolean }

export type SendAction =
  | { type: 'review' }
  | { type: 'back' }
  | { type: 'submit' }
  | { type: 'prepare' }
  | { type: 'prepared' }
  | { type: 'rejected' }
  | { type: 'submitted'; hash: Hex }
  | { type: 'slow' }
  | { type: 'confirmed'; blockNumber: bigint }
  | { type: 'reverted'; blockNumber?: bigint }
  | { type: 'unverified'; blockNumber?: bigint }
  | { type: 'error'; message: string; definitelyNotSent: boolean }
  | { type: 'reset' }

export const initialSendState: SendState = { step: 'form' }

/** True while a wallet prompt or an unconfirmed transaction exists: the form must not be submitted again. */
export function isSendBusy(state: SendState): boolean {
  return state.step === 'preparing' || state.step === 'awaiting_wallet' || state.step === 'pending'
}

export function sendReducer(state: SendState, action: SendAction): SendState {
  switch (action.type) {
    case 'review':
      // After an ambiguous failure the transfer may already be on its way, so there is no way back to review.
      if (state.step === 'error') return state.definitelyNotSent ? { step: 'review' } : state
      return state.step === 'form' || state.step === 'rejected' ? { step: 'review' } : state
    case 'back':
      return state.step === 'review' ? { step: 'form' } : state
    case 'submit':
      // Only one submission per review. A second click while the wallet is open is ignored.
      return state.step === 'review' ? { step: 'awaiting_wallet' } : state
    case 'prepare':
      // Stale fee or balance data: re-read it before the wallet is opened.
      return state.step === 'review' ? { step: 'preparing' } : state
    case 'prepared':
      return state.step === 'preparing' ? { step: 'awaiting_wallet' } : state
    case 'rejected':
      return state.step === 'awaiting_wallet' ? { step: 'rejected' } : state
    case 'submitted':
      return state.step === 'awaiting_wallet' ? { step: 'pending', hash: action.hash, slow: false } : state
    case 'slow':
      return state.step === 'pending' ? { ...state, slow: true } : state
    case 'confirmed':
      return state.step === 'pending' ? { step: 'confirmed', hash: state.hash, blockNumber: action.blockNumber } : state
    case 'reverted':
      return state.step === 'pending' ? { step: 'failed', hash: state.hash, blockNumber: action.blockNumber } : state
    case 'unverified':
      return state.step === 'pending' ? { step: 'unverified', hash: state.hash, blockNumber: action.blockNumber } : state
    case 'error':
      return state.step === 'awaiting_wallet' || state.step === 'preparing'
        ? { step: 'error', message: action.message, definitelyNotSent: action.definitelyNotSent }
        : state
    case 'reset':
      return initialSendState
    default:
      return state
  }
}
