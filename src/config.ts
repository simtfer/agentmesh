import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { MeshConfig, WorkerProfile } from "./types.js";

const MockBehavior = z.object({
  reply: z.string().optional(),
  delayMs: z.number().int().nonnegative().optional(),
  failOn: z.string().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  requireApproval: z.boolean().optional(),
});

const Profile = z.object({
  name: z.string().min(1),
  driver: z.enum(["acpx", "mock"]),
  agent: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  permissionMode: z.string().optional(),
  worktree: z.boolean().optional(),
  mock: MockBehavior.optional(),
  description: z.string().optional(),
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
