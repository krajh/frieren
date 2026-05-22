import {
  Box,
  Text,
  instantiate,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type TextRenderable,
} from "@opentui/core";

import { createListDetail } from "../components/list-detail.js";
import { createMemoryDetailOverlay } from "../components/memory-detail.js";
import { createSearchInput } from "../components/search-input.js";
import { createTextCard } from "../components/text-card.js";
import { promptFor } from "../lib/prompt.js";
import { truncate, formatStamp } from "../lib/format.js";
import {
  clearCache,
  getMemoryTimeline,
  getWisdomDetail,
  getWisdomRelations,
  relateEntries,
  searchWisdom,
  softDeleteEntry,
  updateEntryMeta,
  type WisdomEntry,
} from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";

const TYPE_FILTERS = ["all", "decision", "pattern", "constraint", "issue"] as const;

export function createWisdomBrowser(renderer: CliRenderer): {
  root: Renderable;
  refresh: () => void;
  handleKeyPress: (event: KeyEvent) => boolean;
  getSpawnEntry: () => WisdomEntry | null;
  applyTheme: () => void;
} {
  const PAGE_SIZE = 50;
  let filterIndex = 0;
  let page = 0;
  let entries: WisdomEntry[] = [];
  let selectedEntryId: string | null = null;

  const root = instantiate(
    renderer,
    Box({ width: "100%", height: "100%", flexDirection: "column", padding: 1, rowGap: 1 }),
  );

  const header = instantiate(
    renderer,
    Box({ width: "100%", flexDirection: "row", columnGap: 1, alignItems: "center" }),
  );

  const filterText = instantiate(renderer, Text({ content: "", fg: "#94a3b8", truncate: true })) as TextRenderable;
  const search = createSearchInput(renderer, {
    placeholder: "Search wisdom entries…",
    debounceMs: 150,
    onChange: () => refreshData(),
  });

  const listDetail = createListDetail(renderer, {
    listTitle: "Wisdom",
    detailTitle: "Preview",
    onSelectionChange: () => updateDetail(),
    onSelect: () => openDetail(),
  });
  const overlay = createMemoryDetailOverlay(renderer);

  header.add(filterText);
  header.add(search.root);
  root.add(header);
  root.add(listDetail.root);
  root.add(overlay.root);

  function getTypeFilter(): string | undefined {
    const value = TYPE_FILTERS[filterIndex];
    return value === "all" ? undefined : value;
  }

  function selectedEntry(): WisdomEntry | null {
    if (entries.length === 0) {
      return null;
    }
    return entries[listDetail.getSelectedIndex()] ?? null;
  }

  function updateHeader(): void {
    filterText.fg = getTheme().muted;
    filterText.content = `Type: ${TYPE_FILTERS[filterIndex]}  |  Page: ${page + 1}  |  Count: ${entries.length}  |  Keys: t cycle  [/] search  [,/.] page  Enter detail`;
  }

  function buildPreview(entry: WisdomEntry): string {
    return [
      `${entry.type.toUpperCase()}  confidence=${entry.confidence.toFixed(2)}`,
      `created: ${formatStamp(entry.created_at)}`,
      `kind: ${entry.kind ?? "-"}  realm: ${entry.realm ?? "-"}  suite: ${entry.suite ?? "-"}`,
      `tags: ${entry.tags.join(", ") || "-"}`,
      "",
      entry.content,
    ].join("\n");
  }

  function updateDetail(): void {
    const entry = selectedEntry();

    if (!entry) {
      listDetail.setDetail(
        createTextCard(
          renderer,
          "No wisdom entries yet. Press `n` to create one, or run agent sessions to accumulate wisdom.",
          "#94a3b8",
        ),
      );
      return;
    }

    selectedEntryId = entry.id;
    listDetail.setDetail(createTextCard(renderer, buildPreview(entry)));
  }

  function refreshData(): void {
    entries = searchWisdom(search.getValue(), getTypeFilter(), PAGE_SIZE, page * PAGE_SIZE);
    listDetail.setList(entries.map((entry) => `[${entry.type}] ${truncate(entry.content)}`));
    const selectedIndex = selectedEntryId ? entries.findIndex((entry) => entry.id === selectedEntryId) : 0;
    listDetail.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    updateHeader();
    updateDetail();
  }

  function openDetail(): void {
    const entry = selectedEntry();
    if (!entry) {
      return;
    }

    const detail = getWisdomDetail(entry.id) ?? entry;
    const related = getWisdomRelations(entry.id).map((relation) => {
      return `${relation.direction} ${relation.relationship} -> ${relation.related_type ?? "entry"} ${truncate(relation.related_content ?? relation.related_id, 56)}`;
    });
    const timeline = getMemoryTimeline(entry.id).map((item) => {
      return `${formatStamp(item.timestamp)}  [${item.plane}] ${item.event_type}  ${truncate(item.content, 64)}`;
    });

    overlay.show({
      title: `Wisdom Detail · ${detail.type}`,
      id: detail.id,
      metadata: [
        ["id", detail.id],
        ["type", detail.type],
        ["confidence", detail.confidence.toFixed(2)],
        ["kind", detail.kind],
        ["realm", detail.realm],
        ["suite", detail.suite],
        ["tags", detail.tags.join(", ")],
        ["created_at", detail.created_at],
        ["updated_at", detail.updated_at],
      ],
      content: detail.content,
      related,
      timeline,
    });
  }

  function refreshOverlay(id: string): void {
    const detail = getWisdomDetail(id);
    if (!detail) {
      overlay.hide();
      refreshData();
      return;
    }

    const related = getWisdomRelations(id).map((relation) => {
      return `${relation.direction} ${relation.relationship} -> ${relation.related_type ?? "entry"} ${truncate(relation.related_content ?? relation.related_id, 56)}`;
    });
    const timeline = getMemoryTimeline(id).map((item) => {
      return `${formatStamp(item.timestamp)}  [${item.plane}] ${item.event_type}  ${truncate(item.content, 64)}`;
    });

    overlay.show({
      title: `Wisdom Detail · ${detail.type}`,
      id: detail.id,
      metadata: [
        ["id", detail.id],
        ["type", detail.type],
        ["confidence", detail.confidence.toFixed(2)],
        ["kind", detail.kind],
        ["realm", detail.realm],
        ["suite", detail.suite],
        ["tags", detail.tags.join(", ")],
        ["created_at", detail.created_at],
        ["updated_at", detail.updated_at],
      ],
      content: detail.content,
      related,
      timeline,
    });
  }

  refreshData();

  return {
    root,
    refresh: refreshData,
    getSpawnEntry: () => selectedEntry(),
    applyTheme: () => {
      search.applyTheme();
      listDetail.applyTheme();
      overlay.applyTheme();
      refreshData();
    },
    handleKeyPress: (event: KeyEvent): boolean => {
      const overlayView = overlay.getView();
      if (overlayView?.id && event.name === "r") {
        const targetId = promptFor("Relate to entry id", "").trim();
        const relationship = promptFor("Relationship", "related").trim() || "related";
        if (targetId) {
          relateEntries(overlayView.id, targetId, relationship);
          clearCache();
          refreshOverlay(overlayView.id);
          refreshData();
        }
        return true;
      }

      if (overlayView?.id && event.name === "e") {
        const tags = promptFor("Tags (comma-separated)", overlayView.metadata?.find(([key]) => key === "tags")?.[1] ?? "");
        const kind = promptFor("Kind", overlayView.metadata?.find(([key]) => key === "kind")?.[1] ?? "");
        const realm = promptFor("Realm", overlayView.metadata?.find(([key]) => key === "realm")?.[1] ?? "");
        const suite = promptFor("Suite", overlayView.metadata?.find(([key]) => key === "suite")?.[1] ?? "");
        updateEntryMeta(overlayView.id, {
          tags: tags.split(",").map((value) => value.trim()).filter(Boolean),
          kind,
          realm,
          suite,
        });
        clearCache();
        refreshOverlay(overlayView.id);
        refreshData();
        return true;
      }

      if (overlayView?.id && event.name === "d") {
        const confirm = promptFor("Type DELETE to confirm", "");
        if (confirm === "DELETE") {
          softDeleteEntry(overlayView.id);
          overlay.hide();
          refreshData();
        }
        return true;
      }

      if (overlay.handleKeyPress(event)) {
        return true;
      }

      if (search.isFocused()) {
        return search.handleKeyPress(event);
      }

      if (event.name === "/") {
        search.focus();
        return true;
      }

      if (event.name === "t") {
        filterIndex = (filterIndex + 1) % TYPE_FILTERS.length;
        page = 0;
        selectedEntryId = null;
        refreshData();
        return true;
      }

      if (event.name === ".") {
        if (entries.length === PAGE_SIZE) {
          page += 1;
          selectedEntryId = null;
          refreshData();
        }
        return true;
      }

      if (event.name === ",") {
        page = Math.max(0, page - 1);
        selectedEntryId = null;
        refreshData();
        return true;
      }

      if (event.name === "C") {
        clearCache();
        refreshData();
        return true;
      }

      return listDetail.handleKeyPress(event);
    },
  };
}
