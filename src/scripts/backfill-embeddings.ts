/**
 * Backfill wisdom_vec embeddings for entries that were created
 * when sqlite-vec was not available (pre-better-sqlite3 migration).
 *
 * Usage: npx tsx src/scripts/backfill-embeddings.ts
 */
import { Database } from "../db/database.js";
import { embedTexts } from "../embedding/client.js";
import { join } from "path";
import { homedir } from "os";

const WISDOM_DB = join(homedir(), ".frieren", "wisdom.db");

async function main() {
  const db = new Database(WISDOM_DB);
  db.loadVec();

  // Find wisdom entries without embeddings in wisdom_vec
  const missing = db
    .query(
      `SELECT we.id, we.content
       FROM wisdom_entries we
       LEFT JOIN wisdom_vec wv ON we.id = wv.entry_id
       WHERE wv.entry_id IS NULL`,
    )
    .all() as { id: string; content: string }[];

  console.log(`Found ${missing.length} wisdom entries missing embeddings.`);

  if (missing.length === 0) {
    console.log("Nothing to backfill. All entries have embeddings.");
    db.close();
    return;
  }

  // Batch embed all content
  const contents = missing.map((r) => r.content);
  const { vectors, error } = await embedTexts(contents);

  if (error) {
    console.error("Embedding generation failed:", error);
    db.close();
    process.exit(1);
  }

  if (vectors.length !== missing.length) {
    console.error(
      `Vector count mismatch: expected ${missing.length}, got ${vectors.length}`,
    );
    db.close();
    process.exit(1);
  }

  // Insert embeddings
  const insert = db.prepare(
    `INSERT OR REPLACE INTO wisdom_vec (entry_id, embedding) VALUES (?, ?)`,
  );

  const insertMany = db.transaction((rows: { id: string; vector: Float32Array }[]) => {
    for (const row of rows) {
      insert.run(row.id, new Uint8Array(row.vector.buffer));
    }
  });

  insertMany(
    missing.map((r, i) => ({
      id: r.id,
      vector: vectors[i]!,
    })),
  );

  console.log(`Backfilled ${missing.length} embeddings into wisdom_vec.`);

  // Verify
  const total = db.query(`SELECT COUNT(*) as count FROM wisdom_vec`).get() as {
    count: number;
  };
  console.log(`Total wisdom_vec entries now: ${total.count}`);

  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
