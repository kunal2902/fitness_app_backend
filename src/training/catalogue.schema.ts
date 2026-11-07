import { z } from 'zod';

export const TRAINING_CONTRACT_VERSION = 1 as const;
export const MUSCLE_GROUPS = ['chest', 'back', 'shoulders', 'arms', 'core', 'hips', 'thighs', 'lower_legs'] as const;
export const TRAINING_LEVELS = ['newbie', 'beginner', 'intermediate', 'advanced'] as const;
export const TRAINING_TYPES = ['strength', 'skill', 'mobility', 'conditioning'] as const;
export const MEASUREMENT_TYPES = ['reps', 'duration', 'distance', 'reps_load'] as const;
export const LOADING_MODES = ['bodyweight', 'added_load', 'assisted'] as const;
export const MOVEMENT_PATTERNS = [
  'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull',
  'squat', 'hinge', 'lunge', 'carry', 'trunk_flexion', 'trunk_extension',
  'anti_rotation', 'anti_extension', 'anti_lateral_flexion', 'scapular_control',
  'elbow_flexion', 'elbow_extension', 'hip_extension', 'hip_abduction',
  'hip_adduction', 'knee_flexion', 'ankle_plantarflexion', 'ankle_dorsiflexion',
  'grip', 'skill', 'mobility',
  'shoulder_abduction', 'shoulder_horizontal_abduction', 'scapular_elevation',
] as const;

export const trainingIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/, 'Use a stable lowercase snake_case identifier');
const text = (maximum = 500) => z.string().trim().min(1).max(maximum);
const ids = (maximum = 100) => z.array(trainingIdSchema).max(maximum);
const version = z.number().int().positive().max(1_000_000);

/** Approval is an auditable assertion supplied by the content owner, never inferred by import. */
export const trainingReviewSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
  reviewer: text(160).nullable(),
  reviewedAt: z.string().datetime({ offset: true }).nullable(),
  evidence: text(1_000).nullable(),
  approvedContentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).strict().superRefine((review, context) => {
  if (review.status === 'approved' && (!review.reviewer || !review.reviewedAt || !review.evidence || !review.approvedContentHash)) {
    context.addIssue({ code: 'custom', message: 'Approval requires reviewer, timestamp, evidence and approved content hash' });
  }
});

export const trainingMuscleSchema = z.object({
  id: trainingIdSchema,
  name: text(120),
  group: z.enum(MUSCLE_GROUPS),
  // Drawing IDs are separate from muscle IDs; empty until licensed artwork exists.
  svgRegionIds: ids(),
}).strict();

export const trainingEquipmentSchema = z.object({
  id: trainingIdSchema,
  name: text(120),
  category: z.enum(['support', 'free_weight', 'resistance', 'machine', 'accessory']),
  aliases: z.array(text(120)).max(30),
}).strict();

export const trainingSourceSchema = z.object({
  id: trainingIdSchema,
  name: text(200),
  version: text(100),
  kind: z.enum(['original', 'external']),
  locator: text(1_000),
  licence: text(500),
  attribution: text(1_000).nullable(),
  rights: trainingReviewSchema,
}).strict();

export const trainingMediaSchema = z.object({
  id: trainingIdSchema,
  type: z.enum(['image', 'video']),
  url: z.string().url().max(2_000).refine((url) => new URL(url).protocol === 'https:', 'Media must use HTTPS'),
  sourceId: trainingIdSchema,
  attribution: text(1_000).nullable(),
  status: z.enum(['available', 'withdrawn']),
  rights: trainingReviewSchema,
}).strict();

export const equipmentRequirementSchema = z.object({
  anyOf: ids(20).min(1),
}).strict();

export const trainingExerciseSchema = z.object({
  id: trainingIdSchema,
  version,
  name: text(160),
  aliases: z.array(text(160)).max(30),
  familyId: trainingIdSchema,
  variationOfId: trainingIdSchema.nullable(),
  primaryMuscleIds: ids(30).min(1),
  secondaryMuscleIds: ids(30),
  movementPatternIds: z.array(z.enum(MOVEMENT_PATTERNS)).min(1).max(10),
  equipmentStatus: z.enum(['known', 'unknown']),
  equipmentRequirementGroups: z.array(equipmentRequirementSchema).max(20),
  optionalEquipmentIds: ids(30),
  difficulty: z.enum(TRAINING_LEVELS),
  trainingType: z.enum(TRAINING_TYPES),
  loadingMode: z.enum(LOADING_MODES),
  measurementType: z.enum(MEASUREMENT_TYPES),
  unilateral: z.boolean(),
  instructions: z.array(text(1_000)).min(2).max(30),
  formCues: z.array(text()).min(1).max(20),
  commonMistakes: z.array(text()).min(1).max(20),
  regressionIds: ids(),
  progressionIds: ids(),
  substitutionIds: ids(),
  mediaIds: ids(20),
  sourceId: trainingIdSchema,
  review: trainingReviewSchema,
}).strict().superRefine((exercise, context) => {
  if (exercise.measurementType === 'reps_load' && exercise.loadingMode === 'bodyweight') {
    context.addIssue({ code: 'custom', path: ['measurementType'], message: 'Loaded reps require an added-load or assisted mode' });
  }
  if (exercise.equipmentStatus === 'unknown' && exercise.equipmentRequirementGroups.length > 0) {
    context.addIssue({ code: 'custom', path: ['equipmentRequirementGroups'], message: 'Unknown equipment cannot declare known requirements' });
  }
});

export const workoutPrescriptionSchema = z.object({
  id: trainingIdSchema,
  exerciseId: trainingIdSchema,
  exerciseVersion: version,
  sets: z.number().int().min(1).max(100),
  reps: z.number().int().min(1).max(1_000).optional(),
  durationSec: z.number().finite().positive().max(86_400).optional(),
  distanceM: z.number().finite().positive().max(100_000).optional(),
  loadKg: z.number().finite().positive().max(1_000).optional(),
  assistanceKg: z.number().finite().positive().max(500).optional(),
  perSide: z.boolean(),
  restSec: z.number().int().min(0).max(3_600),
}).strict();

export const trainingWorkoutSchema = z.object({
  id: trainingIdSchema,
  version,
  name: text(160),
  difficulty: z.enum(TRAINING_LEVELS),
  trainingType: z.enum(TRAINING_TYPES),
  estimatedDurationMin: z.number().int().positive().max(600),
  sourceId: trainingIdSchema,
  review: trainingReviewSchema,
  blocks: z.array(z.object({
    id: trainingIdSchema,
    type: z.enum(['warmup', 'main', 'cooldown']),
    rounds: z.number().int().min(1).max(100),
    items: z.array(workoutPrescriptionSchema).min(1).max(100),
  }).strict()).min(1).max(30),
}).strict();

export const trainingCatalogueSchema = z.object({
  schemaVersion: z.literal(TRAINING_CONTRACT_VERSION),
  releaseId: trainingIdSchema,
  catalogueVersion: version,
  sources: z.array(trainingSourceSchema).min(1).max(100),
  muscles: z.array(trainingMuscleSchema).min(1).max(100),
  equipment: z.array(trainingEquipmentSchema).max(200),
  media: z.array(trainingMediaSchema).max(10_000),
  exercises: z.array(trainingExerciseSchema).min(1).max(5_000),
  workouts: z.array(trainingWorkoutSchema).max(1_000),
}).strict();

export type TrainingReview = z.infer<typeof trainingReviewSchema>;
export type TrainingMuscle = z.infer<typeof trainingMuscleSchema>;
export type TrainingEquipment = z.infer<typeof trainingEquipmentSchema>;
export type TrainingSource = z.infer<typeof trainingSourceSchema>;
export type TrainingMedia = z.infer<typeof trainingMediaSchema>;
export type EquipmentRequirement = z.infer<typeof equipmentRequirementSchema>;
export type TrainingExercise = z.infer<typeof trainingExerciseSchema>;
export type TrainingWorkout = z.infer<typeof trainingWorkoutSchema>;
export type WorkoutPrescription = z.infer<typeof workoutPrescriptionSchema>;
export type TrainingCatalogue = z.infer<typeof trainingCatalogueSchema>;
