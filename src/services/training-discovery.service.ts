import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  canPerformExercise,
  canPerformWorkout,
  exerciseUsesEquipment,
} from '../training/catalogue-policy.js';
import {
  MOVEMENT_PATTERNS,
  MUSCLE_GROUPS,
  TRAINING_LEVELS,
  TRAINING_TYPES,
  trainingIdSchema,
  type TrainingCatalogue,
  type TrainingExercise,
  type TrainingMedia,
  type TrainingWorkout,
} from '../training/catalogue.schema.js';
import { ApiError } from '../utils/apiError.js';
import type {
  ExerciseDiscoveryQuery,
  WorkoutDiscoveryQuery,
} from '../validators/training-discovery.validator.js';

type DiscoveryQuery = ExerciseDiscoveryQuery | WorkoutDiscoveryQuery;
type Targets = Pick<TrainingExercise, 'primaryMuscleIds' | 'secondaryMuscleIds'>;
type ExerciseMedia = Map<string, ReturnType<typeof publicMedia>>;
type EquipmentFilter = { mode: 'available' | 'uses'; ids: ReadonlySet<string> };

const MUSCLE_GROUP_NAMES: Record<(typeof MUSCLE_GROUPS)[number], string> = {
  chest: 'Chest',
  back: 'Back',
  shoulders: 'Shoulders',
  arms: 'Arms',
  core: 'Core',
  hips: 'Hips',
  thighs: 'Thighs',
  lower_legs: 'Lower legs',
};

const compareNames = new Intl.Collator('en', { sensitivity: 'base', numeric: true }).compare;
const cursorSchema = z.object({
  releaseId: trainingIdSchema,
  catalogueVersion: z.number().int().positive(),
  filterHash: z.string().regex(/^[a-f0-9]{64}$/),
  lastId: trainingIdSchema,
}).strict();
type DiscoveryCursor = z.infer<typeof cursorSchema>;

function catalogueIdentity(catalogue: TrainingCatalogue) {
  return { catalogueVersion: catalogue.catalogueVersion, releaseId: catalogue.releaseId };
}

function compareId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function byName(a: { id: string; name: string }, b: { id: string; name: string }) {
  return compareNames(a.name, b.name) || compareId(a.id, b.id);
}

export function getTrainingTaxonomy(catalogue: TrainingCatalogue) {
  return {
    ...catalogueIdentity(catalogue),
    muscleGroups: MUSCLE_GROUPS.map((id) => ({ id, name: MUSCLE_GROUP_NAMES[id] })),
    muscles: [...catalogue.muscles].sort(byName),
    equipment: [...catalogue.equipment].sort(byName),
    movementPatternIds: MOVEMENT_PATTERNS,
    difficulties: TRAINING_LEVELS,
    trainingTypes: TRAINING_TYPES,
  };
}

function publicMedia({ id, type, url, attribution }: TrainingMedia) {
  return { id, type, url, attribution };
}

function publishedMedia(catalogue: TrainingCatalogue): ExerciseMedia {
  return new Map(catalogue.media.map((asset) => [asset.id, publicMedia(asset)]));
}

function exerciseMedia(exercise: TrainingExercise, media: ExerciseMedia) {
  return exercise.mediaIds.flatMap((id) => {
    const asset = media.get(id);
    return asset === undefined ? [] : [asset];
  });
}

function exerciseSummary(exercise: TrainingExercise, media: ExerciseMedia) {
  return {
    id: exercise.id,
    version: exercise.version,
    name: exercise.name,
    primaryMuscleIds: exercise.primaryMuscleIds,
    secondaryMuscleIds: exercise.secondaryMuscleIds,
    movementPatternIds: exercise.movementPatternIds,
    equipmentStatus: exercise.equipmentStatus,
    equipmentRequirementGroups: exercise.equipmentRequirementGroups,
    optionalEquipmentIds: exercise.optionalEquipmentIds,
    difficulty: exercise.difficulty,
    trainingType: exercise.trainingType,
    loadingMode: exercise.loadingMode,
    measurementType: exercise.measurementType,
    unilateral: exercise.unilateral,
    poster: exerciseMedia(exercise, media).find((asset) => asset.type === 'image') ?? null,
  };
}

export function getExerciseDetail(catalogue: TrainingCatalogue, id: string) {
  const exercise = catalogue.exercises.find((item) => item.id === id);
  if (!exercise) throw ApiError.notFound('Exercise not found', 'EXERCISE_NOT_FOUND');
  const media = publishedMedia(catalogue);
  return {
    ...catalogueIdentity(catalogue),
    exercise: {
      ...exerciseSummary(exercise, media),
      aliases: exercise.aliases,
      familyId: exercise.familyId,
      variationOfId: exercise.variationOfId,
      instructions: exercise.instructions,
      formCues: exercise.formCues,
      commonMistakes: exercise.commonMistakes,
      regressionIds: exercise.regressionIds,
      progressionIds: exercise.progressionIds,
      substitutionIds: exercise.substitutionIds,
      media: exerciseMedia(exercise, media),
    },
  };
}

function normalizeSearch(text: string) {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function searchRank(query: string | undefined, name: string, aliases: readonly string[] = []) {
  if (query === undefined) return 0;
  if (!query) return undefined;
  const queryCompact = query.replaceAll(' ', '');
  const queryWords = query.split(' ');
  let best = Infinity;
  for (const [index, label] of [name, ...aliases].entries()) {
    const normalized = normalizeSearch(label);
    const compact = normalized.replaceAll(' ', '');
    const labelWords = normalized.split(' ');
    const aliasPenalty = index === 0 ? 0 : 1;
    if (compact === queryCompact) best = Math.min(best, aliasPenalty);
    else if (compact.startsWith(queryCompact)) best = Math.min(best, 2 + aliasPenalty);
    else if (queryWords.every((word) => labelWords.some((part) => part.startsWith(word)))) {
      best = Math.min(best, 4 + aliasPenalty);
    }
  }
  return best === Infinity ? undefined : best;
}

function filterMuscles(catalogue: TrainingCatalogue, query: DiscoveryQuery) {
  const requested = new Set(query.muscles);
  const groups = new Set(query.muscleGroups);
  const known = new Set(catalogue.muscles.map((muscle) => muscle.id));
  if ([...requested].some((id) => !known.has(id))) {
    throw ApiError.validation({ muscles: 'Select muscle IDs from the active training taxonomy' });
  }
  if (requested.size === 0 && groups.size === 0) return (_targets: Targets) => true;
  for (const muscle of catalogue.muscles) {
    if (groups.has(muscle.group)) requested.add(muscle.id);
  }
  return (targets: Targets) => targets.primaryMuscleIds.some((id) => requested.has(id)) ||
    (query.muscleRole === 'any' && targets.secondaryMuscleIds.some((id) => requested.has(id)));
}

function filterEquipment(catalogue: TrainingCatalogue, query: DiscoveryQuery, profileEquipment?: readonly string[]): EquipmentFilter | undefined {
  if (query.equipmentProfileId !== undefined) {
    if (profileEquipment === undefined) throw new Error('Equipment profile was not resolved');
    return { mode: 'available', ids: new Set(profileEquipment) };
  }
  if (query.equipmentMode === undefined) return undefined;
  const ids = new Set(query.equipmentIds);
  const known = new Set(catalogue.equipment.map((item) => item.id));
  if ([...ids].some((id) => !known.has(id))) {
    throw ApiError.validation({ equipmentIds: 'Select equipment IDs from the active training taxonomy' });
  }
  return { mode: query.equipmentMode, ids };
}

function usesAnyEquipment(exercise: TrainingExercise, ids: ReadonlySet<string>) {
  return [...ids].some((id) => exerciseUsesEquipment(exercise, id));
}

function matchesMetadata(item: Pick<TrainingExercise, 'difficulty' | 'trainingType'>, query: DiscoveryQuery) {
  return (query.difficulty === undefined || item.difficulty === query.difficulty) &&
    (query.trainingType === undefined || item.trainingType === query.trainingType);
}

type Ranked<T> = { item: T; rank: number };

function compareRanked<T extends Pick<TrainingExercise, 'id' | 'name' | 'difficulty'> & { estimatedDurationMin?: number }>(
  a: Ranked<T>,
  b: Ranked<T>,
  sort: DiscoveryQuery['sort'],
) {
  if (sort === 'relevance' && a.rank !== b.rank) return a.rank - b.rank;
  if (sort === 'duration' && a.item.estimatedDurationMin !== b.item.estimatedDurationMin) {
    return (a.item.estimatedDurationMin ?? 0) - (b.item.estimatedDurationMin ?? 0);
  }
  if (sort === 'difficulty' && a.item.difficulty !== b.item.difficulty) {
    return TRAINING_LEVELS.indexOf(a.item.difficulty) - TRAINING_LEVELS.indexOf(b.item.difficulty);
  }
  return byName(a.item, b.item);
}

function invalidCursor(): ApiError {
  return ApiError.validation({ cursor: 'Use the next cursor returned for these filters' });
}

function readCursor(catalogue: TrainingCatalogue, token: string | undefined): DiscoveryCursor | undefined {
  if (token === undefined) return undefined;
  let cursor: DiscoveryCursor;
  try {
    const decoded = Buffer.from(token, 'base64url');
    if (decoded.toString('base64url') !== token) throw invalidCursor();
    cursor = cursorSchema.parse(JSON.parse(decoded.toString('utf8')));
  } catch {
    throw invalidCursor();
  }
  if (cursor.releaseId !== catalogue.releaseId || cursor.catalogueVersion !== catalogue.catalogueVersion) {
    throw ApiError.conflict('The training catalogue has changed. Start from the first page.', 'TRAINING_CATALOGUE_CHANGED');
  }
  return cursor;
}

function filterFingerprint(kind: 'exercise' | 'workout', query: DiscoveryQuery, normalizedQuery: string | undefined, equipment?: EquipmentFilter) {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  return createHash('sha256').update(JSON.stringify({
    kind,
    ...filters,
    q: normalizedQuery,
    resolvedEquipment: equipment && [...equipment.ids].sort(),
  })).digest('hex');
}

function page<T extends { id: string }, R>(
  catalogue: TrainingCatalogue,
  records: Ranked<T>[],
  limit: number,
  cursor: DiscoveryCursor | undefined,
  filterHash: string,
  project: (item: T) => R,
) {
  let start = 0;
  if (cursor !== undefined) {
    if (cursor.filterHash !== filterHash) throw invalidCursor();
    const previous = records.findIndex(({ item }) => item.id === cursor.lastId);
    if (previous === -1) throw invalidCursor();
    start = previous + 1;
  }
  const recordsOnPage = records.slice(start, start + limit);
  const last = recordsOnPage.at(-1);
  const nextCursor = last && start + recordsOnPage.length < records.length
    ? Buffer.from(JSON.stringify({
      ...catalogueIdentity(catalogue), filterHash, lastId: last.item.id,
    })).toString('base64url')
    : null;
  return { ...catalogueIdentity(catalogue), items: recordsOnPage.map(({ item }) => project(item)), nextCursor };
}

export function listExercises(catalogue: TrainingCatalogue, query: ExerciseDiscoveryQuery, profileEquipment?: readonly string[]) {
  const cursor = readCursor(catalogue, query.cursor);
  const normalizedQuery = query.q === undefined ? undefined : normalizeSearch(query.q);
  const matchesMuscles = filterMuscles(catalogue, query);
  const equipment = filterEquipment(catalogue, query, profileEquipment);
  const records: Ranked<TrainingExercise>[] = [];
  for (const item of catalogue.exercises) {
    if (!matchesMetadata(item, query) || !matchesMuscles(item)) continue;
    if (query.loadingMode !== undefined && item.loadingMode !== query.loadingMode) continue;
    if (query.movementPattern !== undefined && !item.movementPatternIds.includes(query.movementPattern)) continue;
    if (equipment?.mode === 'available' && !canPerformExercise(item, equipment.ids)) continue;
    if (equipment?.mode === 'uses' && !usesAnyEquipment(item, equipment.ids)) continue;
    const rank = searchRank(normalizedQuery, item.name, item.aliases);
    if (rank !== undefined) records.push({ item, rank });
  }
  records.sort((a, b) => compareRanked(a, b, query.sort));
  const media = publishedMedia(catalogue);
  return page(catalogue, records, query.limit, cursor, filterFingerprint('exercise', query, normalizedQuery, equipment),
    (item) => exerciseSummary(item, media));
}

function workoutExercises(workout: TrainingWorkout, exercises: ReadonlyMap<string, TrainingExercise>) {
  const distinct = new Map<string, TrainingExercise>();
  for (const block of workout.blocks) {
    for (const item of block.items) {
      const exercise = exercises.get(item.exerciseId);
      if (!exercise || exercise.version !== item.exerciseVersion) {
        throw new Error('Published workout references an invalid exercise version');
      }
      distinct.set(exercise.id, exercise);
    }
  }
  return [...distinct.values()];
}

function workoutSummary(workout: TrainingWorkout, exercises: ReadonlyMap<string, TrainingExercise>) {
  const variants = workoutExercises(workout, exercises);
  const requirementGroups = new Map<string, { anyOf: string[] }>();
  for (const exercise of variants) {
    for (const group of exercise.equipmentRequirementGroups) {
      const anyOf = [...group.anyOf].sort();
      requirementGroups.set(anyOf.join(','), { anyOf });
    }
  }
  const primaryMuscleIds = [...new Set(variants.flatMap((exercise) => exercise.primaryMuscleIds))].sort();
  const secondaryMuscleIds = [...new Set(variants.flatMap((exercise) => exercise.secondaryMuscleIds))]
    .filter((id) => !primaryMuscleIds.includes(id)).sort();
  return {
    id: workout.id,
    version: workout.version,
    name: workout.name,
    difficulty: workout.difficulty,
    trainingType: workout.trainingType,
    estimatedDurationMin: workout.estimatedDurationMin,
    exerciseCount: variants.length,
    primaryMuscleIds,
    secondaryMuscleIds,
    equipmentRequirementGroups: [...requirementGroups.values()],
    optionalEquipmentIds: [...new Set(variants.flatMap((exercise) => exercise.optionalEquipmentIds))].sort(),
  };
}

export function listWorkouts(catalogue: TrainingCatalogue, query: WorkoutDiscoveryQuery, profileEquipment?: readonly string[]) {
  const cursor = readCursor(catalogue, query.cursor);
  const normalizedQuery = query.q === undefined ? undefined : normalizeSearch(query.q);
  const matchesMuscles = filterMuscles(catalogue, query);
  const equipment = filterEquipment(catalogue, query, profileEquipment);
  const exercises = new Map(catalogue.exercises.map((exercise) => [exercise.id, exercise]));
  const records: Ranked<TrainingWorkout>[] = [];
  for (const item of catalogue.workouts) {
    if (!matchesMetadata(item, query)) continue;
    if (query.maxDurationMin !== undefined && item.estimatedDurationMin > query.maxDurationMin) continue;
    const rank = searchRank(normalizedQuery, item.name);
    if (rank === undefined) continue;
    if (equipment?.mode === 'available' && !canPerformWorkout(item, exercises, equipment.ids)) continue;
    const variants = workoutExercises(item, exercises);
    if (!variants.some(matchesMuscles)) continue;
    if (equipment?.mode === 'uses' && !variants.some((variant) => usesAnyEquipment(variant, equipment.ids))) continue;
    records.push({ item, rank });
  }
  records.sort((a, b) => compareRanked(a, b, query.sort));
  return page(catalogue, records, query.limit, cursor, filterFingerprint('workout', query, normalizedQuery, equipment),
    (item) => workoutSummary(item, exercises));
}

export function getWorkoutDetail(catalogue: TrainingCatalogue, id: string) {
  const workout = catalogue.workouts.find((item) => item.id === id);
  if (!workout) throw ApiError.notFound('Workout not found', 'WORKOUT_NOT_FOUND');
  const exercises = new Map(catalogue.exercises.map((exercise) => [exercise.id, exercise]));
  const media = publishedMedia(catalogue);
  return {
    ...catalogueIdentity(catalogue),
    workout: {
      ...workoutSummary(workout, exercises),
      blocks: workout.blocks,
      exercises: workoutExercises(workout, exercises).map((exercise) => exerciseSummary(exercise, media)),
    },
  };
}
