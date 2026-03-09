import { test, mock } from "bun:test";
import { strict as assert } from "node:assert";

mock.module("@xenova/transformers", () => ({
  pipeline: async () =>
    async (inputs: string[]) => ({
      data: new Float32Array(inputs.length * 384).fill(0.25),
    }),
}));

const { embedTexts, EMBEDDING_DIMS } = await import(
  "../src/embedding/client.js"
);

test("embedTexts returns Float32Array vectors with correct dims", async () => {
  const result = await embedTexts(["hello"]);

  assert.equal(result.vectors.length, 1);
  assert.ok(result.vectors[0] instanceof Float32Array);
  assert.equal(result.vectors[0].length, EMBEDDING_DIMS);
  assert.equal(EMBEDDING_DIMS, 384);
});

test("embedTexts handles batch correctly", async () => {
  const result = await embedTexts(["hello", "world"]);

  assert.equal(result.vectors.length, 2);
  for (const vec of result.vectors) {
    assert.ok(vec instanceof Float32Array);
    assert.equal(vec.length, EMBEDDING_DIMS);
  }
});

test("embedTexts returns empty array for empty input", async () => {
  const result = await embedTexts([]);

  assert.equal(result.vectors.length, 0);
  assert.equal(result.error, undefined);
});
