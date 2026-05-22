import type { WisdomEntry } from "../lib/frieren.js";

export interface SerializedContext {
  prompt: string;
  contextFiles?: string[];
}

const formatField = (label: string, value: string | undefined): string => {
  return `${label}: ${value && value.trim().length > 0 ? value : "-"}`;
};

export function serializeMemoryEntry(entry: WisdomEntry): string {
  return [
    `Memory Entry: ${entry.type}`,
    formatField("ID", entry.id),
    formatField("Content", entry.content),
    formatField("Tags", entry.tags.join(", ")),
    formatField("Confidence", Number.isFinite(entry.confidence) ? entry.confidence.toFixed(2) : undefined),
    formatField("Kind", entry.kind),
    formatField("Realm", entry.realm),
    formatField("Suite", entry.suite),
    formatField("Project", entry.project_id),
    formatField("Created", entry.created_at),
    formatField("Updated", entry.updated_at),
    formatField("Summary", entry.summary),
    formatField("Abstract", entry.abstract),
  ].join("\n");
}

export function serializeMultiEntry(entries: WisdomEntry[]): string {
  if (entries.length === 0) {
    return "No memory entries selected.";
  }

  return entries.map((entry, index) => `--- Entry ${index + 1} ---\n${serializeMemoryEntry(entry)}`).join("\n\n");
}

export function buildSpawnPrompt(entry: WisdomEntry, customInstructions?: string): string {
  const sections = [
    "Use the memory context below to start the next session.",
    "",
    serializeMemoryEntry(entry),
  ];

  if (customInstructions && customInstructions.trim().length > 0) {
    sections.push("", "Additional instructions:", customInstructions.trim());
  }

  return sections.join("\n");
}
