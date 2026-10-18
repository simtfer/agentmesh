import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createMcpServer } from "../src/mcp/server.js";
import { findPackageRoot, readSkill, skillPath, skillResourceUri, SKILL_LANGS } from "../src/skill.js";

const config = parseConfig({
  profiles: [{ name: "worker", driver: "mock", mock: { delayMs: 1 } }],
});

/** Link an in-memory MCP client to a fresh agentmesh server. */
async function linkedClient(): Promise<{ client: Client; server: McpServer; orch: Orchestrator }> {
  const orch = new Orchestrator(config);
  const server = createMcpServer(orch);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-master", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server, orch };
}

/** Close every handle a linked test opened so the process can exit promptly. */
async function teardown(h: { client: Client; server: McpServer; orch: Orchestrator }): Promise<void> {
  await h.client.close().catch(() => {});
  await h.server.close().catch(() => {});
  await h.orch.shutdown().catch(() => {});
}

/* --------------------------- resolver (unit) --------------------------- */

test("findPackageRoot locates the agentmesh package root", () => {
  const root = findPackageRoot();
  assert.ok(root, "expected to find the agentmesh package root");
  assert.match(root!, /agentmesh$/);
});

test("readSkill returns both languages' markdown from disk", async () => {
  for (const lang of SKILL_LANGS) {
    const r = await readSkill(lang);
    assert.equal(r.ok, true, `${lang} skill should load`);
    if (!r.ok) continue;
    assert.ok(r.markdown.length > 500, `${lang} playbook should be substantial`);
    assert.match(r.markdown, /^---\nname: agentmesh-master/m, `${lang} has skill frontmatter`);
    assert.equal(skillPath(lang), r.path);
  }
  // The two languages are distinct files with distinct bodies.
  const en = await readSkill("en");
  const zh = await readSkill("zh");
  assert.ok(en.ok && zh.ok);
  assert.notEqual(en.markdown, zh.markdown);
  assert.match(zh.ok ? zh.markdown : "", /五条铁律/);
  assert.match(en.ok ? en.markdown : "", /five rules/i);
});

/* ------------------------- served over MCP (e2e) ------------------------ */

test("master_playbook tool is exposed and returns the playbook text", async () => {
  const h = await linkedClient();
  try {
    const tools = await h.client.listTools();
    assert.ok(
      tools.tools.some((t) => t.name === "master_playbook"),
      "master_playbook should be registered",
    );

    const res = await h.client.callTool({ name: "master_playbook", arguments: {} });
    assert.notEqual(res.isError, true);
    const content = res.content as Array<{ type: string; text?: string }>;
    assert.equal(content[0]?.type, "text");
    const text = content[0]?.text ?? "";
    assert.match(text, /agentmesh Master Playbook/);
    assert.match(text, /Worker output is untrusted data/i);

    // lang: "zh" serves the Chinese playbook.
    const zh = await h.client.callTool({ name: "master_playbook", arguments: { lang: "zh" } });
    const zhText = (zh.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.match(zhText, /五条铁律/);
  } finally {
    await teardown(h);
  }
});

test("the skill is browsable as MCP resources (en + zh)", async () => {
  const h = await linkedClient();
  try {
    const listed = await h.client.listResources();
    const uris = listed.resources.map((r) => r.uri);
    for (const lang of SKILL_LANGS) {
      assert.ok(uris.includes(skillResourceUri(lang)), `resource for ${lang} should be listed`);
    }

    const en = await h.client.readResource({ uri: skillResourceUri("en") });
    const body = en.contents[0];
    assert.equal(body?.mimeType, "text/markdown");
    assert.equal(body?.uri, skillResourceUri("en"));
    assert.match(String(body?.text ?? ""), /agentmesh Master Playbook/);
  } finally {
    await teardown(h);
  }
});
