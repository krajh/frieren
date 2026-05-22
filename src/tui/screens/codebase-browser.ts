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
import { clearCache, getFileChunks, getProjectFiles, listIndexedProjects, setQueryLimit, type CodeChunk, type WisdomEntry } from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";

const truncate = (value: string, width = 64): string => {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
};

const createTextCard = (renderer: CliRenderer, content: string, color = "#cbd5e1"): Renderable => {
  return instantiate(renderer, Box({ width: "100%", flexDirection: "column" }, Text({ content, fg: color })));
};

export function createCodebaseBrowser(renderer: CliRenderer): {
  root: Renderable;
  refresh: () => void;
  handleKeyPress: (event: KeyEvent) => boolean;
  getSpawnEntry: () => WisdomEntry | null;
  applyTheme: () => void;
} {
  const PAGE_SIZE = 50;
  let projectIndex = 0;
  let page = 0;
  let projects = listIndexedProjects();
  let files: string[] = [];
  let expanded = false;
  let selectedFilePath: string | null = null;

  const root = instantiate(renderer, Box({ width: "100%", height: "100%", flexDirection: "column", padding: 1, rowGap: 1 }));
  setQueryLimit(PAGE_SIZE);
  const headerText = instantiate(renderer, Text({ content: "", fg: "#94a3b8", truncate: true })) as TextRenderable;
  const listDetail = createListDetail(renderer, {
    listTitle: "Files",
    detailTitle: "Chunks",
    onSelectionChange: () => {
      expanded = false;
      updateDetail();
    },
    onSelect: () => {
      expanded = !expanded;
      updateDetail();
    },
  });

  root.add(headerText);
  root.add(listDetail.root);

  function currentProject(): string | undefined {
    if (projects.length === 0) {
      return undefined;
    }
    return projects[projectIndex] ?? projects[0];
  }

  function selectedFile(): string | undefined {
    return files[listDetail.getSelectedIndex()];
  }

  function updateHeader(): void {
    headerText.fg = getTheme().muted;
    headerText.content = `Project: ${currentProject() ?? "(none)"}  |  Page: ${page + 1}  |  Files: ${files.length}  |  Keys: p cycle  [,/.] page  Enter expand`;
  }

  function formatChunk(chunk: CodeChunk): string {
    const range = chunk.start_line && chunk.end_line ? `L${chunk.start_line}-${chunk.end_line}` : "lines:?";
    const summary = chunk.summary ?? truncate(chunk.content.replace(/\s+/g, " "), 100);
    return `[${chunk.chunk_type}] ${chunk.name ?? chunk.file} (${range})\n${summary}`;
  }

  function updateDetail(): void {
    const project = currentProject();
    const file = selectedFile();

    if (!project || !file) {
      listDetail.setDetail(
        createTextCard(
          renderer,
          "No codebase indexes found. Run frieren_codebase_index() to index a project's source code.",
          "#94a3b8",
        ),
      );
      return;
    }

    selectedFilePath = file;
    const chunks = getFileChunks(project, file);
    const deps = chunks[0]?.deps ?? [];
    const dependents = chunks[0]?.dependents ?? [];
    const visibleChunks = expanded ? chunks : chunks.slice(0, 3);

    listDetail.setDetail(
      createTextCard(
        renderer,
        [
          file,
          `chunks: ${chunks.length}  expanded: ${expanded ? "yes" : "no"}`,
          `deps: ${deps.join(", ") || "-"}`,
          `dependents: ${dependents.join(", ") || "-"}`,
          "",
          visibleChunks.length > 0 ? visibleChunks.map(formatChunk).join("\n\n") : "No indexed chunks for this file.",
        ].join("\n"),
      ),
    );
  }

  function refreshData(): void {
    projects = listIndexedProjects();
    projectIndex = Math.max(0, Math.min(projectIndex, Math.max(projects.length - 1, 0)));
    files = currentProject() ? getProjectFiles(currentProject()!, PAGE_SIZE, page * PAGE_SIZE) : [];
    listDetail.setList(files.map((file) => truncate(file, 72)));
    const selectedIndex = selectedFilePath ? files.findIndex((file) => file === selectedFilePath) : 0;
    listDetail.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    updateHeader();
    updateDetail();
  }

  function toSpawnEntry(): WisdomEntry | null {
    const project = currentProject();
    const file = selectedFile();

    if (!project || !file) {
      return null;
    }

    const chunks = getFileChunks(project, file);
    const summary = chunks
      .slice(0, 5)
      .map((chunk) => formatChunk(chunk))
      .join("\n\n");

    return {
      id: `${project}:${file}`,
      type: "codebase",
      content: [`Project: ${project}`, `File: ${file}`, "", summary || "No indexed chunks for this file."].join("\n"),
      tags: ["codebase", project],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      confidence: 1,
      kind: "file",
      realm: project,
      suite: "codebase-browser",
      project_id: project,
      summary: file,
      abstract: chunks[0]?.summary,
    };
  }

  refreshData();

  return {
    root,
    refresh: refreshData,
    getSpawnEntry: () => toSpawnEntry(),
    applyTheme: () => {
      listDetail.applyTheme();
      refreshData();
    },
    handleKeyPress: (event: KeyEvent): boolean => {
      if (event.name === "p") {
        if (projects.length === 0) {
          return true;
        }
        projectIndex = (projectIndex + 1) % projects.length;
        page = 0;
        selectedFilePath = null;
        refreshData();
        return true;
      }

      if (event.name === ".") {
        if (files.length === PAGE_SIZE) {
          page += 1;
          selectedFilePath = null;
          refreshData();
        }
        return true;
      }

      if (event.name === ",") {
        page = Math.max(0, page - 1);
        selectedFilePath = null;
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
