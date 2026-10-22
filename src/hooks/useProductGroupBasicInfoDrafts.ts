import { useCallback, useRef, useState } from 'react';
import { parseDateInput } from '../lib/closingDateInput';
import { cloudReadPassesEpochBarrier, takeCloudReadToken } from '../providers/cloud/cloudCacheWriteFence';
import { assertProviderBinding, bindProviderMode, ProviderModeChangedError, type ProviderBinding } from '../providers/providerMode';

/**
 * Purchase Records level 1 (list) and level 2 (product detail) share one save rule for
 * 官方結單日 / 發售月份 / 官網網址 (Owner decision 2026-10-21):
 * - typing only changes a local draft (no write);
 * - Blur or Enter validates and saves once; Escape restores the authoritative value;
 * - an unchanged value writes nothing; Enter + Blur of the same edit never saves twice;
 * - a failed save keeps the draft and shows an error (never reported as saved);
 * - a draft started before a Restore epoch barrier is never committed;
 * - a draft whose authoritative value changed elsewhere since it started is not saved on Blur
 *   (the newer value is shown; only an explicit Enter afterwards may replace it).
 * The write itself goes through the page's existing field save (stale guard + saveProductGroups + CAS).
 */
export type BasicInfoField = 'closing_date' | 'release_month' | 'product_url';
export type BasicInfoCommitSource = 'blur' | 'enter';

interface BasicInfoGroupLike { id: string; closing_date?: string | null; release_month?: string | null; product_url?: string | null }
interface Draft { value: string; base: string; readToken: number; conflict: boolean; provider: ProviderBinding; dateAt: Date; dateConfirmation?: boolean }

export const basicInfoDraftKey = (groupId: string, field: BasicInfoField) => `${groupId}|${field}`;

/** Normalized value to store, or null when the input is not complete yet (kept as a draft, never saved). */
export const normalizeBasicInfoInput = (field: BasicInfoField, raw: string, now?: Date): string | null => {
  const trimmed = raw.trim();
  if (field !== 'closing_date') return trimmed;
  if (trimmed === '') return '';
  const parsed = parseDateInput(trimmed, now);
  return parsed.kind === 'valid' ? parsed.value.replace(/-/g, '/') : null;
};

export const basicInfoInputProblem = (field: BasicInfoField, raw: string, now?: Date): 'nonexistent' | 'incomplete' | null => {
  if (field !== 'closing_date' || raw.trim() === '') return null;
  const parsed = parseDateInput(raw, now);
  return parsed.kind === 'valid' ? null : parsed.kind === 'nonexistent' ? 'nonexistent' : 'incomplete';
};
export const basicInfoSavePreview = (field: BasicInfoField, raw: string, now?: Date): string | null => {
  if (field !== 'closing_date') return null;
  const normalized = normalizeBasicInfoInput(field, raw, now);
  return normalized && normalized !== raw.trim() ? normalized : null;
};

const authoritative = (group: BasicInfoGroupLike, field: BasicInfoField) => (group[field] ?? '').trim();

export const BASIC_INFO_MESSAGES = {
  incomplete: '日期格式未完成，尚未儲存（Esc 取消）',
  nonexistent: '日期不存在，尚未儲存（Esc 取消）',
  preview: (value: string) => `將儲存為 ${value}`,
  dateChanged: '台北日期已變更，完整日期預覽已更新，尚未儲存；請確認後再按 Enter',
  conflict: (latest: string) => `此欄位已在其他地方更新為「${latest || '未設定'}」，草稿未儲存；按 Esc 放棄，或再按 Enter 以草稿取代`,
  restored: '資料已重新同步（還原），此草稿未儲存；請按 Esc 放棄後重新輸入',
  notSaved: '儲存未完成，請重新載入後再試',
  failed: '儲存失敗，請重試',
} as const;

export type BasicInfoSave = (groupId: string, field: BasicInfoField, value: string) => Promise<boolean>;

export function useProductGroupBasicInfoDrafts() {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, true>>({});
  // Synchronous mirrors: Enter and the Blur it causes fire before React re-renders.
  const draftsRef = useRef<Record<string, Draft>>({});
  const inFlightRef = useRef<Set<string>>(new Set());

  const writeDrafts = useCallback((update: (prev: Record<string, Draft>) => Record<string, Draft>) => {
    draftsRef.current = update(draftsRef.current);
    setDrafts(draftsRef.current);
  }, []);
  const setError = useCallback((key: string, message: string | null) => {
    setErrors(prev => {
      if (message === null) { if (!(key in prev)) return prev; const next = { ...prev }; delete next[key]; return next; }
      return prev[key] === message ? prev : { ...prev, [key]: message };
    });
  }, []);
  const dropDraft = useCallback((key: string) => {
    if (!(key in draftsRef.current)) return;
    writeDrafts(prev => { const next = { ...prev }; delete next[key]; return next; });
  }, [writeDrafts]);

  const valueOf = (group: BasicInfoGroupLike, field: BasicInfoField): string => {
    const draft = drafts[basicInfoDraftKey(group.id, field)];
    return draft ? draft.value : (group[field] ?? '');
  };

  const change = (group: BasicInfoGroupLike, field: BasicInfoField, value: string) => {
    const key = basicInfoDraftKey(group.id, field);
    const existing = draftsRef.current[key];
    writeDrafts(prev => ({
      ...prev,
      // Keep the preview and saved date identical even when this draft spans Taipei midnight.
      [key]: existing ? { ...existing, value } : { value, base: authoritative(group, field), readToken: takeCloudReadToken(), conflict: false, provider: bindProviderMode(), dateAt: new Date() },
    }));
    setErrors(prev => {
      if (prev[key] !== BASIC_INFO_MESSAGES.incomplete && prev[key] !== BASIC_INFO_MESSAGES.nonexistent) return prev;
      const next = { ...prev }; delete next[key]; return next;
    });
  };

  const cancel = (groupId: string, field: BasicInfoField) => {
    const key = basicInfoDraftKey(groupId, field);
    dropDraft(key);
    setError(key, null);
  };

  const commit = async (group: BasicInfoGroupLike, field: BasicInfoField, source: BasicInfoCommitSource, save: BasicInfoSave): Promise<void> => {
    const key = basicInfoDraftKey(group.id, field);
    if (inFlightRef.current.has(key)) return; // Enter + Blur of the same edit
    const draft = draftsRef.current[key];
    if (!draft) return;
    try { assertProviderBinding(draft.provider); } catch (error) {
      setError(key, (error as Error).message); return;
    }
    if (!cloudReadPassesEpochBarrier(draft.readToken)) { setError(key, BASIC_INFO_MESSAGES.restored); return; }
    const normalized = normalizeBasicInfoInput(field, draft.value, draft.dateAt);
    const dateNow = new Date();
    if (field === 'closing_date' && normalized !== normalizeBasicInfoInput(field, draft.value, dateNow)) {
      writeDrafts(prev => ({ ...prev, [key]: { ...draft, dateAt: dateNow, dateConfirmation: true } }));
      setError(key, BASIC_INFO_MESSAGES.dateChanged);
      return;
    }
    if (draft.dateConfirmation && source === 'blur') return;
    if (normalized === null) {
      const problem = basicInfoInputProblem(field, draft.value, draft.dateAt);
      if (problem === 'nonexistent') setError(key, BASIC_INFO_MESSAGES.nonexistent);
      else if (source === 'enter') setError(key, BASIC_INFO_MESSAGES.incomplete);
      return;
    }
    const latest = authoritative(group, field);
    if (normalized === latest) { dropDraft(key); setError(key, null); return; } // nothing changed: zero writes
    if (latest !== draft.base) {
      // The value changed elsewhere after this draft started: never overwrite it implicitly.
      if (source === 'blur' || !draft.conflict) {
        writeDrafts(prev => ({ ...prev, [key]: { ...draft, conflict: true } }));
        setError(key, BASIC_INFO_MESSAGES.conflict(latest));
        return;
      }
    }
    inFlightRef.current.add(key);
    setSaving(prev => ({ ...prev, [key]: true }));
    setError(key, null);
    try {
      const saved = await save(group.id, field, normalized);
      assertProviderBinding(draft.provider);
      if (saved) {
        // Keep anything typed while the save was running.
        if (draftsRef.current[key]?.value === draft.value) dropDraft(key);
      } else {
        setError(key, BASIC_INFO_MESSAGES.notSaved);
      }
    } catch (error) {
      console.error('[BasicInfo] save failed:', error);
      setError(key, error instanceof ProviderModeChangedError ? error.message : BASIC_INFO_MESSAGES.failed);
    } finally {
      inFlightRef.current.delete(key);
      setSaving(prev => { const next = { ...prev }; delete next[key]; return next; });
    }
  };

  /** Drafts not already being saved (what a mode switch would discard). */
  const unsavedKeys = Object.keys(drafts).filter(key => !saving[key]);
  const discardUnsaved = () => {
    const keep = new Set(inFlightRef.current);
    writeDrafts(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => keep.has(key))));
    setErrors({});
  };
  const clearGroupFields = (groupIds: Iterable<string>, fields: BasicInfoField[]) => {
    for (const id of groupIds) for (const field of fields) cancel(id, field);
  };

  return {
    valueOf, change, cancel, commit, discardUnsaved, clearGroupFields,
    errorOf: (groupId: string, field: BasicInfoField) => errors[basicInfoDraftKey(groupId, field)],
    previewOf: (groupId: string, field: BasicInfoField) => {
      const draft = drafts[basicInfoDraftKey(groupId, field)];
      const value = draft ? basicInfoSavePreview(field, draft.value, draft.dateAt) : null;
      return value ? BASIC_INFO_MESSAGES.preview(value) : null;
    },
    isSaving: (groupId: string, field: BasicInfoField) => Boolean(saving[basicInfoDraftKey(groupId, field)]),
    hasDrafts: Object.keys(drafts).length > 0,
    hasUnsavedDrafts: unsavedKeys.length > 0,
    draftGroupIds: [...new Set(Object.keys(drafts).map(key => key.split('|')[0]))],
  };
}
