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
import { clearCache, getProjects, getRecentEvents, getSessionEvents, setQueryLimit, type SessionEvent, type WisdomEntry } from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";

const formatStamp = (value: string | undefined): string => value?.replace("T", " ").slice(5, 16) ?? "-";

const truncate = (value: string, width = 58): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > width ? `${normalized.slice(0, width - 1)}…` : normalized;
};

const createTextCard = (renderer: CliRenderer, content: string, color = "#cbd5e1"): Renderable => {
  return instantiate(renderer, Box({ width: "100%", flexDirection: "column" }, Text({ content, fg: color })));
};

export function createSessionBrowser(renderer: CliRenderer): {
  root: Renderable;
  refresh: () => void;
  handleKeyPress: (event: KeyEvent) => boolean;
  getSpawnEntry: () => WisdomEntry | null;
  applyTheme: () => void;
} {
  const PAGE_SIZE = 50;
  let projectIndex = 0;
  let page = 0;
  let projects = getProjects();
  let events: SessionEvent[] = [];
  let selectedEventId: string | null = null;

  const root = instantiate(renderer, Box({ width: "100%", height: "100%", flexDirection: "column", padding: 1, rowGap: 1 }));
  setQueryLimit(PAGE_SIZE);
  const headerText = instantiate(renderer, Text({ content: "", fg: "#94a3b8", truncate: true })) as TextRenderable;
  const listDetail = createListDetail(renderer, {
    listTitle: "Session Events",
    detailTitle: "Event Detail",
    onSelectionChange: () => updateDetail(),
    onSelect: () => openDetail(),
  });
  const overlay = createMemoryDetailOverlay(renderer);

  root.add(headerText);
  root.add(listDetail.root);
  root.add(overlay.root);

  function currentProject(): string | undefined {
    if (projects.length === 0) {
      return undefined;
    }
    return projects[projectIndex] ?? projects[0];
  }

  function selectedEvent(): SessionEvent | null {
    if (events.length === 0) {
      return null;
    }
    return events[listDetail.getSelectedIndex()] ?? null;
  }

  function updateHeader(): void {
    headerText.fg = getTheme().muted;
    headerText.content = `Project: ${currentProject() ?? "(none)"}  |  Page: ${page + 1}  |  Events: ${events.length}  |  Keys: p cycle  [,/.] page  Enter detail`;
  }

  function updateDetail(): void {
    const event = selectedEvent();
    if (!event) {
      listDetail.setDetail(
        createTextCard(
          renderer,
          "No projects found. Run an agent session in a project to start recording session history.",
          "#94a3b8",
        ),
      );
      return;
    }

    selectedEventId = event.id ?? `${event.session_id}:${event.created_at}`;
    const sessionEvents = getSessionEvents(event.session_id, 5);
    listDetail.setDetail(
      createTextCard(
        renderer,
        [
          `${event.event_type}  ${formatStamp(event.created_at)}`,
          `session: ${event.session_id}`,
          `project: ${event.project_id ?? "-"}`,
          `related events: ${sessionEvents.length}`,
          "",
          event.content,
        ].join("\n"),
      ),
    );
  }

  function refreshData(): void {
    projects = getProjects();
    projectIndex = Math.max(0, Math.min(projectIndex, Math.max(projects.length - 1, 0)));
    events = currentProject() ? getRecentEvents(currentProject(), PAGE_SIZE, page * PAGE_SIZE) : [];
    listDetail.setList(
      events.map((event) => `${formatStamp(event.created_at)}  ${event.event_type}  [${event.session_id.slice(0, 8)}] ${truncate(event.summary ?? event.content)}`),
    );
    const selectedIndex = selectedEventId
      ? events.findIndex((event) => (event.id ?? `${event.session_id}:${event.created_at}`) === selectedEventId)
      : 0;
    listDetail.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    updateHeader();
    updateDetail();
  }

  function openDetail(): void {
    const event = selectedEvent();
    if (!event) {
      return;
    }

    const related = getSessionEvents(event.session_id, 10)
      .filter((item) => item.id !== event.id)
      .map((item) => `${formatStamp(item.created_at)}  ${item.event_type}  ${truncate(item.summary ?? item.content, 64)}`);

    overlay.show({
      title: `Session Event · ${event.event_type}`,
      metadata: [
        ["session_id", event.session_id],
        ["project_id", event.project_id],
        ["created_at", event.created_at],
        ["summary", event.summary],
      ],
      content: event.content,
      related,
      // TODO: Build proper timeline from session events sorted by created_at
      timeline: [],
    });
  }

  function toSpawnEntry(event: SessionEvent | null): WisdomEntry | null {
    if (!event) {
      return null;
    }

    return {
      id: event.id ?? event.session_id,
      type: "session-event",
      content: event.content,
      tags: [event.event_type, event.project_id].filter((value): value is string => Boolean(value)),
      created_at: event.created_at,
      updated_at: event.created_at,
      confidence: 1,
      kind: event.event_type,
      realm: event.project_id,
      suite: event.session_id,
      project_id: event.project_id,
      summary: event.summary,
      abstract: event.abstract,
    };
  }

  refreshData();

  return {
    root,
    refresh: refreshData,
    getSpawnEntry: () => toSpawnEntry(selectedEvent()),
    applyTheme: () => {
      listDetail.applyTheme();
      overlay.applyTheme();
      refreshData();
    },
    handleKeyPress: (event: KeyEvent): boolean => {
      if (overlay.handleKeyPress(event)) {
        return true;
      }

      if (event.name === "p") {
        if (projects.length === 0) {
          return true;
        }
        projectIndex = (projectIndex + 1) % projects.length;
        page = 0;
        selectedEventId = null;
        refreshData();
        return true;
      }

      if (event.name === ".") {
        if (events.length === PAGE_SIZE) {
          page += 1;
          selectedEventId = null;
          refreshData();
        }
        return true;
      }

      if (event.name === ",") {
        page = Math.max(0, page - 1);
        selectedEventId = null;
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
