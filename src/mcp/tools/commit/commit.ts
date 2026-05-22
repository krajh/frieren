import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";
import { embedTexts } from "../../../embedding/client.js";
import { extractAbstract, extractSummary } from "../../../tiering/extract.js";

const TARGET_EVENT_TYPES = ["decision", "milestone", "blocker"] as const;
const MAX_SESSIONS = 5;
const CLUSTER_THRESHOLD = 0.75;
const DEDUP_THRESHOLD = 0.85;

type TargetEventType = (typeof TARGET_EVENT_TYPES)[number];

type SessionRow = {
  id: string;
  started_at: string;
};

type EventRow = {
  id: string;
  session_id: string;
  event_type: TargetEventType;
  content: string;
  created_at: string;
  embedding_blob: unknown;
};

type EventWithEmbedding = Omit<EventRow, "embedding_blob"> & {
  embedding: Float32Array;
};

type Candidate = {
  representative_event_id: string;
  source_events: string[];
  source_sessions: string[];
  inferred_type: "decision" | "pattern" | "constraint" | "issue";
  content: string;
  confidence: number;
  cluster_similarity: {
    avg: number;
    min: number;
    max: number;
  };
  dedup_top_similarity: number | null;
  dedup_match_entry_id: string | null;
  dedup_status: "ok" | "unavailable" | "error";
  event_types: TargetEventType[];
  tags: string[];
  centroid: Float32Array;
};

type SessionWindowResult = {
  sessionIds: string[];
  anchorFound: boolean;
};

type GatherResult = {
  events: EventWithEmbedding[];
  dropped_due_missing_embedding: number;
  embedding_error: string | null;
};

const normalize = (value: Float32Array): Float32Array => {
  let sumSquares = 0;
  for (let i = 0; i < value.length; i++) {
    sumSquares += value[i]! * value[i]!;
  }

  if (sumSquares <= 0) return value;

  const norm = Math.sqrt(sumSquares);
  const out = new Float32Array(value.length);
  for (let i = 0; i < value.length; i++) {
    out[i] = value[i]! / norm;
  }

  return out;
};

const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const parseEmbedding = (input: unknown): Float32Array | null => {
  if (!input) return null;

  if (input instanceof Float32Array) {
    return input.length > 0 ? normalize(input) : null;
  }

  if (input instanceof Uint8Array) {
    if (input.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;

    const view = new Float32Array(
      input.buffer,
      input.byteOffset,
      input.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    return view.length > 0 ? normalize(new Float32Array(view)) : null;
  }

  if (input instanceof ArrayBuffer) {
    if (input.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
    const view = new Float32Array(input);
    return view.length > 0 ? normalize(view) : null;
  }

  if (Array.isArray(input)) {
    const values = input.filter((v): v is number => typeof v === "number");
    if (values.length === 0) return null;
    return normalize(Float32Array.from(values));
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        const values = parsed.filter((v): v is number => typeof v === "number");
        if (values.length > 0) {
          return normalize(Float32Array.from(values));
        }
      }
    } catch {
      // ignore malformed string payloads
    }
  }

  return null;
};

const centroidOf = (vectors: Float32Array[]): Float32Array => {
  if (vectors.length === 0) return new Float32Array(0);
  const dims = vectors[0]?.length ?? 0;
  const sum = new Float32Array(dims);

  for (const vector of vectors) {
    for (let i = 0; i < dims; i++) {
      const current = sum[i] ?? 0;
      sum[i] = current + (vector[i] ?? 0);
    }
  }

  const count = vectors.length;
  for (let i = 0; i < dims; i++) {
    const current = sum[i] ?? 0;
    sum[i] = current / count;
  }

  return normalize(sum);
};

const inferWisdomType = (
  eventTypes: TargetEventType[],
): "decision" | "pattern" | "constraint" | "issue" => {
  const counts: Record<TargetEventType, number> = {
    decision: 0,
    milestone: 0,
    blocker: 0,
  };

  for (const type of eventTypes) {
    counts[type] += 1;
  }

  if (
    counts.decision >= counts.milestone &&
    counts.decision >= counts.blocker
  ) {
    return "decision";
  }
  if (counts.blocker >= counts.decision && counts.blocker >= counts.milestone) {
    return "issue";
  }
  return "pattern";
};

const inferTags = (
  content: string,
  eventTypes: TargetEventType[],
): string[] => {
  const stopwords = new Set([
    "this",
    "that",
    "with",
    "from",
    "into",
    "have",
    "will",
    "were",
    "been",
    "about",
    "after",
    "before",
    "where",
    "when",
    "what",
    "which",
    "should",
    "could",
    "would",
    "their",
    "there",
    "then",
    "than",
    "your",
    "ours",
    "project",
    "session",
  ]);

  const tokenCounts = new Map<string, number>();
  const tokens = content.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];

  for (const token of tokens) {
    if (stopwords.has(token)) continue;
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }

  const ranked = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([token]) => token);

  return [
    "auto-extracted",
    "memory-commit",
    ...new Set(eventTypes.map((type) => `event:${type}`)),
    ...ranked,
  ];
};

const isValidProjectId = (projectId: string): boolean => {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(projectId)) {
    return false;
  }

  if (
    projectId.includes("..") ||
    projectId.includes("/") ||
    projectId.includes("\\")
  ) {
    return false;
  }

  return true;
};

const buildClusters = (events: EventWithEmbedding[]): number[][] => {
  const adjacency = new Map<number, Set<number>>();

  for (let i = 0; i < events.length; i++) {
    adjacency.set(i, new Set());
  }

  for (let i = 0; i < events.length; i++) {
    const left = events[i]!;
    for (let j = i + 1; j < events.length; j++) {
      const right = events[j]!;
      if (left.session_id === right.session_id) continue;

      const similarity = cosineSimilarity(left.embedding, right.embedding);
      if (similarity > CLUSTER_THRESHOLD) {
        adjacency.get(i)?.add(j);
        adjacency.get(j)?.add(i);
      }
    }
  }

  const clusters: number[][] = [];
  const visited = new Set<number>();

  for (let i = 0; i < events.length; i++) {
    if (visited.has(i)) continue;

    const stack = [i];
    const component: number[] = [];
    visited.add(i);

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;

      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }

    clusters.push(component);
  }

  return clusters;
};

const clusterSimilarityStats = (
  events: EventWithEmbedding[],
): {
  avg: number;
  min: number;
  max: number;
} => {
  if (events.length <= 1) {
    return { avg: 1, min: 1, max: 1 };
  }

  const sims: number[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      sims.push(cosineSimilarity(events[i]!.embedding, events[j]!.embedding));
    }
  }

  if (sims.length === 0) {
    return { avg: 1, min: 1, max: 1 };
  }

  const total = sims.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / sims.length,
    min: Math.min(...sims),
    max: Math.max(...sims),
  };
};

const minCrossSessionSimilarity = (events: EventWithEmbedding[]): number => {
  if (events.length <= 1) return 1;

  let min = 1;
  let foundCrossSessionPair = false;

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (events[i]!.session_id === events[j]!.session_id) continue;
      foundCrossSessionPair = true;
      const sim = cosineSimilarity(events[i]!.embedding, events[j]!.embedding);
      if (sim < min) {
        min = sim;
      }
    }
  }

  return foundCrossSessionPair ? min : 1;
};

const pickRepresentative = (
  events: EventWithEmbedding[],
  centroid: Float32Array,
): EventWithEmbedding => {
  let best = events[0]!;
  let bestScore = cosineSimilarity(best.embedding, centroid);

  for (let i = 1; i < events.length; i++) {
    const event = events[i]!;
    const score = cosineSimilarity(event.embedding, centroid);
    if (score > bestScore) {
      best = event;
      bestScore = score;
    }
  }

  return best;
};

const getSessionWindow = (
  projectDb: ReturnType<typeof initDb>["db"],
  projectId: string,
  sessionId?: string,
): SessionWindowResult => {
  if (sessionId) {
    const anchor = projectDb
      .query<SessionRow, [string, string]>(
        `SELECT id, started_at FROM sessions
         WHERE project_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(projectId, sessionId);

    if (anchor) {
      return {
        sessionIds: projectDb
          .query<SessionRow, [string, string, number]>(
            `SELECT id, started_at FROM sessions
           WHERE project_id = ? AND started_at <= ?
           ORDER BY started_at DESC
           LIMIT ?`,
          )
          .all(projectId, anchor.started_at, MAX_SESSIONS)
          .map((row) => row.id),
        anchorFound: true,
      };
    }

    return { sessionIds: [], anchorFound: false };
  }

  return {
    sessionIds: projectDb
      .query<SessionRow, [string, number]>(
        `SELECT id, started_at FROM sessions
         WHERE project_id = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(projectId, MAX_SESSIONS)
      .map((row) => row.id),
    anchorFound: true,
  };
};

const gatherEventsWithEmbeddings = async (
  projectDb: ReturnType<typeof initDb>["db"],
  sessionIds: string[],
): Promise<GatherResult> => {
  if (sessionIds.length === 0) {
    return {
      events: [],
      dropped_due_missing_embedding: 0,
      embedding_error: null,
    };
  }

  const placeholders = sessionIds.map(() => "?").join(",");
  let rows: EventRow[] = [];

  try {
    rows = projectDb
      .query<EventRow, string[]>(
        `SELECT se.id,
                se.session_id,
                se.event_type,
                se.content,
                se.created_at,
                sv.embedding AS embedding_blob
         FROM session_events se
         LEFT JOIN session_vec sv ON sv.event_id = se.id
         WHERE se.session_id IN (${placeholders})
           AND se.event_type IN ('decision', 'milestone', 'blocker')
         ORDER BY se.created_at DESC`,
      )
      .all(...sessionIds);
  } catch {
    rows = projectDb
      .query<Omit<EventRow, "embedding_blob">, string[]>(
        `SELECT se.id,
                se.session_id,
                se.event_type,
                se.content,
                se.created_at
         FROM session_events se
         WHERE se.session_id IN (${placeholders})
           AND se.event_type IN ('decision', 'milestone', 'blocker')
         ORDER BY se.created_at DESC`,
      )
      .all(...sessionIds)
      .map((row) => ({ ...row, embedding_blob: null }));
  }

  const missingTexts: string[] = [];
  const missingIndexByEventId = new Map<string, number>();
  const eventEmbeddings = new Map<string, Float32Array>();

  for (const row of rows) {
    const parsed = parseEmbedding(row.embedding_blob);
    if (parsed) {
      eventEmbeddings.set(row.id, parsed);
      continue;
    }

    missingIndexByEventId.set(row.id, missingTexts.length);
    missingTexts.push(row.content);
  }

  if (missingTexts.length > 0) {
    const { vectors, error } = await embedTexts(missingTexts);
    if (!error) {
      for (const row of rows) {
        const index = missingIndexByEventId.get(row.id);
        if (index === undefined) continue;

        const vector = vectors[index];
        if (vector && vector.length > 0) {
          eventEmbeddings.set(row.id, normalize(vector));
        }
      }
    }

    const events = rows
      .map((row) => {
        const embedding = eventEmbeddings.get(row.id);
        if (!embedding) return null;

        return {
          id: row.id,
          session_id: row.session_id,
          event_type: row.event_type,
          content: row.content,
          created_at: row.created_at,
          embedding,
        } satisfies EventWithEmbedding;
      })
      .filter((row): row is EventWithEmbedding => row !== null);

    return {
      events,
      dropped_due_missing_embedding: rows.length - events.length,
      embedding_error: error ?? null,
    };
  }

  const events = rows
    .map((row) => {
      const embedding = eventEmbeddings.get(row.id);
      if (!embedding) return null;

      return {
        id: row.id,
        session_id: row.session_id,
        event_type: row.event_type,
        content: row.content,
        created_at: row.created_at,
        embedding,
      } satisfies EventWithEmbedding;
    })
    .filter((row): row is EventWithEmbedding => row !== null);

  return {
    events,
    dropped_due_missing_embedding: rows.length - events.length,
    embedding_error: null,
  };
};

const buildCandidates = (events: EventWithEmbedding[]): Candidate[] => {
  const clusters = buildClusters(events);
  const candidates: Candidate[] = [];

  for (const cluster of clusters) {
    const clusterEvents = cluster.map((index) => events[index]!);
    const sessionCount = new Set(clusterEvents.map((event) => event.session_id))
      .size;

    if (sessionCount < 2) continue;
    if (minCrossSessionSimilarity(clusterEvents) <= CLUSTER_THRESHOLD) continue;

    const centroid = centroidOf(clusterEvents.map((event) => event.embedding));
    const representative = pickRepresentative(clusterEvents, centroid);
    const eventTypes = clusterEvents.map((event) => event.event_type);

    candidates.push({
      representative_event_id: representative.id,
      source_events: clusterEvents.map((event) => event.id),
      source_sessions: [
        ...new Set(clusterEvents.map((event) => event.session_id)),
      ],
      inferred_type: inferWisdomType(eventTypes),
      content: representative.content,
      confidence: 0.6,
      cluster_similarity: clusterSimilarityStats(clusterEvents),
      dedup_top_similarity: null,
      dedup_match_entry_id: null,
      dedup_status: "ok",
      event_types: eventTypes,
      tags: inferTags(representative.content, eventTypes),
      centroid,
    });
  }

  return candidates;
};

const dedupAgainstWisdom = (
  wisdomDb: ReturnType<typeof initDb>["db"],
  vecLoaded: boolean,
  projectId: string,
  candidate: Candidate,
): Candidate => {
  if (!vecLoaded || candidate.centroid.length === 0) {
    return {
      ...candidate,
      dedup_status: "unavailable",
    };
  }

  try {
    type WisdomHit = {
      entry_id: string;
      distance: number;
    };

    const topHit = wisdomDb
      .query<WisdomHit, [Uint8Array, string]>(
        `SELECT wv.entry_id, vec_distance_cosine(wv.embedding, ?) AS distance
         FROM wisdom_vec wv
         JOIN wisdom_entries we ON we.id = wv.entry_id
         WHERE (we.status IS NULL OR we.status = 'active')
           AND we.project_id = ?
         ORDER BY distance
         LIMIT 1`,
      )
      .get(new Uint8Array(candidate.centroid.buffer), projectId);

    if (!topHit) {
      return {
        ...candidate,
        dedup_status: "ok",
      };
    }

    return {
      ...candidate,
      dedup_top_similarity: 1 - topHit.distance,
      dedup_match_entry_id: topHit.entry_id,
      dedup_status: "ok",
    };
  } catch {
    return {
      ...candidate,
      dedup_status: "error",
    };
  }
};

// --- KG helpers for structural metadata ---

const upsertEntity = (
  db: ReturnType<typeof initDb>["db"],
  name: string,
  entityType: string,
  projectId: string | undefined,
): string => {
  const existing = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM kg_entities WHERE name = ? AND type = ? LIMIT 1`,
    )
    .get(name, entityType);
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO kg_entities (id, name, type, attributes, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, entityType, null, projectId ?? null, now, now],
  );
  return id;
};

const addKGTriple = (
  db: ReturnType<typeof initDb>["db"],
  subjectId: string,
  predicate: string,
  objectId: string | null,
  objectValue: string | null,
  confidence: number,
  source: string,
  projectId: string | undefined,
): void => {
  // Skip if an identical active triple already exists
  if (objectId) {
    const existing = db
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM kg_triples WHERE subject_id = ? AND predicate = ? AND object_id = ? AND valid_to IS NULL LIMIT 1`,
      )
      .get(subjectId, predicate, objectId);
    if (existing) return;
  } else if (objectValue) {
    const existing = db
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM kg_triples WHERE subject_id = ? AND predicate = ? AND object_value = ? AND valid_to IS NULL LIMIT 1`,
      )
      .get(subjectId, predicate, objectValue);
    if (existing) return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO kg_triples
      (id, subject_id, predicate, object_id, object_value, valid_from, valid_to, confidence, source, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, subjectId, predicate, objectId, objectValue, now, null, confidence, source, projectId ?? null, now],
  );
};

const promoteCandidate = (
  wisdomDb: ReturnType<typeof initDb>["db"],
  candidate: Candidate,
  projectId: string,
): string => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  wisdomDb.run(
    `INSERT INTO wisdom_entries
      (id, type, content, abstract, summary, confidence, source_agent, evidence, tags, project_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      candidate.inferred_type,
      candidate.content,
      extractAbstract(candidate.content, "text"),
      extractSummary(candidate.content, "text"),
      0.6,
      "auto-extract",
      JSON.stringify(candidate.source_events),
      JSON.stringify(candidate.tags),
      projectId,
      "active",
      now,
      now,
    ],
  );

  if (candidate.centroid.length > 0) {
    try {
      wisdomDb.run(
        `INSERT OR REPLACE INTO wisdom_vec(entry_id, embedding) VALUES (?, ?)`,
        [id, new Uint8Array(candidate.centroid.buffer)],
      );
    } catch {
      // Non-fatal vector write failure
    }
  }

  // Add KG structural metadata
  if (projectId) {
    try {
      const SKIP_TAGS = new Set(["auto-extracted", "memory-commit"]);
      const meaningfulTags = candidate.tags.filter(
        (t) => t && !SKIP_TAGS.has(t) && !t.startsWith("event:"),
      );

      const projectEntityId = upsertEntity(wisdomDb, projectId, "project", projectId);

      // Link project to each meaningful tag
      for (const tag of meaningfulTags) {
        const tagEntityId = upsertEntity(wisdomDb, tag, "topic", projectId);
        addKGTriple(
          wisdomDb,
          projectEntityId,
          "relates_to",
          tagEntityId,
          null,
          0.6,
          "memory-commit",
          projectId,
        );
      }

      // Record the wisdom type as a project attribute
      addKGTriple(
        wisdomDb,
        projectEntityId,
        "has_wisdom_type",
        null,
        candidate.inferred_type,
        0.8,
        "memory-commit",
        projectId,
      );
    } catch {
      // Non-fatal: KG population failure should not block wisdom promotion
    }
  }

  return id;
};

export const registerMemoryCommitTool = (server: McpServer): void => {
  server.registerTool(
    "memory_commit",
    {
      description:
        "Analyze recurring session patterns and auto-promote durable wisdom entries.",
      inputSchema: {
        project_id: z.string().describe("Project ID to analyze"),
        session_id: z
          .string()
          .optional()
          .describe("Optional anchor session ID for the analysis window"),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, return candidates without writing wisdom"),
      },
    },
    async (args) => {
      const { project_id, session_id, dry_run = false } = args;

      if (!isValidProjectId(project_id)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Invalid project_id format",
                project_id,
              }),
            },
          ],
        };
      }

      const sessionDb = initDb("session", project_id);
      const wisdomDb = initDb("wisdom");

      try {
        const window = getSessionWindow(sessionDb.db, project_id, session_id);
        if (session_id && !window.anchorFound) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  project_id,
                  dry_run,
                  error: "Provided session_id was not found for this project",
                  session_id,
                }),
              },
            ],
          };
        }

        const gather = await gatherEventsWithEmbeddings(
          sessionDb.db,
          window.sessionIds,
        );
        const { events } = gather;
        const warnings: string[] = [];

        if (gather.embedding_error) {
          warnings.push(
            "Embedding generation failed for some events; candidates may be incomplete.",
          );
        }
        if (gather.dropped_due_missing_embedding > 0) {
          warnings.push(
            `${gather.dropped_due_missing_embedding} events were skipped due to missing embeddings.`,
          );
        }

        let livePromotionBlocked = !dry_run && !wisdomDb.vecLoaded;
        if (!wisdomDb.vecLoaded) {
          warnings.push(
            "Wisdom vector index is unavailable; deduplication against existing wisdom is degraded.",
          );
        }

        if (events.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  project_id,
                  dry_run,
                  sessions_scanned: window.sessionIds.length,
                  events_scanned: 0,
                  dropped_due_missing_embedding:
                    gather.dropped_due_missing_embedding,
                  warnings,
                  candidates: [],
                  promoted: [],
                  skipped_duplicates: [],
                  summary:
                    gather.embedding_error ||
                    gather.dropped_due_missing_embedding > 0
                      ? "No eligible events with embeddings were available for memory commit."
                      : "No eligible events found for memory commit.",
                }),
              },
            ],
          };
        }

        const rawCandidates = buildCandidates(events);
        const enrichedCandidates = rawCandidates.map((candidate) =>
          dedupAgainstWisdom(
            wisdomDb.db,
            wisdomDb.vecLoaded,
            project_id,
            candidate,
          ),
        );

        const dedupFailures = enrichedCandidates.filter(
          (candidate) => candidate.dedup_status === "error",
        ).length;
        if (dedupFailures > 0) {
          warnings.push(
            `${dedupFailures} candidates could not be deduplicated due to wisdom vector query errors.`,
          );
          livePromotionBlocked = !dry_run;
        }

        const toPromote = enrichedCandidates.filter((candidate) => {
          if (candidate.dedup_status !== "ok") return false;
          const score = candidate.dedup_top_similarity;
          return score === null || score <= DEDUP_THRESHOLD;
        });

        const skippedDuplicates = enrichedCandidates
          .filter((candidate) => {
            const score = candidate.dedup_top_similarity;
            return score !== null && score > DEDUP_THRESHOLD;
          })
          .map((candidate) => ({
            representative_event_id: candidate.representative_event_id,
            dedup_top_similarity: candidate.dedup_top_similarity,
            dedup_match_entry_id: candidate.dedup_match_entry_id,
          }));

        const promoted: Array<{
          wisdom_id: string;
          representative_event_id: string;
          type: string;
          confidence: number;
          source_events: string[];
          tags: string[];
        }> = [];

        if (!dry_run && !livePromotionBlocked) {
          wisdomDb.db.exec("BEGIN");
          try {
            for (const candidate of toPromote) {
              const wisdomId = promoteCandidate(
                wisdomDb.db,
                candidate,
                project_id,
              );
              promoted.push({
                wisdom_id: wisdomId,
                representative_event_id: candidate.representative_event_id,
                type: candidate.inferred_type,
                confidence: candidate.confidence,
                source_events: candidate.source_events,
                tags: candidate.tags,
              });
            }
            wisdomDb.db.exec("COMMIT");
          } catch {
            wisdomDb.db.exec("ROLLBACK");
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    project_id,
                    dry_run,
                    error:
                      "memory_commit failed during promotion transaction; no entries were committed.",
                  }),
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                project_id,
                dry_run,
                sessions_scanned: window.sessionIds.length,
                events_scanned: events.length,
                dropped_due_missing_embedding:
                  gather.dropped_due_missing_embedding,
                warnings,
                clustering: {
                  threshold: CLUSTER_THRESHOLD,
                  min_sessions_for_candidate: 2,
                },
                dedup: {
                  threshold: DEDUP_THRESHOLD,
                },
                live_promotion_blocked: livePromotionBlocked,
                candidates: enrichedCandidates.map((candidate) => ({
                  content: candidate.content,
                  type: candidate.inferred_type,
                  confidence: candidate.confidence,
                  source_events: candidate.source_events,
                  source_sessions: candidate.source_sessions,
                  similarity_scores: {
                    cluster: candidate.cluster_similarity,
                    dedup_top_similarity: candidate.dedup_top_similarity,
                  },
                  dedup_status: candidate.dedup_status,
                  dedup_match_entry_id: candidate.dedup_match_entry_id,
                  tags: candidate.tags,
                })),
                promoted,
                skipped_duplicates: skippedDuplicates,
                summary: dry_run
                  ? `Dry run complete: ${toPromote.length} promotable candidates, ${skippedDuplicates.length} deduped.`
                  : livePromotionBlocked
                    ? "Promotion blocked: wisdom vector index unavailable, dedup safety gate prevented writes."
                    : `Promotion complete: ${promoted.length} new wisdom entries, ${skippedDuplicates.length} deduped.`,
              }),
            },
          ],
        };
      } finally {
        sessionDb.db.close();
        wisdomDb.db.close();
      }
    },
  );
};
