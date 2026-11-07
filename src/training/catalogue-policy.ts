import { createHash } from 'node:crypto';

import {
  trainingCatalogueSchema,
  type TrainingCatalogue,
  type TrainingExercise,
  type TrainingWorkout,
  type TrainingReview,
} from './catalogue.schema.js';

export class CatalogueValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Training catalogue rejected (${issues.length} issue(s)):\n${issues.slice(0, 30).map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'CatalogueValidationError';
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Array order is meaningful inside instructions, workout blocks and circuits. */
export function catalogueHash(catalogue: TrainingCatalogue): string {
  return contentHash({
    ...catalogue,
    sources: [...catalogue.sources].sort((a, b) => a.id.localeCompare(b.id)),
    muscles: [...catalogue.muscles].sort((a, b) => a.id.localeCompare(b.id)),
    equipment: [...catalogue.equipment].sort((a, b) => a.id.localeCompare(b.id)),
    media: [...catalogue.media].sort((a, b) => a.id.localeCompare(b.id)),
    exercises: [...catalogue.exercises].sort((a, b) => a.id.localeCompare(b.id)),
    workouts: [...catalogue.workouts].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/** Approval metadata can change without changing the exercise's semantic version. */
export function exerciseContentHash(exercise: TrainingExercise): string {
  const { review: _review, ...content } = exercise;
  return contentHash({
    ...content,
    aliases: [...content.aliases].sort(),
    primaryMuscleIds: [...content.primaryMuscleIds].sort(),
    secondaryMuscleIds: [...content.secondaryMuscleIds].sort(),
    movementPatternIds: [...content.movementPatternIds].sort(),
    equipmentRequirementGroups: content.equipmentRequirementGroups
      .map((group) => ({ anyOf: [...group.anyOf].sort() }))
      .sort((a, b) => a.anyOf.join('|').localeCompare(b.anyOf.join('|'))),
    optionalEquipmentIds: [...content.optionalEquipmentIds].sort(),
    regressionIds: [...content.regressionIds].sort(),
    progressionIds: [...content.progressionIds].sort(),
    substitutionIds: [...content.substitutionIds].sort(),
  });
}

export function workoutContentHash(workout: TrainingWorkout): string {
  const { review: _review, ...content } = workout;
  return contentHash(content);
}

/** Sources/media bind approval to their exact metadata, including version/URL. */
export function reviewedContentHash(value: object): string {
  const content = { ...value } as Record<string, unknown>;
  delete content.review;
  delete content.rights;
  return contentHash(content);
}

export function canPerformExercise(exercise: TrainingExercise, availableEquipment: ReadonlySet<string>): boolean {
  return exercise.equipmentStatus === 'known' && exercise.equipmentRequirementGroups.every((group) => group.anyOf.some((id) => availableEquipment.has(id)));
}

export function exerciseUsesEquipment(exercise: TrainingExercise, equipmentId: string): boolean {
  return exercise.equipmentRequirementGroups.some((group) => group.anyOf.includes(equipmentId)) || exercise.optionalEquipmentIds.includes(equipmentId);
}

export function canPerformWorkout(workout: TrainingWorkout, exercises: ReadonlyMap<string, TrainingExercise>, availableEquipment: ReadonlySet<string>): boolean {
  return workout.blocks.every((block) => block.items.every((item) => {
    const exercise = exercises.get(item.exerciseId);
    return exercise?.version === item.exerciseVersion && canPerformExercise(exercise, availableEquipment);
  }));
}

function approved(review: TrainingReview, expectedHash: string): boolean {
  return review.status === 'approved' && Boolean(review.reviewer && review.reviewedAt && review.evidence) && review.approvedContentHash === expectedHash;
}

/** Pure, whole-bundle validation. It must run before any database/file mutation. */
export function validateTrainingCatalogue(raw: unknown): TrainingCatalogue {
  const parsed = trainingCatalogueSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CatalogueValidationError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  const catalogue = parsed.data;
  const issues: string[] = [];
  const unique = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length) issues.push(`${label}: duplicate value`);
  };
  for (const key of ['sources', 'muscles', 'equipment', 'media', 'exercises', 'workouts'] as const) {
    unique(catalogue[key].map((item) => item.id), key);
  }
  const muscles = new Set(catalogue.muscles.map((item) => item.id));
  const equipment = new Set(catalogue.equipment.map((item) => item.id));
  const sources = new Set(catalogue.sources.map((item) => item.id));
  const media = new Set(catalogue.media.map((item) => item.id));
  const exercises = new Map(catalogue.exercises.map((item) => [item.id, item]));
  const references = (values: readonly string[], known: ReadonlySet<string>, label: string) => {
    unique(values, label);
    for (const id of values) if (!known.has(id)) issues.push(`${label}: unknown reference ${id}`);
  };
  unique(catalogue.muscles.flatMap((muscle) => muscle.svgRegionIds), 'muscles.svgRegionIds');
  for (const asset of catalogue.media) references([asset.sourceId], sources, `${asset.id}.sourceId`);
  for (const exercise of catalogue.exercises) {
    const label = exercise.id;
    references(exercise.primaryMuscleIds, muscles, `${label}.primaryMuscleIds`);
    references(exercise.secondaryMuscleIds, muscles, `${label}.secondaryMuscleIds`);
    unique(exercise.movementPatternIds, `${label}.movementPatternIds`);
    if (exercise.primaryMuscleIds.some((id) => exercise.secondaryMuscleIds.includes(id))) issues.push(`${label}: primary and secondary muscles overlap`);
    unique(exercise.aliases.map((alias) => alias.toLocaleLowerCase('en')), `${label}.aliases`);
    const groups: string[] = [];
    for (const group of exercise.equipmentRequirementGroups) {
      references(group.anyOf, equipment, `${label}.equipmentRequirementGroups`);
      groups.push([...group.anyOf].sort().join('|'));
    }
    unique(groups, `${label}.equipmentRequirementGroups`);
    references(exercise.optionalEquipmentIds, equipment, `${label}.optionalEquipmentIds`);
    if (exercise.optionalEquipmentIds.some((id) => exercise.equipmentRequirementGroups.some((group) => group.anyOf.includes(id)))) issues.push(`${label}: equipment cannot be both optional and required`);
    references(exercise.mediaIds, media, `${label}.mediaIds`);
    references([exercise.sourceId], sources, `${label}.sourceId`);
    for (const key of ['regressionIds', 'progressionIds', 'substitutionIds'] as const) {
      references(exercise[key], new Set(exercises.keys()), `${label}.${key}`);
      if (exercise[key].includes(exercise.id)) issues.push(`${label}.${key}: self-reference`);
    }
    if (exercise.variationOfId !== null) {
      const parent = exercises.get(exercise.variationOfId);
      if (!parent || parent.id === exercise.id || parent.familyId !== exercise.familyId) issues.push(`${label}.variationOfId: needs a different exercise in the same family`);
    }
  }
  // Separate directed graphs: reciprocal regression/progression edges are valid.
  for (const relationship of ['variationOfId', 'regressionIds', 'progressionIds'] as const) {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) { issues.push(`${relationship}: cycle at ${id}`); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      const exercise = exercises.get(id);
      const edges = exercise ? relationship === 'variationOfId' ? exercise.variationOfId ? [exercise.variationOfId] : [] : exercise[relationship] : [];
      for (const edge of edges) visit(edge);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of exercises.keys()) visit(id);
  }
  for (const workout of catalogue.workouts) {
    references([workout.sourceId], sources, `${workout.id}.sourceId`);
    unique(workout.blocks.map((block) => block.id), `${workout.id}.blocks`);
    unique(workout.blocks.flatMap((block) => block.items.map((item) => item.id)), `${workout.id}.items`);
    for (const block of workout.blocks) for (const item of block.items) {
      const exercise = exercises.get(item.exerciseId);
      const label = `${workout.id}.${item.id}`;
      if (!exercise || exercise.version !== item.exerciseVersion) { issues.push(`${label}: missing exact exercise version`); continue; }
      if (item.perSide !== exercise.unilateral) issues.push(`${label}: perSide must match exercise laterality`);
      const targets = [item.reps, item.durationSec, item.distanceM].filter((value) => value !== undefined);
      const expected = exercise.measurementType === 'duration' ? item.durationSec : exercise.measurementType === 'distance' ? item.distanceM : item.reps;
      if (targets.length !== 1 || expected === undefined) issues.push(`${label}: target does not match exercise measurement type`);
      if (exercise.loadingMode !== 'added_load' && item.loadKg !== undefined) issues.push(`${label}: added load incompatible with exercise`);
      if (exercise.loadingMode !== 'assisted' && item.assistanceKg !== undefined) issues.push(`${label}: assistance incompatible with exercise`);
      if (exercise.measurementType === 'reps_load' && item.loadKg === undefined && item.assistanceKg === undefined) issues.push(`${label}: loaded reps need the matching load`);
    }
  }
  if (issues.length) throw new CatalogueValidationError(issues);
  return catalogue;
}

export function publicationBlockers(catalogue: TrainingCatalogue): string[] {
  const issues: string[] = [];
  const sources = new Map(catalogue.sources.map((source) => [source.id, source]));
  const media = new Map(catalogue.media.map((asset) => [asset.id, asset]));
  for (const source of catalogue.sources) if (!approved(source.rights, reviewedContentHash(source))) issues.push(`source ${source.id}: distribution rights not approved for this content`);
  for (const asset of catalogue.media) {
    if (asset.status !== 'available' || !approved(asset.rights, reviewedContentHash(asset))) issues.push(`media ${asset.id}: withdrawn or rights not approved for this content`);
  }
  for (const exercise of catalogue.exercises) {
    if (!approved(exercise.review, exerciseContentHash(exercise))) issues.push(`exercise ${exercise.id}: editorial review not approved for this content`);
    if (exercise.equipmentStatus !== 'known') issues.push(`exercise ${exercise.id}: equipment requirements unknown`);
    const source = sources.get(exercise.sourceId)!;
    if (!approved(source.rights, reviewedContentHash(source))) issues.push(`exercise ${exercise.id}: source not cleared`);
    for (const id of exercise.mediaIds) {
      const asset = media.get(id)!;
      const mediaSource = sources.get(asset.sourceId)!;
      if (!approved(asset.rights, reviewedContentHash(asset)) || asset.status !== 'available' || !approved(mediaSource.rights, reviewedContentHash(mediaSource))) issues.push(`exercise ${exercise.id}: media ${id} not cleared`);
    }
  }
  for (const workout of catalogue.workouts) if (!approved(workout.review, workoutContentHash(workout))) issues.push(`workout ${workout.id}: editorial review not approved for this content`);
  return issues;
}

export function assertPublishable(catalogue: TrainingCatalogue): void {
  const issues = publicationBlockers(catalogue);
  if (issues.length) throw new CatalogueValidationError(issues);
}

export function catalogueReport(catalogue: TrainingCatalogue) {
  const primaryGroups = new Set(catalogue.exercises.flatMap((exercise) => exercise.primaryMuscleIds));
  return {
    releaseId: catalogue.releaseId,
    hash: catalogueHash(catalogue),
    sources: catalogue.sources.length,
    muscles: catalogue.muscles.length,
    equipment: catalogue.equipment.length,
    exercises: catalogue.exercises.length,
    workouts: catalogue.workouts.length,
    media: catalogue.media.length,
    reviewHashes: {
      sources: Object.fromEntries(catalogue.sources.map((item) => [item.id, reviewedContentHash(item)])),
      media: Object.fromEntries(catalogue.media.map((item) => [item.id, reviewedContentHash(item)])),
      exercises: Object.fromEntries(catalogue.exercises.map((item) => [item.id, exerciseContentHash(item)])),
      workouts: Object.fromEntries(catalogue.workouts.map((item) => [item.id, workoutContentHash(item)])),
    },
    musclesWithPrimaryExercises: primaryGroups.size,
    unmappedPrimaryMuscles: catalogue.muscles.filter((muscle) => !primaryGroups.has(muscle.id)).map((muscle) => muscle.id),
    publicationBlockers: publicationBlockers(catalogue),
  };
}
