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
import { clearCache, getEntityTriples, getKGTimeline, searchKGEntities, setQueryLimit, type KGEntity, type WisdomEntry } from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";

const createTextCard = (renderer: CliRenderer, content: string, color = "#cbd5e1"): Renderable => {
  return instantiate(renderer, Box({ width: "100%", flexDirection: "column" }, Text({ content, fg: color })));
};

const truncate = (value: string, width = 70): string => {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
};

export function createKGBrowser(renderer: CliRenderer): {
  root: Renderable;
  refresh: () => void;
  handleKeyPress: (event: KeyEvent) => boolean;
  getSpawnEntry: () => WisdomEntry | null;
  applyTheme: () => void;
} {
  const PAGE_SIZE = 50;
  let entities: KGEntity[] = [];
  let page = 0;
  let selectedEntityId: string | null = null;

  const root = instantiate(renderer, Box({ width: "100%", height: "100%", flexDirection: "column", padding: 1, rowGap: 1 }));
  const header = instantiate(renderer, Box({ width: "100%", flexDirection: "row", columnGap: 1, alignItems: "center" }));
  const info = instantiate(renderer, Text({ content: "", fg: "#94a3b8", truncate: true })) as TextRenderable;
  setQueryLimit(PAGE_SIZE);
  const search = createSearchInput(renderer, {
    placeholder: "Search KG entities…",
    debounceMs: 150,
    onChange: () => refreshData(),
  });
  const listDetail = createListDetail(renderer, {
    listTitle: "Entities",
    detailTitle: "Triples",
    onSelectionChange: () => updateDetail(),
    onSelect: () => openDetail(),
  });
  const overlay = createMemoryDetailOverlay(renderer);

  header.add(info);
  header.add(search.root);
  root.add(header);
  root.add(listDetail.root);
  root.add(overlay.root);

  function selectedEntity(): KGEntity | null {
    if (entities.length === 0) {
      return null;
    }
    return entities[listDetail.getSelectedIndex()] ?? null;
  }

  function updateHeader(): void {
    info.fg = getTheme().muted;
    info.content = `Entities: ${entities.length}  |  Page: ${page + 1}  |  Keys: / search  [,/.] page  Enter detail`;
  }

  function updateDetail(): void {
    const entity = selectedEntity();
    if (!entity) {
      listDetail.setDetail(
        createTextCard(
          renderer,
          "No knowledge graph triples yet. Entries are created automatically through agent interactions.",
          "#94a3b8",
        ),
      );
      return;
    }

    selectedEntityId = entity.id;
    const triples = getEntityTriples(entity.name);
    listDetail.setDetail(
      createTextCard(
        renderer,
        [
          `${entity.name} (${entity.type})`,
          `triples: ${triples.length}`,
          "",
          triples.length > 0
            ? triples
                .slice(0, 8)
                .map((triple) => `${triple.subject} -> ${triple.predicate} -> ${triple.object}`)
                .join("\n")
            : "No triples for this entity.",
        ].join("\n"),
      ),
    );
  }

  function refreshData(): void {
    entities = searchKGEntities(search.getValue(), PAGE_SIZE, page * PAGE_SIZE);
    listDetail.setList(entities.map((entity) => `[${entity.type}] ${truncate(entity.name)}`));
    const selectedIndex = selectedEntityId ? entities.findIndex((entity) => entity.id === selectedEntityId) : 0;
    listDetail.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    updateHeader();
    updateDetail();
  }

  function openDetail(): void {
    const entity = selectedEntity();
    if (!entity) {
      return;
    }

    const triples = getEntityTriples(entity.name);
    const timeline = getKGTimeline(entity.name).map((triple) => {
      return `${triple.valid_from ?? "-"}  ${triple.subject} -> ${triple.predicate} -> ${triple.object}`;
    });

    overlay.show({
      title: `KG Entity · ${entity.name}`,
      metadata: [["id", entity.id], ["type", entity.type]],
      content:
        triples.length > 0
          ? triples
              .map((triple) => `${triple.subject} -> ${triple.predicate} -> ${triple.object} (conf=${triple.confidence.toFixed(2)})`)
              .join("\n")
          : "No triples for this entity.",
      related: triples.map((triple) => `${triple.subject} -> ${triple.object}`),
      timeline,
    });
  }

  function toSpawnEntry(entity: KGEntity | null): WisdomEntry | null {
    if (!entity) {
      return null;
    }

    const triples = getEntityTriples(entity.name)
      .map((triple) => `${triple.subject} -> ${triple.predicate} -> ${triple.object}`)
      .join("\n");

    return {
      id: entity.id,
      type: "kg-entity",
      content: [`Entity: ${entity.name}`, `Type: ${entity.type}`, "", triples || "No triples for this entity."].join("\n"),
      tags: ["kg", entity.type],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      confidence: 1,
      kind: entity.type,
      realm: "knowledge-graph",
      suite: entity.name,
      summary: entity.name,
      abstract: triples.split("\n")[0],
    };
  }

  refreshData();

  return {
    root,
    refresh: refreshData,
    getSpawnEntry: () => toSpawnEntry(selectedEntity()),
    applyTheme: () => {
      search.applyTheme();
      listDetail.applyTheme();
      overlay.applyTheme();
      refreshData();
    },
    handleKeyPress: (event: KeyEvent): boolean => {
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

      if (event.name === ".") {
        if (entities.length === PAGE_SIZE) {
          page += 1;
          selectedEntityId = null;
          refreshData();
        }
        return true;
      }

      if (event.name === ",") {
        page = Math.max(0, page - 1);
        selectedEntityId = null;
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
