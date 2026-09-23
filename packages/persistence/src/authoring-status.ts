import type { Diagnostic, ProjectId, ProjectVfsSnapshot } from '@dungeon-scrivener/model';
import { loadRecovery, type RecoveryOptions } from './index.js';

export const SAVE_REMINDER_DELAY_MS = 12 * 60 * 1000;

export interface AuthoringStatusOptions {
  readonly now?: () => number;
  readonly recoverySavedAt?: number | null;
  readonly lastExportedAt?: number | null;
}

export interface AuthoringStatusSnapshot {
  readonly dirty: boolean;
  readonly unsavedSince: number | null;
  readonly recoverySavedAt: number | null;
  readonly lastExportedAt: number | null;
  readonly saveReminderVisible: boolean;
}

export interface AuthoringStatusController {
  getStatus(): AuthoringStatusSnapshot;
  markEdited(): void;
  markRecoverySaved(savedAt?: number): void;
  markRecoveryRestored(savedAt: number): void;
  markProjectZipExported(exportedAt?: number): void;
  dismissSaveReminder(): void;
}

function validTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Authoring timestamps must be finite non-negative milliseconds.');
  return value;
}

/** Track unsaved edits independently from recovery autosaves and deliberate project ZIP exports. */
export function createAuthoringStatus(options: AuthoringStatusOptions = {}): AuthoringStatusController {
  const now = options.now ?? Date.now;
  let dirtySince: number | null = null;
  let reminderStartedAt: number | null = null;
  let recoverySavedAt = options.recoverySavedAt ?? null;
  let lastExportedAt = options.lastExportedAt ?? null;
  let revision = 0;
  let dismissedRevision: number | null = null;

  if (recoverySavedAt !== null) validTime(recoverySavedAt);
  if (lastExportedAt !== null) validTime(lastExportedAt);

  const readNow = (): number => validTime(now());
  const isReminderVisible = (): boolean => dirtySince !== null && reminderStartedAt !== null &&
    dismissedRevision !== revision && readNow() - reminderStartedAt >= SAVE_REMINDER_DELAY_MS;

  return {
    getStatus(): AuthoringStatusSnapshot {
      return {
        dirty: dirtySince !== null,
        unsavedSince: dirtySince,
        recoverySavedAt,
        lastExportedAt,
        saveReminderVisible: isReminderVisible()
      };
    },

    markEdited(): void {
      const editedAt = readNow();
      revision += 1;
      if (dirtySince === null) {
        dirtySince = editedAt;
        reminderStartedAt = editedAt;
      } else if (dismissedRevision !== null) {
        reminderStartedAt = editedAt;
        dismissedRevision = null;
      }
    },

    markRecoverySaved(savedAt = readNow()): void {
      recoverySavedAt = validTime(savedAt);
    },

    markRecoveryRestored(savedAt: number): void {
      const restoredAt = validTime(savedAt);
      dirtySince = restoredAt;
      recoverySavedAt = restoredAt;
      reminderStartedAt = readNow();
      revision += 1;
      dismissedRevision = null;
    },

    markProjectZipExported(exportedAt = readNow()): void {
      lastExportedAt = validTime(exportedAt);
      dirtySince = null;
      reminderStartedAt = null;
      dismissedRevision = null;
    },

    dismissSaveReminder(): void {
      if (isReminderVisible()) dismissedRevision = revision;
    }
  };
}

export type RecoveryRestorePrompt =
  | { readonly state: 'available'; readonly projectId: ProjectId; readonly snapshot: ProjectVfsSnapshot; readonly savedAt: number }
  | { readonly state: 'none'; readonly projectId: ProjectId }
  | { readonly state: 'unavailable'; readonly projectId: ProjectId; readonly diagnostic: Diagnostic };

/** Return UI-ready recovery availability for the app to show or skip a restore prompt. */
export async function getRecoveryRestorePrompt(
  projectId: ProjectId,
  options: RecoveryOptions = {}
): Promise<RecoveryRestorePrompt> {
  const recovery = await loadRecovery(projectId, options);
  if (!recovery.ok) return { state: 'unavailable', projectId, diagnostic: recovery.diagnostic };
  if (recovery.snapshot === null || recovery.savedAt === null) return { state: 'none', projectId };
  return { state: 'available', projectId, snapshot: recovery.snapshot, savedAt: recovery.savedAt };
}
