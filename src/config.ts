import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { MeshConfig, WorkerProfile } from "./types.js";

const MockBehavior = z.object({
  reply: z.string().optional(),
  replies: z.array(z.string()).optional(),
  stream: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional(),
  failOn: z.string().optional(),
  failFirst: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  requireApproval: z.boolean().optional(),
  writeFiles: z.record(z.string()).optional(),
  usage: z
    .object({
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
      cachedReadTokens: z.number().nonnegative().optional(),
      cachedWriteTokens: z.number().nonnegative().optional(),
      thoughtTokens: z.number().nonnegative().optional(),
      totalTokens: z.number().nonnegative().optional(),
      cost: z
        .object({ amount: z.number().nonnegative(), currency: z.string().optional() })
        .optional(),
      contextUsed: z.number().nonnegative().optional(),
      contextSize: z.number().nonnegative().optional(),
      reports: z.number().int().positive().optional(),
    })
    .optional(),
});

const RemoteSettings = z.object({
  endpoint: z.string().min(1),
  tokenEnv: z.string().optional(),
  remoteProfile: z.string().optional(),
  ca: z.string().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  resume: z.boolean().optional(),
  reconnectAttempts: z.number().int().nonnegative().optional(),
  reconnectDelayMs: z.number().int().nonnegative().optional(),
});

const Profile = z.object({
  name: z.string().min(1),
  driver: z.enum(["acpx", "mock", "remote"]),
  agent: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  permissionMode: z.string().optional(),
  worktree: z.boolean().optional(),
  session: z.string().min(1).optional(),
  weight: z.number().positive().optional(),
  mock: MockBehavior.optional(),
  remote: RemoteSettings.optional(),
  description: z.string().optional(),
});

const DaemonSettings = z.object({
  host: z.string().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  tokenEnv: z.string().optional(),
  allowCwd: z.array(z.string()).optional(),
  tls: z
    .object({
      cert: z.string().optional(),
      key: z.string().optional(),
      ca: z.string().optional(),
    })
    .optional(),
  exposeProfiles: z.array(z.string()).optional(),
  orphanGraceMs: z.number().int().nonnegative().optional(),
  /** keep a reused worker alive this long after its last turn (0 = forever) */
  workerIdleMs: z.number().int().nonnegative().optional(),
  auditPath: z.string().optional(),
  /** rotate the audit log at this many bytes (0 disables rotation) */
  auditMaxBytes: z.number().int().nonnegative().optional(),
  /** how many rotated audit archives to keep */
  auditKeep: z.number().int().nonnegative().optional(),
});

const TeamMember = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  role: z.string().optional(),
  profile: z.string().min(1),
  mention: z.string().optional(),
  cwd: z.string().optional(),
  notes: z.string().optional(),
});

const TeamChannel = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  members: z.array(z.string()).optional(),
});

/**
 * A team is declared, not created at runtime: identities, harness profiles and
 * workspaces are configuration (versionable, reviewable), while conversations
 * and inboxes are state (in `<stateDir>/team.sqlite`). That split is what lets
 * the same roster restart without losing what was said.
 */
const TeamSettings = z.object({
  name: z.string().optional(),
  stateDir: z.string().optional(),
  cwd: z.string().optional(),
  maxHops: z.number().int().positive().optional(),
  maxTurnsPerMessage: z.number().int().positive().optional(),
  contextMessages: z.number().int().positive().optional(),
  maxContextChars: z.number().int().positive().optional(),
  turnTimeoutMs: z.number().int().positive().optional(),
  host: z.string().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  tokenEnv: z.string().optional(),
  members: z.array(TeamMember).min(1),
  channels: z.array(TeamChannel).optional(),
});

const ConfigSchema = z.object({
  profiles: z.array(Profile).min(1),
  defaults: z
    .object({
      cwd: z.string().optional(),
      permissionMode: z.string().optional(),
      stateDir: z.string().optional(),
    })
    .optional(),
  workdir: z.string().optional(),
  daemon: DaemonSettings.optional(),
  team: TeamSettings.optional(),
  limits: z
    .object({
      maxDelegationDepth: z.number().int().nonnegative().optional(),
      maxConcurrentTasks: z.number().int().nonnegative().optional(),
      maxOutputBytes: z.number().int().nonnegative().optional(),
      maxQueuedTasks: z.number().int().nonnegative().optional(),
      queueTtlMs: z.number().int().nonnegative().optional(),
      maxHandoffBytes: z.number().int().nonnegative().optional(),
      maxRetryAttempts: z.number().int().positive().optional(),
      maxDependencies: z.number().int().positive().optional(),
      maxWaitingTasks: z.number().int().nonnegative().optional(),
      maxTotalTokens: z.number().int().nonnegative().optional(),
      maxTotalCost: z
        .object({
          amount: z.number().nonnegative(),
          currency: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export function parseConfig(raw: unknown): MeshConfig {
  const parsed = ConfigSchema.parse(raw);
  const names = new Set<string>();
  for (const p of parsed.profiles) {
    if (names.has(p.name)) throw new Error(`duplicate profile name: ${p.name}`);
    names.add(p.name);
    if (p.driver === "acpx" && !p.agent && !p.command) {
      // fall back to the profile name as the acpx agent name
      p.agent = p.name;
    }
    if (p.driver === "remote" && !p.remote?.endpoint) {
      throw new Error(`remote profile "${p.name}" requires remote.endpoint`);
    }
  }
  return parsed as MeshConfig;
}

export async function loadConfig(path: string): Promise<MeshConfig> {
  const text = await readFile(path, "utf8");
  return parseConfig(parseYaml(text));
}

export function getProfile(config: MeshConfig, name: string): WorkerProfile {
  const p = config.profiles.find((x) => x.name === name);
  if (!p) {
    const known = config.profiles.map((x) => x.name).join(", ");
    throw new Error(`unknown profile "${name}". known profiles: ${known}`);
  }
  return p;
}
