import { tool } from "@opencode-ai/plugin";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { getLLMProvider } from "./lib/provider.js";
import { persistExtraction } from "./lib/extraction-utils.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
// File-only logger
const LOG_DIR = join(homedir(), ".config", "opencode", "logs");
const LOG_FILE = join(LOG_DIR, "frieren-bridge.log");
try {
    mkdirSync(LOG_DIR, { recursive: true });
}
catch { /* ignore */ }
const log = (level, message, meta) => {
    const timestamp = new Date().toISOString();
    const line = meta !== undefined
        ? `[${timestamp}] [${level}] ${message} ${JSON.stringify(meta)}\n`
        : `[${timestamp}] [${level}] ${message}\n`;
    try {
        appendFileSync(LOG_FILE, line);
    }
    catch { /* silently drop */ }
};
// Resolve Frieren path relative to this plugin
const FRIEREN_PATH = join(__dirname, "../../src/index.ts");
let mcpClient = null;
let transport = null;
const connectToFrieren = async () => {
    if (mcpClient)
        return mcpClient;
    transport = new StdioClientTransport({
        command: "bun",
        args: [FRIEREN_PATH],
        stderr: "ignore",
    });
    mcpClient = new Client({ name: "frieren-bridge", version: "0.1.0" });
    await mcpClient.connect(transport);
    return mcpClient;
};
const disconnectFromFrieren = async () => {
    if (transport) {
        await transport.close();
        transport = null;
    }
    mcpClient = null;
};
const callFrierenTool = async (toolName, args) => {
    const client = await connectToFrieren();
    // Add timeout to prevent hanging on Frieren calls
    const toolCallPromise = client.callTool({
        name: toolName,
        arguments: args,
    });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool ${toolName} timed out after 5s`)), 5000));
    return Promise.race([toolCallPromise, timeoutPromise]);
};
// Extract text content from MCP tool result
const extractResultText = (result) => {
    if (typeof result === "string")
        return result;
    if (result &&
        typeof result === "object" &&
        "content" in result &&
        Array.isArray(result.content)) {
        const textParts = result.content
            .filter((p) => p && typeof p === "object" && "type" in p && p.type === "text")
            .map((p) => p && typeof p === "object" && "text" in p ? String(p.text) : "");
        return textParts.join("\n");
    }
    return JSON.stringify(result);
};
// Compaction capture: extract structured knowledge via LLM provider
// Returns the provider kind used (or "none" for fallback)
const captureCompaction = async (sessionID) => {
    try {
        // Get compact context from session recall
        const recallResult = await callFrierenTool("session_recall", {
            query: "recent context",
            session_id: sessionID,
        });
        const contextText = extractResultText(recallResult);
        const snippet = contextText.slice(0, 4000);
        if (!snippet.trim())
            return "none";
        // Try LLM-enhanced extraction
        const { provider, kind } = await getLLMProvider();
        if (provider) {
            log("info", "Running LLM extraction on compact", { provider: kind, sessionID });
            const result = await provider.extract(contextText);
            if (result && (result.wisdom.length > 0 || result.triples.length > 0)) {
                const callTool = callFrierenTool;
                const summary = await persistExtraction(result, callTool);
                if (summary.wisdomWritten > 0 || summary.triplesWritten > 0) {
                    log("info", "LLM extraction persisted", summary);
                    return kind; // LLM extraction handled it
                }
            }
        }
        // Fallback: store raw compact as durable wisdom snapshot
        log("info", "Falling back to raw compact snapshot", { sessionID });
        const fallbackSnippet = snippet.slice(0, 1500);
        if (fallbackSnippet.trim()) {
            await callFrierenTool("wisdom_write", {
                type: "pattern",
                content: `Session Compact [${sessionID}]: ${fallbackSnippet}`,
                tags: ["compact", "handoff", "session-snapshot"],
                kind: "session-compact",
            });
        }
        return "none";
    }
    catch (error) {
        log("error", "Compaction capture failed", error);
        return "none";
    }
};
export const FrierenBridgePlugin = async (ctx) => {
    // Helper to show toast notifications
    const showToast = (title, message, variant = "info", duration = 3000) => {
        ctx.client.tui
            .showToast({
            body: { title, message, variant, duration },
        })
            .catch(() => { });
    };
    // Initialize connection on startup (NON-BLOCKING)
    (async () => {
        try {
            await connectToFrieren();
            log("info", "Connected to Frieren MCP server");
        }
        catch (error) {
            log("error", "Failed to connect to Frieren", error);
        }
    })();
    // Don't await — let connection happen in background
    // Graceful shutdown
    const shutdown = async () => {
        await disconnectFromFrieren();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return {
        event: async (input) => {
            const event = input.event;
            log("info", "Event received", { type: event.type });
            // Auto-injection: wake up Frieren context on session start (TRULY NON-BLOCKING)
            // Note: session.created does NOT exist in OpenCode! Using session.updated instead.
            if (event.type === "session.updated") {
                log("info", "session.updated handler fired - checking if wakeup needed");
                // Fire and forget — do NOT await, let it run in background
                (async () => {
                    try {
                        const wakeupPath = join(homedir(), ".config", "opencode", "soul", ".frieren-wakeup.json");
                        const fs = await import("node:fs/promises");
                        const crypto = await import("node:crypto");
                        // Get new wakeup content from Frieren
                        const wakeupPromise = callFrierenTool("wisdom_wakeup", {
                            compress: true,
                            max_tokens: 200,
                        });
                        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Wakeup timeout after 3s")), 3000));
                        const wakeupResult = await Promise.race([wakeupPromise, timeoutPromise]);
                        // Parse the result properly (handle double-encoded JSON)
                        let wakeupData;
                        const rawText = extractResultText(wakeupResult);
                        try {
                            wakeupData = JSON.parse(rawText);
                        }
                        catch {
                            wakeupData = rawText;
                        }
                        // Calculate hash of new content
                        const newContent = JSON.stringify(wakeupData);
                        const newHash = crypto.createHash("sha256").update(newContent).digest("hex").substring(0, 16);
                        // Check if content changed
                        let shouldWrite = true;
                        try {
                            const existingContent = await fs.readFile(wakeupPath, "utf-8");
                            const existingData = JSON.parse(existingContent);
                            if (existingData.hash === newHash) {
                                log("info", "Skipping wakeup - content unchanged", { hash: newHash });
                                shouldWrite = false;
                            }
                        }
                        catch {
                            // File doesn't exist or error - proceed with write
                        }
                        if (shouldWrite) {
                            // Write wakeup context to file for Rias to read
                            await fs.mkdir(join(homedir(), ".config", "opencode", "soul"), { recursive: true });
                            await fs.writeFile(wakeupPath, JSON.stringify({
                                timestamp: new Date().toISOString(),
                                hash: newHash,
                                context: wakeupData,
                            }, null, 2));
                            log("info", "Wrote Frieren wakeup context (content changed)", { path: wakeupPath, hash: newHash });
                            showToast("Frieren Bridge", "Context loaded from Frieren", "success", 3000);
                        }
                    }
                    catch (error) {
                        log("warn", "Wakeup failed (session continues normally)", error);
                    }
                })();
                // Return immediately — don't await the async function
            }
            if (event.type === "session.idle") {
                const sessionID = event.properties?.sessionID;
                if (!sessionID)
                    return;
                // Non-blocking: fire and forget
                (async () => {
                    try {
                        // Auto-commit: extract patterns from session
                        await callFrierenTool("memory_commit", {});
                        showToast("Frieren Bridge", "Session patterns extracted to wisdom", "success", 3000);
                    }
                    catch (error) {
                        log("error", "Auto-commit failed", error);
                    }
                })();
            }
            if (event.type === "session.compacted") {
                const sessionID = event.properties?.sessionID;
                if (!sessionID)
                    return;
                // Non-blocking: fire and forget
                (async () => {
                    try {
                        const kind = await captureCompaction(sessionID);
                        const msg = kind === "none"
                            ? "Session compact stored (no LLM provider)"
                            : `Session knowledge extracted via ${kind}`;
                        showToast("Frieren Bridge", msg, "info", 3000);
                    }
                    catch (error) {
                        log("error", "Compaction capture failed", error);
                    }
                })();
            }
        },
        tool: {
            // Delegate all Frieren tools through the bridge
            frieren_status: tool({
                description: "Report Frieren storage stats and health across all planes",
                args: {},
                async execute() {
                    const result = await callFrierenTool("frieren_status", {});
                    return extractResultText(result);
                },
            }),
            wisdom_wakeup: tool({
                description: "Get compact wake-up context (L0 identity + L1 essential facts). Returns ≤200 tokens for system prompt injection.",
                args: {
                    compress: tool.schema
                        .boolean()
                        .optional()
                        .describe("Use AAAK-style compression for L1 (default true)"),
                    include_session: tool.schema
                        .boolean()
                        .optional()
                        .describe("Include recent session events in L1"),
                    max_tokens: tool.schema
                        .number()
                        .optional()
                        .describe("Max tokens for L1 (default 120, L0~50)"),
                },
                async execute(args) {
                    const result = await callFrierenTool("wisdom_wakeup", args);
                    return extractResultText(result);
                },
            }),
            wisdom_write: tool({
                description: "Write a wisdom entry to the Frieren wisdom plane",
                args: {
                    type: tool.schema
                        .enum(["decision", "pattern", "constraint", "issue"])
                        .describe("Category of wisdom"),
                    content: tool.schema.string().describe("The wisdom content"),
                    confidence: tool.schema
                        .number()
                        .optional()
                        .describe("Confidence score 0-1 (default 0.8)"),
                    evidence: tool.schema
                        .array(tool.schema.string())
                        .optional()
                        .describe("Supporting evidence"),
                    project_id: tool.schema
                        .string()
                        .optional()
                        .describe("Project ID to scope this wisdom"),
                    tags: tool.schema
                        .array(tool.schema.string())
                        .optional()
                        .describe("Tags for classification"),
                    realm: tool.schema
                        .string()
                        .optional()
                        .describe("Realm: top-level domain (project, agent, topic)"),
                    suite: tool.schema
                        .string()
                        .optional()
                        .describe("Suite: group of related memories within realm"),
                    kind: tool.schema
                        .string()
                        .optional()
                        .describe("Kind: memory type (fact, event, discovery, preference, advice)"),
                },
                async execute(args) {
                    const result = await callFrierenTool("wisdom_write", args);
                    return extractResultText(result);
                },
            }),
            wisdom_search: tool({
                description: "Search the Frieren wisdom plane by semantic or keyword query",
                args: {
                    query: tool.schema.string().describe("Search query"),
                    type_filter: tool.schema
                        .enum(["decision", "pattern", "constraint", "issue"])
                        .optional()
                        .describe("Filter by wisdom type"),
                    project_id: tool.schema.string().optional().describe("Filter by project ID"),
                    realm: tool.schema.string().optional().describe("Filter by realm"),
                    suite: tool.schema.string().optional().describe("Filter by suite"),
                    kind: tool.schema.string().optional().describe("Filter by kind"),
                    limit: tool.schema.number().optional().describe("Max results (default 10)"),
                    fidelity: tool.schema
                        .enum(["L0", "L1", "L2"])
                        .optional()
                        .describe("Response fidelity: L0=abstract, L1=summary, L2=full"),
                    debug: tool.schema
                        .boolean()
                        .optional()
                        .describe("Include retrieval trajectory in response"),
                },
                async execute(args) {
                    const result = await callFrierenTool("wisdom_search", args);
                    return extractResultText(result);
                },
            }),
            wisdom_relate: tool({
                description: "Create a relationship between two wisdom entries",
                args: {
                    id1: tool.schema.string().describe("First wisdom entry ID"),
                    id2: tool.schema.string().describe("Second wisdom entry ID"),
                    relationship: tool.schema
                        .enum(["supports", "contradicts", "extends", "supersedes", "related"])
                        .describe("Type of relationship"),
                    strength: tool.schema.number().optional().describe("Relation strength 0-1 (default 0.5)"),
                },
                async execute(args) {
                    const result = await callFrierenTool("wisdom_relate", args);
                    return extractResultText(result);
                },
            }),
            session_write: tool({
                description: "Record an event in the current session",
                args: {
                    event_type: tool.schema
                        .enum(["tool_call", "decision", "blocker", "milestone", "note", "error"])
                        .describe("Type of session event"),
                    content: tool.schema.string().describe("Event content"),
                    artifacts: tool.schema
                        .string()
                        .optional()
                        .describe("JSON array of artifacts [{type, path?, url?, label?}]"),
                    session_id: tool.schema.string().optional().describe("Session ID"),
                    project_id: tool.schema.string().optional().describe("Project ID"),
                },
                async execute(args) {
                    const parsedArgs = { ...args };
                    if (typeof args.artifacts === "string") {
                        try {
                            parsedArgs.artifacts = JSON.parse(args.artifacts);
                        }
                        catch {
                            // Leave as string if not valid JSON
                        }
                    }
                    const result = await callFrierenTool("session_write", parsedArgs);
                    return extractResultText(result);
                },
            }),
            session_recall: tool({
                description: "Retrieve recent session context by query or entity",
                args: {
                    query: tool.schema.string().describe("Search query"),
                    session_id: tool.schema.string().optional().describe("Session ID"),
                    project_id: tool.schema.string().optional().describe("Project ID"),
                    limit: tool.schema.number().optional().describe("Max results"),
                    fidelity: tool.schema
                        .enum(["L0", "L1", "L2"])
                        .optional()
                        .describe("Response fidelity"),
                },
                async execute(args) {
                    const result = await callFrierenTool("session_recall", args);
                    return extractResultText(result);
                },
            }),
            codebase_index: tool({
                description: "Index a local repository (full or incremental via git diff)",
                args: {
                    force: tool.schema.boolean().optional().describe("Force full re-index"),
                    project_id: tool.schema.string().optional().describe("Project ID"),
                    root_path: tool.schema.string().optional().describe("Project root path"),
                },
                async execute(args) {
                    const result = await callFrierenTool("codebase_index", args);
                    return extractResultText(result);
                },
            }),
            codebase_search: tool({
                description: "Search indexed code by semantic similarity or keyword",
                args: {
                    query: tool.schema.string().describe("Search query"),
                    limit: tool.schema.number().optional().describe("Max results"),
                    fidelity: tool.schema
                        .enum(["L0", "L1", "L2"])
                        .optional()
                        .describe("Response fidelity"),
                    file_filter: tool.schema.string().optional().describe("Glob pattern to filter files"),
                    debug: tool.schema.boolean().optional().describe("Include retrieval trajectory"),
                },
                async execute(args) {
                    const result = await callFrierenTool("codebase_search", args);
                    return extractResultText(result);
                },
            }),
            codebase_graph: tool({
                description: "BFS traversal of file/symbol dependency graph",
                args: {
                    entry: tool.schema.string().describe("Entry file path"),
                    depth: tool.schema.number().optional().describe("BFS depth (default 3)"),
                    direction: tool.schema
                        .enum(["deps", "dependents", "both"])
                        .optional()
                        .describe("Traversal direction"),
                    project_id: tool.schema.string().optional().describe("Project ID"),
                },
                async execute(args) {
                    const result = await callFrierenTool("codebase_graph", args);
                    return extractResultText(result);
                },
            }),
            memory_search: tool({
                description: "Unified search across all three planes with GraphRAG scoring",
                args: {
                    query: tool.schema.string().describe("Search query"),
                    limit: tool.schema.number().optional().describe("Max results (default 15)"),
                    fidelity: tool.schema
                        .enum(["L0", "L1", "L2"])
                        .optional()
                        .describe("Response fidelity"),
                    planes: tool.schema
                        .array(tool.schema.enum(["wisdom", "session", "codebase"]))
                        .optional()
                        .describe("Planes to search"),
                    debug: tool.schema.boolean().optional().describe("Include retrieval trajectory"),
                },
                async execute(args) {
                    const result = await callFrierenTool("memory_search", args);
                    return extractResultText(result);
                },
            }),
            memory_history: tool({
                description: "Cross-plane chronological timeline for an entity",
                args: {
                    entity_id: tool.schema.string().describe("Entity ID to trace"),
                    since: tool.schema.string().optional().describe("ISO date lower bound"),
                },
                async execute(args) {
                    const result = await callFrierenTool("memory_history", args);
                    return extractResultText(result);
                },
            }),
            memory_browse: tool({
                description: "Deterministic memory navigation (ls, tree, stat, find)",
                args: {
                    op: tool.schema
                        .enum(["ls", "tree", "stat", "find"])
                        .describe("Browse operation"),
                    plane: tool.schema
                        .enum(["wisdom", "session", "codebase"])
                        .optional()
                        .describe("Target plane"),
                    pattern: tool.schema.string().optional().describe("Regex pattern for find"),
                    limit: tool.schema.number().optional().describe("Page size"),
                    offset: tool.schema.number().optional().describe("Pagination offset"),
                },
                async execute(args) {
                    const result = await callFrierenTool("memory_browse", args);
                    return extractResultText(result);
                },
            }),
            memory_commit: tool({
                description: "Auto-extract recurring session patterns and promote to wisdom",
                args: {
                    dry_run: tool.schema
                        .boolean()
                        .optional()
                        .describe("Preview candidates without writing"),
                },
                async execute(args) {
                    const result = await callFrierenTool("memory_commit", args);
                    return extractResultText(result);
                },
            }),
            retrieval_debug: tool({
                description: "Query retrieval trajectory logs to diagnose search quality",
                args: {
                    query_contains: tool.schema.string().optional().describe("Substring match against query text"),
                    plane: tool.schema
                        .enum(["wisdom", "session", "codebase"])
                        .optional()
                        .describe("Filter by plane"),
                    limit: tool.schema.number().optional().describe("Max log rows"),
                },
                async execute(args) {
                    const result = await callFrierenTool("retrieval_debug", args);
                    return extractResultText(result);
                },
            }),
            frieren_update: tool({
                description: "Pull the latest Frieren updates from git and reinstall deps",
                args: {},
                async execute() {
                    const result = await callFrierenTool("frieren_update", {});
                    return extractResultText(result);
                },
            }),
            // Reaper Realm tools
            reaper_enqueue: tool({
                description: "Cast a task into the Reaper Realm for background execution",
                args: {
                    task: tool.schema.string().describe("Task instruction"),
                    priority: tool.schema.number().optional().describe("Priority 1-10 (lower = higher)"),
                    timeout_seconds: tool.schema.number().optional().describe("Timeout in seconds"),
                },
                async execute(args) {
                    const result = await callFrierenTool("reaper_enqueue", args);
                    return extractResultText(result);
                },
            }),
            reaper_dequeue: tool({
                description: "Claim the next pending task from the Reaper Realm",
                args: {},
                async execute() {
                    const result = await callFrierenTool("reaper_dequeue", {});
                    return extractResultText(result);
                },
            }),
            reaper_heartbeat: tool({
                description: "Update heartbeat for a manifesting task",
                args: {
                    task_id: tool.schema.string().describe("Task ID"),
                },
                async execute(args) {
                    const result = await callFrierenTool("reaper_heartbeat", args);
                    return extractResultText(result);
                },
            }),
            reaper_complete: tool({
                description: "Mark a Reaper Realm task as completed",
                args: {
                    task_id: tool.schema.string().describe("Task ID"),
                    result: tool.schema.string().describe("JSON result/summary"),
                },
                async execute(args) {
                    const result = await callFrierenTool("reaper_complete", args);
                    return extractResultText(result);
                },
            }),
            reaper_fail: tool({
                description: "Mark a Reaper Realm task as failed",
                args: {
                    task_id: tool.schema.string().describe("Task ID"),
                    error: tool.schema.string().describe("Failure reason"),
                },
                async execute(args) {
                    const result = await callFrierenTool("reaper_fail", args);
                    return extractResultText(result);
                },
            }),
            reaper_status: tool({
                description: "Query Reaper Realm queue state",
                args: {
                    status_filter: tool.schema.string().optional().describe("Filter by status"),
                    limit: tool.schema.number().optional().describe("Max tasks"),
                },
                async execute(args) {
                    const result = await callFrierenTool("reaper_status", args);
                    return extractResultText(result);
                },
            }),
            reaper_cancel: tool({
                description: "Cancel a Reaper Realm task",
                args: {
                    task_id: tool.schema.string().describe("Task ID"),
                },
                async execute(args) {
                    const result = await callFrierenTool("reaper_cancel", args);
                    return extractResultText(result);
                },
            }),
            // Knowledge Graph tools
            kg_add: tool({
                description: "Add a temporal triple to the knowledge graph",
                args: {
                    subject: tool.schema.string().describe("Subject entity name"),
                    predicate: tool.schema.string().describe("Relationship predicate"),
                    object: tool.schema.string().optional().describe("Object entity name"),
                    object_value: tool.schema.string().optional().describe("Literal value if no object entity"),
                    valid_from: tool.schema.string().optional().describe("ISO date when fact became true"),
                    confidence: tool.schema.number().optional().describe("Confidence 0-1"),
                },
                async execute(args) {
                    const result = await callFrierenTool("kg_add", args);
                    return extractResultText(result);
                },
            }),
            kg_query: tool({
                description: "Query the knowledge graph",
                args: {
                    entity: tool.schema.string().optional().describe("Entity name to query"),
                    predicate: tool.schema.string().optional().describe("Filter by predicate"),
                    as_of: tool.schema.string().optional().describe("ISO date for temporal query"),
                    limit: tool.schema.number().optional().describe("Max results"),
                },
                async execute(args) {
                    const result = await callFrierenTool("kg_query", args);
                    return extractResultText(result);
                },
            }),
            kg_invalidate: tool({
                description: "Mark a knowledge graph triple as no longer valid",
                args: {
                    subject: tool.schema.string().describe("Subject entity"),
                    predicate: tool.schema.string().describe("Predicate to invalidate"),
                    object: tool.schema.string().optional().describe("Object entity"),
                },
                async execute(args) {
                    const result = await callFrierenTool("kg_invalidate", args);
                    return extractResultText(result);
                },
            }),
            kg_timeline: tool({
                description: "Get chronological history of all facts about an entity",
                args: {
                    entity: tool.schema.string().describe("Entity name"),
                    limit: tool.schema.number().optional().describe("Max triples"),
                },
                async execute(args) {
                    const result = await callFrierenTool("kg_timeline", args);
                    return extractResultText(result);
                },
            }),
            kg_validate: tool({
                description: "Validate a fact against stored knowledge",
                args: {
                    subject: tool.schema.string().describe("Subject entity"),
                    predicate: tool.schema.string().describe("Predicate to check"),
                    object: tool.schema.string().optional().describe("Claimed object/value"),
                },
                async execute(args) {
                    const result = await callFrierenTool("kg_validate", args);
                    return extractResultText(result);
                },
            }),
            // Diary tools
            diary_write: tool({
                description: "Write an entry to an agent's diary",
                args: {
                    agent_id: tool.schema.string().describe("Agent identifier"),
                    content: tool.schema.string().describe("Diary entry content"),
                    type: tool.schema
                        .enum(["decision", "pattern", "constraint", "issue"])
                        .optional()
                        .describe("Entry type"),
                    tags: tool.schema.array(tool.schema.string()).optional().describe("Tags"),
                },
                async execute(args) {
                    const result = await callFrierenTool("diary_write", args);
                    return extractResultText(result);
                },
            }),
            diary_read: tool({
                description: "Read an agent's diary entries",
                args: {
                    agent_id: tool.schema.string().describe("Agent identifier"),
                    last_n: tool.schema.number().optional().describe("Number of recent entries"),
                    type: tool.schema
                        .enum(["decision", "pattern", "constraint", "issue"])
                        .optional()
                        .describe("Filter by entry type"),
                },
                async execute(args) {
                    const result = await callFrierenTool("diary_read", args);
                    return extractResultText(result);
                },
            }),
        },
    };
};
export default FrierenBridgePlugin;
