/**
 * Review dossier, decision sheet and decision application.
 *
 * The publication gate in `catalogue-policy.ts` needs one approval record per
 * source, media asset, exercise and workout, each carrying the exact content
 * hash of the thing approved. Transcribing those by hand is error-prone and a
 * single wrong character fails publication with an unhelpful message.
 *
 * This module removes the clerical half of that work and nothing else. It
 * decides no content: reading an exercise and judging whether its instructions
 * are safe is the reviewer's job, and recording that judgement honestly is the
 * only thing the gate is for.
 */
import {
  catalogueReport,
  validateTrainingCatalogue,
} from './catalogue-policy.js';
import type {
  TrainingCatalogue,
  TrainingExercise,
  TrainingWorkout,
} from './catalogue.schema.js';

export type ReviewRecordKind = 'source' | 'media' | 'exercise' | 'workout';

export interface ReviewDecision {
  kind: ReviewRecordKind;
  id: string;
  /** The hash the reviewer saw. Empty means "not carried back from the sheet". */
  contentHash: string;
  /**
   * The literal verdict. Kept alongside [approved] because a blank row and a
   * rejection are both "not approved" but mean different things when carrying
   * decisions into the next round.
   */
  verdict: 'approve' | 'reject' | 'none';
  approved: boolean;
  notes: string;
  /** 1-based sheet line, for error messages that point at a row. */
  line: number;
}

export interface ApplyReviewInput {
  source: TrainingCatalogue;
  decisions: readonly ReviewDecision[];
  reviewer: string;
  evidence: string;
  reviewedAt: string;
  releaseId: string;
  catalogueVersion: number;
}

export interface ApplyReviewResult {
  catalogue: TrainingCatalogue;
  applied: string[];
  notApproved: string[];
}

export class ReviewSheetError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('\n  '));
    this.name = 'ReviewSheetError';
  }
}

type CatalogueReport = ReturnType<typeof catalogueReport>;

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Quotes only when it has to, so the sheet stays readable in a text editor. */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Minimal RFC 4180 reader: quoted fields, embedded commas, newlines, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

const KINDS = new Set<string>(['source', 'media', 'exercise', 'workout']);
const APPROVE = new Set(['approve', 'approved', 'yes', 'y']);
const REJECT = new Set(['reject', 'rejected', 'no', 'n']);

export function parseDecisionSheet(text: string): ReviewDecision[] {
  return decisionsFromRows(parseCsv(text));
}

/**
 * The row form, so a sheet can arrive as CSV or as the matrix a spreadsheet
 * reader hands back. Excel rewrites a CSV as `.xlsx` at the slightest
 * provocation, and a reviewer should not have to fight the Save dialog.
 */
export function decisionsFromRows(rows: readonly string[][]): ReviewDecision[] {
  if (!rows.length) throw new ReviewSheetError(['the decision sheet is empty']);

  const header = (rows[0] ?? []).map((value) => value.trim());
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) {
      throw new ReviewSheetError([`the decision sheet has no "${name}" column`]);
    }
    return index;
  };
  const kindAt = column('kind');
  const idAt = column('id');
  const hashAt = column('contentHash');
  const decisionAt = column('decision');
  const notesAt = header.indexOf('notes');

  const decisions: ReviewDecision[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const line = index + 1;
    const kind = (row[kindAt] ?? '').trim();
    const id = (row[idAt] ?? '').trim();
    const raw = (row[decisionAt] ?? '').trim().toLowerCase();

    if (!KINDS.has(kind)) {
      problems.push(`line ${line}: unknown kind "${kind}"`);
      continue;
    }
    if (!id) {
      problems.push(`line ${line}: missing id`);
      continue;
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) {
      problems.push(`line ${line}: ${key} appears more than once`);
      continue;
    }
    seen.add(key);

    // An unrecognised decision is a typo. Treating it as "not approved" would
    // quietly drop an approval the reviewer believes they recorded.
    if (raw !== '' && !APPROVE.has(raw) && !REJECT.has(raw)) {
      problems.push(`line ${line}: decision "${raw}" is neither approve nor reject`);
      continue;
    }

    decisions.push({
      kind: kind as ReviewRecordKind,
      id,
      contentHash: (row[hashAt] ?? '').trim(),
      verdict: APPROVE.has(raw) ? 'approve' : REJECT.has(raw) ? 'reject' : 'none',
      approved: APPROVE.has(raw),
      notes: notesAt >= 0 ? (row[notesAt] ?? '').trim() : '',
      line,
    });
  }

  if (problems.length) throw new ReviewSheetError(problems);
  return decisions;
}

export interface CarryForwardSummary {
  carried: number;
  needsReview: string[];
}

/**
 * Carries a previous round's decisions into a new sheet, but only for records
 * whose content is byte-identical.
 *
 * Without this, correcting one exercise sends all forty back for review and
 * nobody would run the process twice. The hash is what makes it safe: a
 * decision moves forward only when the reviewer would be looking at exactly
 * the same content, and anything edited since comes back blank.
 */
export function buildDecisionSheet(
  catalogue: TrainingCatalogue,
  report: CatalogueReport,
  carryForward: readonly ReviewDecision[] = [],
  summary?: CarryForwardSummary,
): string {
  const previous = new Map<string, ReviewDecision>(
    carryForward.map((decision) => [
      `${decision.kind}:${decision.id}:${decision.contentHash}`,
      decision,
    ]),
  );

  const rows: string[][] = [
    ['kind', 'id', 'name', 'contentHash', 'decision', 'notes'],
  ];

  const push = (
    kind: ReviewRecordKind,
    id: string,
    name: string,
    hash: string,
  ): void => {
    const prior = previous.get(`${kind}:${id}:${hash}`);
    if (prior && prior.verdict !== 'none') {
      rows.push([kind, id, name, hash, prior.verdict, prior.notes]);
      if (summary) summary.carried += 1;
      return;
    }
    rows.push([kind, id, name, hash, '', '']);
    if (summary) summary.needsReview.push(`${kind} ${id}`);
  };

  for (const source of catalogue.sources) {
    push('source', source.id, source.name, report.reviewHashes.sources[source.id] ?? '');
  }
  for (const asset of catalogue.media) {
    push('media', asset.id, asset.url, report.reviewHashes.media[asset.id] ?? '');
  }
  for (const exercise of catalogue.exercises) {
    push('exercise', exercise.id, exercise.name, report.reviewHashes.exercises[exercise.id] ?? '');
  }
  for (const workout of catalogue.workouts) {
    push('workout', workout.id, workout.name, report.reviewHashes.workouts[workout.id] ?? '');
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Applying decisions
// ---------------------------------------------------------------------------

function hashesFor(
  report: CatalogueReport,
  kind: ReviewRecordKind,
): Record<string, string> {
  switch (kind) {
    case 'source':
      return report.reviewHashes.sources;
    case 'media':
      return report.reviewHashes.media;
    case 'exercise':
      return report.reviewHashes.exercises;
    case 'workout':
      return report.reviewHashes.workouts;
  }
}

/** Sources and media record `rights`; exercises and workouts record `review`. */
function approvalField(kind: ReviewRecordKind): 'rights' | 'review' {
  return kind === 'source' || kind === 'media' ? 'rights' : 'review';
}

function collectionFor(
  catalogue: TrainingCatalogue,
  kind: ReviewRecordKind,
): Array<Record<string, unknown>> {
  switch (kind) {
    case 'source':
      return catalogue.sources as unknown as Array<Record<string, unknown>>;
    case 'media':
      return catalogue.media as unknown as Array<Record<string, unknown>>;
    case 'exercise':
      return catalogue.exercises as unknown as Array<Record<string, unknown>>;
    case 'workout':
      return catalogue.workouts as unknown as Array<Record<string, unknown>>;
  }
}

/**
 * Copies [ApplyReviewInput.source] under a new release identity and stamps the
 * approvals the reviewer actually granted.
 *
 * Deliberate refusals:
 *  * a row whose `contentHash` no longer matches the live content — the review
 *    happened against something that has since changed, and reattaching the
 *    old decision is exactly the staleness the gate's hashes exist to catch;
 *  * reusing the input's release identity, since a staged snapshot is immutable;
 *  * a `catalogueVersion` that could not replace a newer active snapshot.
 *
 * A row with no decision stays pending, so publication fails and names it.
 * Nothing here invents a reviewer, a timestamp or evidence.
 */
export function applyReviewDecisions(
  input: ApplyReviewInput,
): ApplyReviewResult {
  const { source } = input;

  if (!input.reviewer.trim()) throw new ReviewSheetError(['a reviewer is required']);
  if (!input.evidence.trim()) throw new ReviewSheetError(['evidence is required']);
  if (Number.isNaN(Date.parse(input.reviewedAt))) {
    throw new ReviewSheetError(['reviewedAt must be an ISO-8601 timestamp']);
  }
  if (input.releaseId === source.releaseId) {
    throw new ReviewSheetError([
      `releaseId must differ from the input release "${source.releaseId}": a staged ` +
        'snapshot is immutable, so corrected content needs a new identity',
    ]);
  }
  if (input.catalogueVersion <= source.catalogueVersion) {
    throw new ReviewSheetError([
      `catalogueVersion must be greater than the input version ${source.catalogueVersion}, ` +
        'or it cannot replace a newer active snapshot',
    ]);
  }

  const report = catalogueReport(source);
  const next = JSON.parse(JSON.stringify(source)) as TrainingCatalogue;
  (next as { releaseId: string }).releaseId = input.releaseId;
  (next as { catalogueVersion: number }).catalogueVersion = input.catalogueVersion;

  const problems: string[] = [];
  const applied: string[] = [];
  const notApproved: string[] = [];

  for (const decision of input.decisions) {
    const record = collectionFor(next, decision.kind).find(
      (item) => item['id'] === decision.id,
    );
    if (!record) {
      problems.push(
        `line ${decision.line}: no ${decision.kind} "${decision.id}" in the input catalogue`,
      );
      continue;
    }

    const expected = hashesFor(report, decision.kind)[decision.id];
    if (!expected) {
      problems.push(
        `line ${decision.line}: no content hash computed for ${decision.kind} "${decision.id}"`,
      );
      continue;
    }
    if (decision.contentHash && decision.contentHash !== expected) {
      problems.push(
        `line ${decision.line}: ${decision.kind} "${decision.id}" changed since the dossier ` +
          'was exported — re-export and review the new content',
      );
      continue;
    }

    if (!decision.approved) {
      notApproved.push(
        `${decision.kind} ${decision.id}${decision.notes ? ` — ${decision.notes}` : ''}`,
      );
      continue;
    }

    record[approvalField(decision.kind)] = {
      status: 'approved',
      reviewer: input.reviewer,
      reviewedAt: input.reviewedAt,
      evidence: input.evidence,
      approvedContentHash: expected,
    };
    applied.push(`${decision.kind} ${decision.id}`);
  }

  if (problems.length) throw new ReviewSheetError(problems);

  // Back through the real schema, so a malformed result surfaces here rather
  // than in the importer.
  return {
    catalogue: validateTrainingCatalogue(next),
    applied,
    notApproved,
  };
}

// ---------------------------------------------------------------------------
// Dossier
// ---------------------------------------------------------------------------

function labelMap<T extends { id: string; name: string }>(
  items: readonly T[],
): Map<string, string> {
  return new Map(items.map((item) => [item.id, item.name]));
}

function named(ids: readonly string[], labels: Map<string, string>): string {
  if (!ids.length) return '—';
  return ids.map((id) => `${labels.get(id) ?? id} (\`${id}\`)`).join(', ');
}

/**
 * Renders the locked AND/OR rule as prose. Someone checking equipment needs to
 * read "one of A or B, and one of C" rather than decode nested JSON.
 */
function equipmentProse(
  exercise: TrainingExercise,
  equipment: Map<string, string>,
): string {
  if (exercise.equipmentStatus === 'unknown') {
    return '**Unknown** — requirements not established (not the same as "none")';
  }
  if (!exercise.equipmentRequirementGroups.length) return 'None required';
  return exercise.equipmentRequirementGroups
    .map((group) => {
      const options = group.anyOf
        .map((id) => `${equipment.get(id) ?? id} (\`${id}\`)`)
        .join(' **or** ');
      return group.anyOf.length > 1 ? `(${options})` : options;
    })
    .join(' **and** ');
}

function bullets(lines: readonly string[]): string {
  if (!lines.length) return '_none_\n';
  return `${lines.map((line) => `- ${line}`).join('\n')}\n`;
}

function numbered(lines: readonly string[]): string {
  if (!lines.length) return '_none_\n';
  return `${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}\n`;
}

const ATTESTATION = [
  '## What approving an exercise attests to',
  '',
  'Approving means you have read the record and confirm, to the best of your',
  'professional judgement:',
  '',
  '1. **The instructions are safe and correct.** Someone following them',
  '   unsupervised performs the movement the name describes, and no cue',
  '   encourages a position that risks injury.',
  '2. **The name and variant identity are right.** This is the exercise it',
  '   claims to be and not a near neighbour, and the aliases are real names for',
  '   it rather than for a different movement.',
  '3. **The targets are right.** Primary muscles are the ones actually doing the',
  '   work; secondary are genuinely involved. A wrong primary target silently',
  '   corrupts every muscle filter and the body map.',
  '4. **The equipment is right.** Required groups are genuinely required and the',
  '   alternatives within a group are interchangeable for this movement.',
  '   Optional means the exercise works without it.',
  '5. **The measurement makes sense.** Reps for countable movements, duration',
  '   for holds, per-side where each side is worked separately.',
  '6. **Easier and harder links are ordered correctly.**',
  '',
  'If any of those is wrong, mark `reject` and say why in the notes. Fix the',
  'content at source and re-export — never approve with a caveat, because',
  'nothing downstream reads the notes.',
  '',
  '## Source rights',
  '',
  'Approving a source attests that its recorded licence and evidence permit',
  'publishing and distributing the content in the app. For app-authored',
  'originals that is a statement about your own work. For anything else it is a',
  'statement about a licence you can produce on request. Media assets carry',
  'their own rights record and are approved independently — public availability',
  'is not permission.',
  '',
  '---',
  '',
].join('\n');

export function buildReviewDossier(
  catalogue: TrainingCatalogue,
  report: CatalogueReport,
): string {
  const muscles = labelMap(catalogue.muscles);
  const equipment = labelMap(catalogue.equipment);
  const exerciseNames = labelMap(catalogue.exercises);

  const exerciseSection = (exercise: TrainingExercise): string => {
    const facts = [
      `**Difficulty** ${exercise.difficulty}`,
      `**Type** ${exercise.trainingType}`,
      `**Loading** ${exercise.loadingMode}`,
      `**Measured in** ${exercise.measurementType}`,
      `**Per side** ${exercise.unilateral ? 'yes' : 'no'}`,
      `**Pattern** ${exercise.movementPatternIds.join(', ') || '—'}`,
    ].join(' · ');

    return [
      `### \`${exercise.id}\` — ${exercise.name}`,
      '',
      `Record version ${exercise.version} · source \`${exercise.sourceId}\` · content hash \`${report.reviewHashes.exercises[exercise.id] ?? ''}\``,
      '',
      facts,
      '',
      `**Also called** ${exercise.aliases.length ? exercise.aliases.join(', ') : '—'}`,
      '',
      `**Primary targets** ${named(exercise.primaryMuscleIds, muscles)}`,
      '',
      `**Secondary targets** ${named(exercise.secondaryMuscleIds, muscles)}`,
      '',
      `**Equipment required** ${equipmentProse(exercise, equipment)}`,
      '',
      `**Equipment optional** ${named(exercise.optionalEquipmentIds, equipment)}`,
      '',
      '**Instructions**',
      '',
      numbered(exercise.instructions),
      '**Form cues**',
      '',
      bullets(exercise.formCues),
      '**Common mistakes**',
      '',
      bullets(exercise.commonMistakes),
      `**Easier** ${named(exercise.regressionIds, exerciseNames)}`,
      '',
      `**Harder** ${named(exercise.progressionIds, exerciseNames)}`,
      '',
      `**Swap for** ${named(exercise.substitutionIds, exerciseNames)}`,
      '',
      `**Media** ${exercise.mediaIds.length ? exercise.mediaIds.join(', ') : 'none'}`,
      '',
      '---',
      '',
    ].join('\n');
  };

  const workoutSection = (workout: TrainingWorkout): string => {
    const blocks = workout.blocks.map((block) => {
      const items = block.items.map((item) => {
        const prescription: string[] = [];
        if (item.sets) prescription.push(`${item.sets} set(s)`);
        if (item.reps) prescription.push(`${item.reps} reps`);
        if (item.durationSec) prescription.push(`${item.durationSec}s hold`);
        if (item.perSide) prescription.push('per side');
        if (item.restSec) prescription.push(`${item.restSec}s rest`);
        const name = exerciseNames.get(item.exerciseId) ?? item.exerciseId;
        return `  - ${name} (\`${item.exerciseId}\` v${item.exerciseVersion}) — ${prescription.join(', ')}`;
      });
      return [
        `- **${block.type}** block \`${block.id}\`, ${block.rounds} round(s)`,
        ...items,
      ].join('\n');
    });

    return [
      `### \`${workout.id}\` — ${workout.name}`,
      '',
      `Record version ${workout.version} · source \`${workout.sourceId}\` · content hash \`${report.reviewHashes.workouts[workout.id] ?? ''}\``,
      '',
      `**Difficulty** ${workout.difficulty} · **Type** ${workout.trainingType} · **Estimated** ${workout.estimatedDurationMin} min`,
      '',
      '**Structure**',
      '',
      `${blocks.join('\n')}\n`,
      '---',
      '',
    ].join('\n');
  };

  const header = [
    `# Training content review — \`${catalogue.releaseId}\``,
    '',
    `Catalogue version ${catalogue.catalogueVersion} · release hash \`${report.hash}\``,
    '',
    `${catalogue.exercises.length} exercises · ${catalogue.workouts.length} workouts · ` +
      `${catalogue.sources.length} sources · ${catalogue.media.length} media assets · ` +
      `${report.publicationBlockers.length} publication blockers`,
    '',
    'Record decisions in the matching `-decisions.csv`, then run',
    '`npm run review:training:apply`. Nothing here is approved yet.',
    '',
    ATTESTATION,
  ].join('\n');

  const sources = catalogue.sources
    .map((source) =>
      [
        `### \`${source.id}\` — ${source.name}`,
        '',
        `Kind \`${source.kind}\` · version \`${source.version}\` · content hash \`${report.reviewHashes.sources[source.id] ?? ''}\``,
        '',
        `**Locator** ${source.locator ?? '—'}`,
        '',
        `**Licence** ${source.licence ?? '—'}`,
        '',
        `**Attribution** ${source.attribution ?? '—'}`,
        '',
        '---',
        '',
      ].join('\n'),
    )
    .join('\n');

  const media = catalogue.media.length
    ? catalogue.media
        .map((asset) =>
          [
            `### \`${asset.id}\``,
            '',
            `Status \`${asset.status}\` · source \`${asset.sourceId}\` · content hash \`${report.reviewHashes.media[asset.id] ?? ''}\``,
            '',
            `**URL** ${asset.url}`,
            '',
            '---',
            '',
          ].join('\n'),
        )
        .join('\n')
    : '_No media assets in this release._\n\n';

  return [
    header,
    '## Sources\n',
    sources,
    '## Media\n',
    media,
    '## Exercises\n',
    catalogue.exercises.map(exerciseSection).join('\n'),
    '## Workouts\n',
    catalogue.workouts.map(workoutSection).join('\n'),
  ].join('\n');
}
