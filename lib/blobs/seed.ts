import {
  archiveId,
  attendeeCodeSeed,
  eventName,
  expiresAtSeed,
  DEFAULT_EXPIRY_DAYS,
} from '../config/env';
import { deriveCodeRecord } from '../access/code';
import { attendeeCodeKey } from './keys';
import { metaStore, readConfig, writeConfig } from './meta';
import type { ArchiveConfig, AttendeeCodeRecord } from './types';

function defaultExpiry(): string {
  const seed = expiresAtSeed();
  if (seed) {
    const t = Date.parse(seed);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86_400_000).toISOString();
}

/**
 * Create-if-absent only. NEVER overwrites, so it cannot revert a rotated code or
 * an Organizer-set expiration.
 *
 * If no attendee code record exists and no seed env var is set, the archive is
 * forced DISABLED: an archive with no code must not be an archive with no lock.
 */
export async function ensureSeeded(): Promise<ArchiveConfig> {
  const store = metaStore();
  const existing = await readConfig();

  const codeRecord = (await store.get(attendeeCodeKey(archiveId()), {
    type: 'json',
  })) as AttendeeCodeRecord | null;

  let config: ArchiveConfig;
  if (existing) {
    config = existing;
  } else {
    const now = new Date().toISOString();
    config = {
      schema: 1,
      archiveId: archiveId(),
      eventName: eventName(),
      state: 'LIVE',
      expiresAt: defaultExpiry(),
      codeVersion: 1,
      featuredMediaId: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (!codeRecord) {
    const seed = attendeeCodeSeed();
    if (seed) {
      await store.setJSON(attendeeCodeKey(archiveId()), await deriveCodeRecord(seed, 1));
      delete config.seedFailure;
    } else {
      // Fail closed.
      config.state = 'DISABLED';
      config.seedFailure =
        'No attendee code exists. Run `npm run ingest` to seed one, or set FLASHBACK_ATTENDEE_CODE_SEED. Archive is DISABLED until then.';
    }
  } else if (existing?.seedFailure) {
    // We were the ones who disabled this, and only because no code existed. A
    // code exists now, so undo our own lock rather than making the Organizer
    // hunt for an Enable button they never knowingly needed.
    delete config.seedFailure;
    if (config.state === 'DISABLED') config.state = 'LIVE';
  } else {
    delete config.seedFailure;
  }

  if (!existing || config.seedFailure || existing.seedFailure || existing.state !== config.state) {
    await writeConfig(config);
  }
  return config;
}

export async function readCodeRecord(): Promise<AttendeeCodeRecord | null> {
  return (await metaStore().get(attendeeCodeKey(archiveId()), {
    type: 'json',
  })) as AttendeeCodeRecord | null;
}

export async function writeCodeRecord(r: AttendeeCodeRecord): Promise<void> {
  await metaStore().setJSON(attendeeCodeKey(archiveId()), r);
}
