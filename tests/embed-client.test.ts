import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { embedTexts } from "../src/embedding/client.js";

const createMockFetch = (responses: Array<Record<string, unknown>>) => {
  let index = 0;
  return async () => {
    const response = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return response as unknown as Response;
  };
};

test("embedTexts returns Float32Array vectors", async () => {
  process.env.AITOOLINGKEY = "test-key";
  const mockFetch = createMockFetch([
    {
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    },
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const result = await embedTexts(["hello"]);

    assert.equal(result.vectors.length, 1);
    assert.ok(result.vectors[0] instanceof Float32Array);
    const values = Array.from(result.vectors[0] ?? []);
    const rounded = values.map((value) => Number(value.toFixed(3)));
    assert.deepEqual(rounded, [0.1, 0.2, 0.3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedTexts retries on failure", async () => {
  process.env.AITOOLINGKEY = "test-key";
  const mockFetch = createMockFetch([
    { ok: false, status: 500, text: async () => "fail" },
    { ok: false, status: 500, text: async () => "fail" },
    { ok: true, json: async () => ({ data: [{ embedding: [0.4] }] }) },
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const result = await embedTexts(["retry"]);

    assert.equal(result.vectors.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
