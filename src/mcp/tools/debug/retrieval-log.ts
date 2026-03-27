import { initDb } from "../../../db/init.js";

export type RetrievalTrajectoryHit = {
  id: string;
  score: number;
  source?: string;
  plane?: "wisdom" | "session" | "codebase";
};

export type RetrievalGraphExpansion = {
  from_id: string;
  to_id: string;
  relation: string;
  plane?: "wisdom" | "session" | "codebase";
};

export type RetrievalTrajectory = {
  vector_hits: RetrievalTrajectoryHit[];
  keyword_hits: RetrievalTrajectoryHit[];
  graph_expansions: RetrievalGraphExpansion[];
  directories_visited: string[];
  final_results: RetrievalTrajectoryHit[];
};

export type RetrievalLogInput = {
  query: string;
  planesSearched: Array<"wisdom" | "session" | "codebase">;
  resultsCount: number;
  graphExpansions: number;
  trajectory: RetrievalTrajectory;
  durationMs: number;
};

export const createEmptyTrajectory = (): RetrievalTrajectory => ({
  vector_hits: [],
  keyword_hits: [],
  graph_expansions: [],
  directories_visited: [],
  final_results: [],
});

export const writeRetrievalLog = (input: RetrievalLogInput): void => {
  const { db } = initDb("wisdom");
  try {
    db.run(
      `INSERT INTO retrieval_logs
        (id, query, planes_searched, results_count, graph_expansions, trajectory, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.query,
        JSON.stringify(input.planesSearched),
        input.resultsCount,
        input.graphExpansions,
        JSON.stringify(input.trajectory),
        Math.max(0, Math.round(input.durationMs)),
      ],
    );
  } finally {
    db.close();
  }
};

export const parseJsonField = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
