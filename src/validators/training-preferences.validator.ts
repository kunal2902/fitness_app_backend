import { z } from 'zod';

import { TRAINING_LOCATIONS } from '../models/trainingPreferences.model.js';
import { TRAINING_LEVELS, trainingIdSchema } from '../training/catalogue.schema.js';

const profileId = trainingIdSchema.refine((id) => id !== 'active', 'This profile ID is reserved');
const equipmentProfile = z.object({
  id: profileId,
  name: z.string().trim().min(1).max(60),
  equipmentIds: z.array(trainingIdSchema).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'List each item once'),
}).strict();

const timezone = z.string().trim().min(1).max(80).refine((value) => {
  // ICU also supports UTC offsets on some runtimes. Store named zones.
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Use a valid IANA timezone');

export const updateTrainingPreferencesSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  equipmentProfiles: z.array(equipmentProfile).max(10)
    .refine((profiles) => new Set(profiles.map(({ id }) => id)).size === profiles.length, 'Profile IDs must be unique')
    .optional(),
  activeEquipmentProfileId: profileId.nullable().optional(),
  level: z.enum(TRAINING_LEVELS).nullable().optional(),
  sessionDurationMin: z.number().int().min(5).max(180).nullable().optional(),
  preferredLocation: z.enum(TRAINING_LOCATIONS).nullable().optional(),
  timezone: timezone.nullable().optional(),
}).strict().refine(({ revision: _revision, ...changes }) =>
  Object.values(changes).some((value) => value !== undefined), 'Include at least one preference change');

export type UpdateTrainingPreferences = z.infer<typeof updateTrainingPreferencesSchema>;
