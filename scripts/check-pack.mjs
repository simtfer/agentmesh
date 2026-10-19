// Guards the one packaging failure that is invisible locally: `dist/` is
// gitignored, so a fresh clone that runs `npm publish` without `npm run build`
// uploads a tarball whose `bin` entry points at a file that is not in it.
// Everything the `bin`/`exports` map promises must be inside the tarball, and
// nothing from the working tree that a consumer should not receive.
import { execFileSync } from "node:child_process";

const REQUIRED = [
  // `bin` and `exports` in package.json point here; without them the package
  // installs and then fails at the first command.
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  // The master playbook is read at runtime by the MCP instructions.
  "skills/agentmesh-master/SKILL.md",
  // npm refuses a package with no README; the zh one is what a Chinese reader
  // lands on and is shipped deliberately.
  "README.md",
  "README.zh.md",
  "LICENSE",
  "agentmesh.yaml",
];

const FORBIDDEN = [
  [/^src\//, "TypeScript sources are compiled into dist/"],
  [/^test\//, "tests are not part of the published artifact"],
  [/^\.github\//, "CI config does not belong in the package"],
  [/^\.agentmesh/, "local runtime state must never be published"],
  [/\.tsbuildinfo$/, "build cache"],
  [/(^|\/)\.env/, "secrets"],
];

const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;

/** `npm pack` runs `prepack`; if a build were ever added there this would mask
 * an empty-dist bug, so pass --ignore-scripts and require a prior build. */
function packJson() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  // npm can print warnings before the JSON array; take the last JSON document.
  const start = out.lastIndexOf("\n[") >= 0 ? out.lastIndexOf("\n[") + 1 : out.indexOf("[");
  return JSON.parse(out.slice(start))[0];
}

const problems = [];

const info = packJson();
const files = info.files.map((f) => f.path);
const present = new Set(files);

for (const want of REQUIRED) {
  if (!present.has(want)) problems.push(`missing from tarball: ${want}`);
}

for (const file of files) {
  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(file)) problems.push(`unexpected in tarball: ${file} (${why})`);
  }
}

if (info.unpackedSize > MAX_UNPACKED_BYTES) {
  problems.push(
    `unpacked size ${(info.unpackedSize / 1024 / 1024).toFixed(1)} MiB exceeds ` +
      `${MAX_UNPACKED_BYTES / 1024 / 1024} MiB`,
  );
}

const size = `${(info.size / 1024).toFixed(0)} kB packed / ${(info.unpackedSize / 1024).toFixed(0)} kB unpacked`;

if (problems.length) {
  console.error(`pack check FAILED — ${info.filename}, ${files.length} files, ${size}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`pack check PASS — ${info.filename}, ${files.length} files, ${size}`);
