import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  anyTokenEqual,
  bearerFromHeader,
  isLoopbackHost,
  SecurityError,
} from "../remote/security.js";
import type { Team } from "./team.js";

export interface TeamServerOptions {
  team: Team;
  /** bind address; default 127.0.0.1 */
  host?: string;
  /** 0 picks a free port (tests) */
  port?: number;
  /**
   * Accepted bearer tokens. Empty means "no auth", which is only allowed on a
   * loopback bind: this API can make agents run tools, so it is equivalent to
   * local shell access.
   */
  tokens?: string[];
}

export interface TeamServerHandle {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1 << 20;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "invalid JSON body");
  }
}

function strField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  return v;
}

function intParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${key} must be a non-negative number`);
  return Math.trunc(n);
}

/**
 * A small HTTP face over one running team.
 *
 * The team object must live in a long-running process — its members are agent
 * sessions, not functions — so the CLI is a client, not the owner. That is also
 * what makes "look at what this member is doing right now" possible: the state
 * being observed is the daemon's live state, not a report about it.
 *
 * JSON only, no websocket: a turn can take minutes, and polling a cursor is a
 * lot more robust than holding a stream open across restarts.
 */
export async function startTeamServer(opts: TeamServerOptions): Promise<TeamServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const tokens = (opts.tokens ?? []).filter(Boolean);
  if (!isLoopbackHost(host) && tokens.length === 0) {
    throw new SecurityError(
      "refusing to expose the team API on a non-loopback interface without a token " +
        "(set AGENTMESH_TEAM_TOKEN or bind 127.0.0.1)",
      "team_token_required",
    );
  }

  const team = opts.team;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://team.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (path === "/healthz") {
      send(res, 200, { ok: true, team: team.name });
      return;
    }

    if (tokens.length > 0) {
      const presented = bearerFromHeader(req.headers.authorization);
      if (!anyTokenEqual(presented, tokens)) {
        send(res, 401, { error: { code: "unauthorized", message: "missing or invalid bearer token" } });
        return;
      }
    }

    if (path === "/team" && method === "GET") {
      send(res, 200, { ...team.status(), approvals: team.approvals() });
      return;
    }

    if (path === "/team/channels" && method === "GET") {
      send(res, 200, { channels: team.channels() });
      return;
    }

    if (path === "/team/messages" && method === "GET") {
      const channel = url.searchParams.get("channel") ?? "general";
      send(res, 200, {
        channel,
        messages: team.messages(channel, intParam(url, "limit", 50), intParam(url, "after", 0)),
      });
      return;
    }

    if (path === "/team/messages" && method === "POST") {
      const body = await readJson(req);
      const text = strField(body, "text");
      if (!text) throw new HttpError(400, "text is required");
      const to = strField(body, "to");
      const channel = strField(body, "channel");
      // `to` is the private-chat shorthand; `channel` is the room. Both routes
      // end up in the same log, which is what makes DMs inspectable later.
      const posted = to
        ? team.dmWithTurns(to, text)
        : team.postWithTurns({ channel: channel ?? "general", text });
      // Return the turn ids as well: a client that wants to follow *this* message
      // should not have to guess when the team went quiet.
      send(res, 201, { message: posted.message, turns: posted.turns.map((t) => t.id) });
      return;
    }

    const turn = /^\/team\/turns\/([^/]+)$/.exec(path);
    if (turn && method === "GET") {
      const found = team.turn(decodeURIComponent(turn[1]!));
      if (!found) throw new HttpError(404, "no such turn");
      send(res, 200, { turn: found });
      return;
    }

    const transcript = /^\/team\/members\/([^/]+)\/transcript$/.exec(path);
    if (transcript && method === "GET") {
      const memberId = decodeURIComponent(transcript[1]!);
      send(res, 200, {
        memberId,
        turns: team.transcript(memberId, intParam(url, "limit", 20)),
      });
      return;
    }

    if (path === "/team/approvals" && method === "GET") {
      send(res, 200, { approvals: team.approvals() });
      return;
    }

    if (path === "/team/approvals" && method === "POST") {
      const body = await readJson(req);
      const approvalId = strField(body, "approvalId");
      if (!approvalId) throw new HttpError(400, "approvalId is required");

      // Two shapes, because they are genuinely different: a permission decision
      // unblocks a tool call, an elicitation answers a question the member asked.
      const action = strField(body, "action");
      if (action) {
        const actions = ["accept", "decline", "cancel"] as const;
        if (!(actions as readonly string[]).includes(action)) {
          throw new HttpError(400, `action must be one of: ${actions.join(", ")}`);
        }
        const content = body.content;
        if (content !== undefined && content !== null && (typeof content !== "object" || Array.isArray(content))) {
          throw new HttpError(400, "content must be a JSON object or null");
        }
        const resolved = team.respond(
          approvalId,
          action as (typeof actions)[number],
          (content ?? null) as Record<string, unknown> | null,
        );
        send(res, resolved ? 200 : 404, { approvalId, resolved });
        return;
      }

      const decision = strField(body, "decision") ?? "allow_once";
      const allowed = ["allow_once", "allow_always", "reject_once", "reject_always", "cancel"] as const;
      if (!(allowed as readonly string[]).includes(decision)) {
        throw new HttpError(400, `decision must be one of: ${allowed.join(", ")}`);
      }
      const resolved = team.approve(approvalId, decision as (typeof allowed)[number]);
      send(res, resolved ? 200 : 404, { approvalId, resolved });
      return;
    }

    throw new HttpError(404, `no route for ${method} ${path}`);
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        send(res, err.status, { error: { message: err.message, ...(err.code ? { code: err.code } : {}) } });
      } else if (err instanceof SecurityError) {
        send(res, 403, { error: { code: err.code, message: err.message } });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        send(res, 500, { error: { message } });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4317, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${displayHost}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
