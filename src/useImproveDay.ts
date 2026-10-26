import { useCallback, useEffect, useRef, useState } from 'react';
import { eligibility, signature, type ImproveEligibility, type ImproveInput } from './improveDay';
import { ImproveRunError, runImproveDay, type ImproveProposal } from './improveRoutes';

export interface ImproveState {
  phase: 'idle' | 'checking' | 'comparing' | 'verifying' | 'proposal' | 'none' | 'ineligible' | 'error' | 'stale';
  message?: string;
  proposal?: ImproveProposal;
  inputSignature?: string;
  action?: ImproveEligibility['action'];
  canApply?: boolean;
}
interface StoredState extends ImproveState { observedSignature?: string; baseSignature?: string }
export const IMPROVE_REVIEW_MAX_AGE = 10 * 60_000;
export const improveBaseSignature = (input: ImproveInput) => signature({ ...input, hours: {} });

/** The service refresh is allowed; any different live provider update requires a new review. */
export function isImproveProposalCurrent(input: ImproveInput, proposal: ImproveProposal, observedSignature: string, now = Date.now()): boolean {
  const liveSignature = signature(input);
  return now >= proposal.verifiedAt && now - proposal.verifiedAt < IMPROVE_REVIEW_MAX_AGE
    && signature({ ...input, hours: proposal.hours }) === proposal.inputSignature
    && (liveSignature === observedSignature || liveSignature === proposal.inputSignature);
}

/** No requests run until run() is invoked. Closing or editing cancels subsequent work immediately. */
export function useImproveDay(input: ImproveInput, enabled = true) {
  const liveSignature = signature(input);
  const baseSignature = improveBaseSignature(input);
  const latest = useRef({ input, enabled, liveSignature, baseSignature });
  latest.current = { input, enabled, liveSignature, baseSignature };
  const token = useRef(0);
  const [state, setState] = useState<StoredState>({ phase: 'idle' });
  const cancel = useCallback(() => {
    token.current++;
    setState({ phase: 'idle' });
  }, []);
  useEffect(() => {
    if (!enabled) { token.current++; setState({ phase: 'idle' }); return; }
    setState(previous => {
      if (!previous.baseSignature) return previous;
      if (previous.baseSignature !== baseSignature || (previous.proposal && !isImproveProposalCurrent(input, previous.proposal, previous.observedSignature!))) {
        token.current++;
        return { phase: 'stale', message: 'This day or its opening hours changed. Compare again before applying a suggestion.' };
      }
      return previous;
    });
  }, [enabled, baseSignature, liveSignature]); // Input content is represented by these stable signatures.
  useEffect(() => {
    if (!enabled || state.phase !== 'proposal' || !state.proposal) return;
    const timer = window.setTimeout(() => setState({ phase: 'stale', message: 'This comparison is over 10 minutes old. Compare again to refresh routes and hours.' }),
      Math.max(0, state.proposal.verifiedAt + IMPROVE_REVIEW_MAX_AGE - Date.now()));
    return () => window.clearTimeout(timer);
  }, [enabled, state.phase, state.proposal]);
  useEffect(() => () => { token.current++; }, []);
  const run = useCallback(() => {
    if (!latest.current.enabled) return;
    const snapshot = structuredClone(latest.current.input);
    const observedSignature = signature(snapshot);
    const baseline = improveBaseSignature(snapshot);
    const request = ++token.current;
    const current = () => request === token.current && latest.current.enabled && latest.current.baseSignature === baseline;
    setState({ phase: 'checking', observedSignature, baseSignature: baseline });
    void runImproveDay(snapshot, phase => {
      if (current()) setState({ phase, observedSignature, baseSignature: baseline });
    }, current).then(result => {
      if (!current()) return;
      if (result.proposal && !isImproveProposalCurrent(latest.current.input, result.proposal, observedSignature)) {
        setState({ phase: 'stale', message: 'Opening hours changed during this comparison. Compare again to use the latest details.' });
      } else setState({ ...result, observedSignature, baseSignature: baseline });
    }).catch(error => {
      if (!current()) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState({ phase: 'error', message: error instanceof ImproveRunError ? error.message : 'The comparison could not finish. Check your connection and retry.', observedSignature, baseSignature: baseline });
    });
  }, []);
  const isStale = enabled && state.baseSignature && (state.baseSignature !== baseSignature
    || (state.proposal && !isImproveProposalCurrent(input, state.proposal, state.observedSignature!)));
  const allowed = eligibility(input);
  const visible: ImproveState = !enabled ? { phase: 'idle' }
    : isStale ? { phase: 'stale', message: 'This day changed. Compare again before applying a suggestion.' }
      : state.phase === 'idle' && !allowed.ok ? { phase: 'ineligible', message: allowed.reason, action: allowed.action }
        : state;
  const canApply = Boolean(enabled && !isStale && visible.phase === 'proposal' && visible.proposal);
  return { ...visible, canApply, run, cancel };
}
