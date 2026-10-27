import {useCallback, useMemo, useState} from 'react';

const PREFIX = 'daytrail.comfort.dismissed.v1:';
/** Personal reminders are deliberately separate from the shared trip document. */
export function useComfortDismissals(scope: string) {
  const key = PREFIX + scope;
  const [revision, setRevision] = useState(0);
  const [memory, setMemory] = useState<Record<string, string[]>>({});
  const dismissed = useMemo(() => {
    if (memory[key]) return new Set<string>(memory[key]);
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return new Set<string>(Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(-300) : []);
    } catch { return new Set<string>(memory[key] || []); }
  }, [key, revision, memory]);
  const dismiss = useCallback((issue: string) => {
    const next = [...new Set([...dismissed, issue])].slice(-300);
    setMemory(previous => ({...previous, [key]: next}));
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Remains dismissed for this session. */ }
    setRevision(value => value + 1);
  }, [key, dismissed]);
  const reset = useCallback(() => {
    setMemory(previous => ({...previous, [key]: []}));
    try { localStorage.removeItem(key); } catch { /* Session fallback. */ }
    setRevision(value => value + 1);
  }, [key]);
  return {dismissed, dismiss, reset};
}

/** Changes under fifteen minutes or a few hundred metres should not repeatedly nag. */
export function reminderKey(kind: string, dayId: string, affected: string[], evidence: unknown): string {
  return JSON.stringify([kind, dayId, [...affected].sort(), evidence]);
}
