// Smoke test: drive the agentmesh MCP server over stdio like a real master would.
import { spawn } from "node:child_process";

const child = spawn("npx", ["tsx", "src/cli.ts", "mcp", "--config", "agentmesh.yaml"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[server] " + d.toString()));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const request = (id, method, params) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  console.log("initialize ->", init.result?.serverInfo);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const tools = await request(2, "tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  console.log("tools ->", names.join(", "));

  const call = async (id, name, args) => {
    const r = await request(id, "tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? "";
    if (r.result?.isError) throw new Error(`${name} -> ${text}`);
    return JSON.parse(text);
  };

  const agents = await call(3, "agent_list", {});
  console.log("agent_list ->", agents.profiles.map((p) => p.name).join(", "));

  // --- synchronous delegate-and-wait ---
  const disp = await call(4, "dispatch_task", {
    profile: "mock-analyst", task: "summarize the auth module",
  });
  console.log("dispatch_task ->", disp.status, "| worker:", disp.workerId);
  console.log("  text:", disp.text.slice(0, 90));

  // --- async lifecycle: submit -> waiting -> approve -> succeeded ---
  const sub = await call(5, "task_submit", {
    profile: "mock-approver", prompt: "refactor the risky module",
  });
  console.log("task_submit ->", sub.taskId.slice(0, 8), `(${sub.status})`);

  let waited = await call(6, "task_wait", { taskId: sub.taskId, timeoutMs: 2000 });
  console.log("task_wait ->", waited.task.status, "| terminal:", waited.terminal);

  const pend = await call(7, "pending_approvals", { taskId: sub.taskId });
  if (!pend.approvals[0]) throw new Error("expected a pending approval for mock-approver");
  console.log("pending_approvals ->", pend.approvals[0].id, `[${pend.approvals[0].kind}]`);

  await call(8, "task_approve", { approvalId: pend.approvals[0].id, decision: "allow_once" });
  console.log("task_approve -> allow_once");

  const fin = await call(9, "task_wait", { taskId: sub.taskId, timeoutMs: 5000 });
  console.log("task_wait(final) ->", fin.task.status, "| terminal:", fin.terminal);

  const res = await call(10, "task_result", { taskId: sub.taskId });
  console.log("task_result ->", res.status, "|", (res.text ?? "").slice(0, 60));

  const events = await call(11, "task_events", { taskId: sub.taskId });
  const kinds = events.events.map((e) => e.type);
  console.log("task_events ->", kinds.join(","));

  const ok =
    names.includes("task_submit") &&
    disp.status === "completed" &&
    fin.task.status === "succeeded" &&
    kinds.includes("waiting") &&
    kinds.includes("resumed") &&
    kinds.includes("completed");
  console.log(ok ? "\nMCP SMOKE: PASS ✅" : "\nMCP SMOKE: FAIL ❌");
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("SMOKE ERROR:", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  process.exit(process.exitCode ?? 0);
}
