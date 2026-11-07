import {
  MemberTrainingPreferences,
  type EquipmentProfile,
  type TrainingPreferences,
} from '../models/trainingPreferences.model.js';
import type { UserDocument } from '../models/user.model.js';
import { readActiveTrainingCatalogue } from '../training/catalogue-import.js';
import { ApiError } from '../utils/apiError.js';
import type { UpdateTrainingPreferences } from '../validators/training-preferences.validator.js';

type PreferencesRow = NonNullable<Awaited<ReturnType<typeof loadPreferences>>>;

async function loadPreferences(userId: string) {
  return MemberTrainingPreferences.findById(userId).lean();
}

function toPreferences(row: PreferencesRow): TrainingPreferences {
  return {
    revision: row.revision,
    equipmentProfiles: row.equipmentProfiles.map(({ id, name, equipmentIds }) => ({ id, name, equipmentIds })),
    activeEquipmentProfileId: row.activeEquipmentProfileId,
    level: row.level,
    sessionDurationMin: row.sessionDurationMin,
    preferredLocation: row.preferredLocation,
    timezone: row.timezone,
    currentGoalId: row.currentGoalId?.toString() ?? null,
  };
}

export async function getTrainingPreferences(user: UserDocument): Promise<TrainingPreferences> {
  const row = await loadPreferences(user._id.toString());
  return row ? toPreferences(row) : {
    revision: 0,
    equipmentProfiles: [],
    activeEquipmentProfileId: null,
    level: user.fitnessProfile?.fitnessLevel ?? null,
    sessionDurationMin: null,
    preferredLocation: null,
    timezone: null,
    currentGoalId: null,
  };
}

function revisionConflict(): ApiError {
  return ApiError.conflict(
    'Your training preferences changed. Reload them and try again.',
    'TRAINING_PREFERENCES_CONFLICT',
  );
}

async function validateAddedEquipment(previous: EquipmentProfile[], next: EquipmentProfile[]) {
  // Previously saved equipment can remain in its own profile if a new
  // release retires it. Members can still rename that profile or remove it.
  const previousById = new Map(previous.map(({ id, equipmentIds }) => [id, new Set(equipmentIds)]));
  const added = new Set(next.flatMap(({ id, equipmentIds }) =>
    equipmentIds.filter((equipmentId) => !previousById.get(id)?.has(equipmentId)),
  ));
  if (added.size === 0) return;

  const catalogue = await readActiveTrainingCatalogue();
  if (!catalogue) {
    throw new ApiError(503, 'The training catalogue is not available yet', 'TRAINING_CATALOGUE_UNAVAILABLE');
  }
  const known = new Set(catalogue.equipment.map(({ id }) => id));
  const unknown = [...added].find((id) => !known.has(id));
  if (unknown) throw ApiError.validation({ equipmentIds: `Unknown equipment: ${unknown}` });
}

export async function updateTrainingPreferences(user: UserDocument, input: UpdateTrainingPreferences) {
  const current = await getTrainingPreferences(user);
  if (input.revision !== current.revision) throw revisionConflict();

  const { revision, ...changes } = input;
  const { currentGoalId: _goal, ...editable } = current;
  const next = { ...editable, ...changes, revision: revision + 1 };
  if (next.activeEquipmentProfileId !== null &&
    !next.equipmentProfiles.some(({ id }) => id === next.activeEquipmentProfileId)) {
    throw ApiError.validation({ activeEquipmentProfileId: 'Choose a saved equipment profile or clear the selection' });
  }
  if (changes.equipmentProfiles) {
    await validateAddedEquipment(current.equipmentProfiles, changes.equipmentProfiles);
  }

  try {
    // A first writer inserts revision one. The unique account ID rejects
    // concurrent first writes and the revision filter rejects stale edits.
    const updated = await MemberTrainingPreferences.findOneAndUpdate(
      { _id: user._id, revision },
      { $set: next },
      { upsert: revision === 0, returnDocument: 'after', runValidators: true },
    ).lean();
    if (!updated) throw revisionConflict();
    return toPreferences(updated);
  } catch (error) {
    if (revision === 0 && (error as { code?: unknown } | null)?.code === 11000) {
      throw revisionConflict();
    }
    throw error;
  }
}

export async function resolveEquipmentProfile(userId: string, profileId: string): Promise<string[]> {
  const preferences = await loadPreferences(userId);
  const selectedId = profileId === 'active' ? preferences?.activeEquipmentProfileId : profileId;
  const profile = preferences?.equipmentProfiles.find(({ id }) => id === selectedId);
  if (!profile) throw ApiError.notFound('Equipment profile not found', 'EQUIPMENT_PROFILE_NOT_FOUND');
  return profile.equipmentIds;
}
