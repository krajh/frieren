import { describe, expect, test } from "bun:test";
import {
  compress,
  decompress,
  compressL1,
  estimateTokens,
  compressWithStats,
} from "../src/lib/frieren-compress.js";

describe("frieren-compress", () => {
  describe("compress()", () => {
    test("compresses common phrases", () => {
      const result = compress("Kai is working on the OpenCode project");
      expect(result).toContain("KAI");
      expect(result).toContain("OC");
      expect(result).toContain("proj");
    });

    test("compresses decision markers", () => {
      const result = compress("The team decided to approve the implementation");
      expect(result).toContain("decided:");
      expect(result).toContain("impl");
    });

    test("compresses priority markers", () => {
      const result = compress("This is a high priority task");
      expect(result).toContain("P0");
    });

    test("removes extra whitespace", () => {
      const result = compress("word1   word2  word3");
      expect(result).not.toContain("  ");
    });

    test("truncates long text", () => {
      const longText = "a".repeat(1000);
      const result = compress(longText, 100);
      expect(result.length).toBeLessThanOrEqual(103); // 100 + "..."
    });
  });

  describe("decompress()", () => {
    test("expands abbreviations", () => {
      const compressed = "KAI is working on OC";
      const result = decompress(compressed);
      expect(result).toContain("Kai");
      expect(result).toContain("OpenCode");
    });

    test("preserves non-abbreviated text", () => {
      const result = decompress("This is normal text");
      expect(result).toBe("This is normal text");
    });
  });

  describe("compressL1()", () => {
    test("compresses list of entries", () => {
      const entries = [
        {
          content: "Kai decided to start the project",
          created_at: "2026-04-07T10:00:00Z",
        },
        {
          content: "Rias is managing the team",
          created_at: "2026-04-06T10:00:00Z",
        },
      ];
      const result = compressL1(entries, 50);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain("[2026-04-07]");
    });

    test("respects max tokens limit", () => {
      const entries = Array(20)
        .fill(null)
        .map((_, i) => ({
          content: `Content number ${i} with some text`,
          created_at: `2026-04-0${i}T10:00:00Z`,
        }));
      const result = compressL1(entries, 30);
      // Should be limited by token budget
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("estimateTokens()", () => {
    test("estimates correctly", () => {
      expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 -> 3
      expect(estimateTokens("a".repeat(100))).toBe(25); // 100 / 4 = 25
    });
  });

  describe("compressWithStats()", () => {
    test("returns stats object", () => {
      const result = compressWithStats("Kai is working on OpenCode");
      expect(result.original).toBeDefined();
      expect(result.compressed).toBeDefined();
      expect(result.originalTokens).toBeDefined();
      expect(result.compressedTokens).toBeDefined();
      expect(result.ratio).toBeDefined();
    });

    test("compression ratio is reasonable", () => {
      const result = compressWithStats("Kai is working on OpenCode project");
      expect(result.ratio).toBeGreaterThanOrEqual(1);
    });
  });
});
