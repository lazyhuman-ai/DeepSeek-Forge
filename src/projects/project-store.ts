import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type ProjectStatus = "active" | "archived" | "missing";
export type ProjectTrustState = "trusted" | "untrusted";

export type Project = {
  id: string;
  name: string;
  path: string;
  status: ProjectStatus;
  trustState: ProjectTrustState;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
};

export type CreateProjectInput = {
  name?: string;
  path?: string;
  create?: boolean;
  trustState?: ProjectTrustState;
};

type ProjectStateFile = {
  schema: "forge.projects.v1";
  projects: Project[];
  defaultProjectId?: string;
  currentProjectId?: string;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

function safeProjectId(path: string): string {
  return `proj_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function defaultName(path: string): string {
  return basename(path) || "Workspace";
}

function normalizeProject(input: Project): Project {
  const status: ProjectStatus = input.status === "archived"
    ? "archived"
    : existsSync(input.path)
      ? "active"
      : "missing";
  return {
    ...input,
    name: input.name || defaultName(input.path),
    status,
    trustState: input.trustState === "untrusted" ? "untrusted" : "trusted",
  };
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function defaultWorkspacePath(): string {
  return process.env.FORGE_DEFAULT_WORKSPACE_PATH ||
    join(homedir(), "Documents", "ForgeAgent Workspace");
}

export class ProjectStore {
  #rootDir: string;
  #statePath: string;

  constructor(rootDir = ".forge/projects") {
    this.#rootDir = rootDir;
    this.#statePath = join(rootDir, "state.json");
    mkdirSync(this.#rootDir, { recursive: true });
  }

  list(): Project[] {
    const state = this.#readState();
    return state.projects.map(normalizeProject);
  }

  get(id: string): Project | null {
    return this.list().find((project) => project.id === id) ?? null;
  }

  getCurrentProject(): Project {
    const state = this.#readState();
    const current = state.currentProjectId
      ? this.get(state.currentProjectId)
      : null;
    if (current && current.status !== "archived") return current;
    return this.ensureDefaultProject();
  }

  ensureDefaultProject(): Project {
    const path = resolve(defaultWorkspacePath());
    const state = this.#readState();
    const existing = state.defaultProjectId
      ? state.projects.find((project) => project.id === state.defaultProjectId)
      : state.projects.find((project) => project.path === path);
    if (existing) {
      mkdirSync(existing.path, { recursive: true });
      const normalized = normalizeProject({
        ...existing,
        status: "active",
        lastOpenedAt: now(),
        updatedAt: now(),
      });
      this.#upsert(normalized, { defaultProjectId: normalized.id, currentProjectId: normalized.id });
      return normalized;
    }
    return this.create({
      name: "ForgeAgent Workspace",
      path,
      create: true,
      trustState: "trusted",
    }, { markDefault: true, markCurrent: true });
  }

  ensureProjectForPath(path: string, options?: { name?: string; current?: boolean }): Project {
    const input: CreateProjectInput = {
      path,
      create: false,
      trustState: "trusted",
    };
    if (options?.name !== undefined) input.name = options.name;
    return this.create(input, { markCurrent: options?.current === true });
  }

  create(input: CreateProjectInput, options?: { markDefault?: boolean; markCurrent?: boolean }): Project {
    const path = resolve(input.path || defaultWorkspacePath());
    if (input.create) {
      mkdirSync(path, { recursive: true });
    }
    if (!existsSync(path)) {
      throw new Error(`Workspace folder does not exist: ${path}`);
    }
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${path}`);
    }
    const canonicalPath = realpathSync(path);
    const timestamp = now();
    const state = this.#readState();
    const existing = state.projects.find((project) => project.path === canonicalPath);
    const project: Project = normalizeProject(existing ? {
      ...existing,
      name: input.name?.trim() || existing.name,
      trustState: input.trustState ?? existing.trustState,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
    } : {
      id: safeProjectId(canonicalPath) || `proj_${randomUUID()}`,
      name: input.name?.trim() || defaultName(canonicalPath),
      path: canonicalPath,
      status: "active",
      trustState: input.trustState ?? "trusted",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
    });
    const upsertOptions: { defaultProjectId?: string; currentProjectId?: string } = {};
    if (options?.markDefault) upsertOptions.defaultProjectId = project.id;
    if (options?.markCurrent) upsertOptions.currentProjectId = project.id;
    this.#upsert(project, upsertOptions);
    return project;
  }

  update(id: string, patch: { name?: string; trustState?: ProjectTrustState; lastOpenedAt?: string }): Project {
    const state = this.#readState();
    const index = state.projects.findIndex((project) => project.id === id);
    if (index < 0) throw new Error(`Project not found: ${id}`);
    const current = state.projects[index]!;
    const next = normalizeProject({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name.trim() || current.name } : {}),
      ...(patch.trustState !== undefined ? { trustState: patch.trustState } : {}),
      ...(patch.lastOpenedAt !== undefined ? { lastOpenedAt: patch.lastOpenedAt } : {}),
      updatedAt: now(),
    });
    state.projects[index] = next;
    state.updatedAt = now();
    this.#writeState(state);
    return next;
  }

  select(id: string): Project {
    const project = this.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const selected = this.update(project.id, { lastOpenedAt: now() });
    const state = this.#readState();
    state.currentProjectId = selected.id;
    state.updatedAt = now();
    this.#writeState(state);
    return selected;
  }

  archive(id: string): Project {
    const state = this.#readState();
    const index = state.projects.findIndex((project) => project.id === id);
    if (index < 0) throw new Error(`Project not found: ${id}`);
    const archived = {
      ...state.projects[index]!,
      status: "archived" as const,
      updatedAt: now(),
    };
    state.projects[index] = archived;
    if (state.currentProjectId === id) delete state.currentProjectId;
    state.updatedAt = now();
    this.#writeState(state);
    return archived;
  }

  #upsert(project: Project, options?: { defaultProjectId?: string; currentProjectId?: string }): void {
    const state = this.#readState();
    const index = state.projects.findIndex((existing) => existing.id === project.id || existing.path === project.path);
    if (index >= 0) {
      state.projects[index] = project;
    } else {
      state.projects.push(project);
    }
    if (options?.defaultProjectId) state.defaultProjectId = options.defaultProjectId;
    if (options?.currentProjectId) state.currentProjectId = options.currentProjectId;
    state.updatedAt = now();
    this.#writeState(state);
  }

  #readState(): ProjectStateFile {
    const raw = readJson<Partial<ProjectStateFile>>(this.#statePath, {});
    return {
      schema: "forge.projects.v1",
      projects: Array.isArray(raw.projects) ? raw.projects.map((project) => normalizeProject(project)) : [],
      ...(typeof raw.defaultProjectId === "string" ? { defaultProjectId: raw.defaultProjectId } : {}),
      ...(typeof raw.currentProjectId === "string" ? { currentProjectId: raw.currentProjectId } : {}),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now(),
    };
  }

  #writeState(state: ProjectStateFile): void {
    atomicWrite(this.#statePath, JSON.stringify(state, null, 2));
  }
}
