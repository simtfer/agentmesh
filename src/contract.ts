// Named import: ajv is CJS and under NodeNext the default import is the module
// namespace, which is not constructable.
import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";

/**
 * Structured result contracts.
 *
 * A master that submits `outputSchema` gets a machine-checkable result back: the
 * worker is told to answer with one JSON value, and agentmesh parses that value
 * out of the reply and validates it before the task is allowed to settle
 * `succeeded`. The contract is enforced rather than advisory — a reply that does
 * not satisfy it fails the task with the raw text still attached, because a
 * contract nobody checks is just a comment.
 */

/** Refuse schemas larger than this at submit time (a schema is prompt payload). */
export const MAX_SCHEMA_BYTES = 16 * 1024;

/** Codes this module can produce; the task layer maps them straight to errors. */
export type ContractFailureCode =
  | "output_schema_too_large"
  | "output_schema_invalid"
  | "output_not_json";

export interface ContractFailure {
  code: ContractFailureCode;
  message: string;
  /** JSON-pointer-ish paths from the validator, capped for prompt/response size. */
  errors?: Array<{ path: string; message: string }>;
}

export interface ContractCheck {
  ok: boolean;
  value?: unknown;
  failure?: ContractFailure;
}

function schemaSize(schema: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(schema), "utf8");
}

/**
 * Ajv instances are cheap to keep but not thread-safe during compilation, and a
 * master can submit arbitrarily many distinct schemas — so compile per call and
 * cache by serialized schema, bounded so a long-lived master cannot grow this
 * map without limit.
 */
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
const MAX_CACHED_SCHEMAS = 128;

function compile(schema: Record<string, unknown>) {
  // `$schema` may name a draft this Ajv build does not ship (e.g. 2020-12).
  // Dropping it and applying draft-07 keyword semantics is predictable and keeps
  // the common subset working; `prefixItems`-era keywords are out of scope.
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  const key = JSON.stringify(rest);
  const hit = compiled.get(key);
  if (hit) return hit;
  const fn = ajv.compile(rest);
  if (compiled.size >= MAX_CACHED_SCHEMAS) compiled.clear();
  compiled.set(key, fn);
  return fn;
}

function formatErrors(errors: ErrorObject[] | null | undefined): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  for (const e of errors ?? []) {
    out.push({
      path: e.instancePath && e.instancePath.length > 0 ? e.instancePath : "/",
      message: `${e.message ?? "invalid"}${e.params && Object.keys(e.params).length > 0 ? ` ${JSON.stringify(e.params)}` : ""}`,
    });
    // A schema with `allErrors` can produce dozens of errors for one mistake;
    // the first handful is what a caller can act on.
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Pull a JSON value out of an agent reply.
 *
 * Real agents wrap JSON in prose or a ```json fence even when told not to, so
 * this tries, in order: the whole trimmed reply, a fenced block, then the first
 * balanced `{...}` / `[...]` region anywhere in the text. Returns `undefined`
 * when nothing parses — the caller turns that into `output_not_json`.
 */
export function extractJson(raw: string): { value: unknown } | undefined {
  const text = raw.trim();
  if (text.length === 0) return undefined;

  const whole = tryParse(text);
  if (whole.ok) return { value: whole.value };

  for (const fenced of fencedBlocks(text)) {
    const r = tryParse(fenced);
    if (r.ok) return { value: r.value };
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const slice = balancedSlice(text, i);
    if (!slice) continue;
    const r = tryParse(slice);
    if (r.ok) return { value: r.value };
  }
  return undefined;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Content of ```… / ```json … fences, in document order. */
function* fencedBlocks(text: string): Generator<string> {
  const re = /```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    if (body && body.trim().length > 0) yield body.trim();
  }
}

/**
 * From `start` (a `{` or `[`), return the balanced slice, or `undefined` if it
 * never closes. Only the opening bracket's own pair is counted: inside valid
 * JSON a `}` can never appear inside an array without being inside a string, so
 * one counter plus string/escape tracking is enough.
 */
function balancedSlice(text: string, start: number): string | undefined {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Validate an already-parsed value against the schema. */
export function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: boolean; errors: Array<{ path: string; message: string }> } {
  let fn;
  try {
    fn = compile(schema);
  } catch (err) {
    // A schema Ajv itself rejects is the caller's bug: report it as a schema
    // problem, not as a bad answer from the worker.
    return {
      valid: false,
      errors: [{ path: "/", message: `schema is not usable: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
  const valid = fn(value) as boolean;
  return { valid, errors: valid ? [] : formatErrors(fn.errors) };
}

/**
 * The prompt block appended at run time. Ephemeral like the handoff envelope:
 * the stored prompt keeps the master's original text.
 */
export function buildContractInstruction(schema: Record<string, unknown>): string {
  const pretty = JSON.stringify(schema, null, 2);
  return [
    "---",
    "OUTPUT CONTRACT (enforced by the orchestrator)",
    "",
    "Your final answer must be exactly ONE JSON value that validates against the",
    "JSON Schema below. Reply with raw JSON only: no prose before or after, no",
    "markdown code fence, no comments, no trailing explanation. If you cannot",
    "satisfy the schema, reply with the closest valid JSON you can produce.",
    "",
    "<json-schema>",
    pretty,
    "</json-schema>",
  ].join("\n");
}

/** Full submit-time check: size now, parse+validate later. */
export function checkSchemaSize(schema: Record<string, unknown>): ContractFailure | undefined {
  const bytes = schemaSize(schema);
  if (bytes <= MAX_SCHEMA_BYTES) return undefined;
  return {
    code: "output_schema_too_large",
    message: `outputSchema is ${bytes} bytes; the limit is ${MAX_SCHEMA_BYTES} (it is injected into the prompt)`,
  };
}

/**
 * Parse the worker's final text and validate it against the contract. Every
 * failure carries a code the task layer turns into the task's error.
 */
export function checkAgainstContract(schema: Record<string, unknown>, text: string): ContractCheck {
  const extracted = extractJson(text);
  if (!extracted) {
    return {
      ok: false,
      failure: {
        code: "output_not_json",
        message: "worker reply contains no parseable JSON value, but the task was submitted with an outputSchema",
      },
    };
  }
  const { valid, errors } = validateValue(schema, extracted.value);
  if (!valid) {
    const first = errors[0];
    return {
      ok: false,
      failure: {
        code: "output_schema_invalid",
        message: `worker reply is valid JSON but violates the outputSchema${
          first ? ` (${errors.length} error${errors.length === 1 ? "" : "s"}; first at ${first.path}: ${first.message})` : ""
        }`,
        errors,
      },
    };
  }
  return { ok: true, value: extracted.value };
}
