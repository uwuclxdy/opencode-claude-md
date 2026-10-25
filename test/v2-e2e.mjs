/**
 * e2e: the plugin under an opencode v2 runtime.
 *
 * Boots a local capture provider (openai-compatible, SSE), a fixture project
 * whose instruction layout can only be delivered by this plugin, and drives
 * `opencode run` through a scripted four-turn exchange (read a file in
 * sub/, cat a file in sub3/ via the shell tool, edit a file in sub2/, then
 * answer). Assertions run over the captured
 * model requests:
 *
 *   1. every request carries the ANCESTOR marker exactly once in a system
 *      channel (system field or a system-role message) — plugin loaded
 *      under v2, setup ran, the context hook injects the ancestor chain on
 *      every primary model call, and the session's directory (not the
 *      plugin's load location) was used
 *   2. request 2 carries the SUB marker inside the read tool result;
 *      request 3 carries the SUB3 marker inside the shell tool result of a
 *      single-file `cat`; request 4 carries the SUB2 marker inside the edit
 *      tool result — lazy subtree attach works for every file-touching tool
 *   3. requests 2 and 3 carry the ANCESTOR marker only in the system
 *      channel, never in a tool result — injection and subtree attach stay
 *      separate
 *   4. every request's system channel carries the ESCAPED marker (a
 *      backslash-escaped-space import resolves to one path) and never the
 *      QUOTED marker (a quoted import path is never imported)
 *   5. the system channel carries the COMMENT-IN marker (HTML comments
 *      survive inside fenced code blocks) and never the COMMENT-OUT marker
 *      (comments outside code are stripped)
 *   6. run 1 never carries the GLOBAL marker — claudeMdExcludes (a glob,
 *      read from the user settings scope) drops the user-global file while
 *      the ancestor chain stays injected
 *   7. run 2 (CLAUDE_CODE_DISABLE_CLAUDE_MDS=1) carries none of the
 *      markers — the off-switch injects nothing
 *
 * Isolation: every user-writable root is redirected into the fixture
 * (HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME);
 * BUN_INSTALL stays pinned so the launcher resolves. `--standalone` keeps
 * the app off any shared background service.
 *
 * Env:
 *   OPENCODE_BIN   required: an opencode v2 launcher (script or binary).
 *                  Source checkout wrapper: `exec bun run --cwd <repo>/packages/cli src/index.ts "$@"`
 *   OPENCODE_PLUGIN_ENTRY  optional: plugins-config entry for this repo
 *                  (default: `file://<this repo>`)
 *   E2E_NO_PLUGIN  optional: set to load no plugin — control run proving
 *                  the markers come only from the plugin
 *   E2E_KEEP       optional: keep the fixture dir (path is printed); the
 *                  default deletes it at exit
 *   E2E_DUMP       optional: write captured request bodies to <fixture>/bodies.json
 *   E2E_VERBOSE    optional: dump the app's full output
 *
 * Red contract: on V1-only code this fails at assertion 1 (v2 runtimes do
 * not run V1 plugin implementations).
 */
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = process.env.OPENCODE_BIN
const PLUGIN_ENTRY = process.env.OPENCODE_PLUGIN_ENTRY ?? `file://${REPO}`
const ANCESTOR = "OCM-E2E-ANCESTOR-MARKER"
const COMMENT_IN = "OCM-E2E-COMMENT-IN-MARKER"
const COMMENT_OUT = "OCM-E2E-COMMENT-OUT-MARKER"
const GLOBAL = "OCM-E2E-GLOBAL-MARKER"
const ESCAPED = "OCM-E2E-ESCAPED-IMPORT-MARKER"
const QUOTED = "OCM-E2E-QUOTED-IMPORT-MARKER"
const SUB = "OCM-E2E-SUBDIR-MARKER"
const SUB2 = "OCM-E2E-SUBDIR2-MARKER"
const SUB3 = "OCM-E2E-SUBDIR3-MARKER"

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}
if (!BIN) fail("set OPENCODE_BIN to an opencode v2 launcher")
if (!PLUGIN_ENTRY.startsWith("file://") && !PLUGIN_ENTRY.startsWith("/")) {
  fail("OPENCODE_PLUGIN_ENTRY must be a file:// URL or absolute path")
}

// --- canned model: read -> edit -> final text ------------------------------

function sse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
}
const chunk = (delta, finish) => ({
  id: "chatcmpl-e2e",
  object: "chat.completion.chunk",
  created: 0,
  model: "test",
  choices: [{ index: 0, delta, finish_reason: finish ?? null }],
})

// v2 read/edit inputs name the target `path`; edit also takes oldString/newString
function toolCallChunks(name, args) {
  const a = JSON.stringify(args)
  return [
    chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: a } }] }),
    chunk({}, "tool_calls"),
  ]
}
const textChunks = [chunk({ role: "assistant", content: "e2e done" }), chunk({}, "stop")]

const requests = []
let turn = 0
const capture = createServer((req, res) => {
  if (req.method === "POST") {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      requests.push({ turn: turn++, path: req.url, body: JSON.parse(body || "{}") })
      sse(
        res,
        requests.length === 1
          ? toolCallChunks("read", { path: "sub/file.txt" })
          : requests.length === 2
            ? toolCallChunks("shell", { command: "cat sub3/notes.txt" })
            : requests.length === 3
              ? toolCallChunks("edit", { path: "sub2/other.txt", oldString: "second subdir payload", newString: "second subdir payload (edited)" })
              : textChunks,
      )
    })
    return
  }
  res.writeHead(404).end()
})

// --- fixture (fully out of tree; only $HOME-derived roots are redirected) --

const fixture = mkdtempSync(join(tmpdir(), "ocm-e2e-"))
const xdg = join(fixture, "xdg")
const home = join(fixture, "home")
const project = join(fixture, "fixture-root", "project")
for (const d of [
  join(xdg, "config"),
  join(xdg, "data"),
  join(xdg, "state"),
  join(xdg, "cache"),
  join(home, ".bun"),
  join(home, ".claude"),
  project,
  join(project, "sub"),
  join(project, "sub2"),
  join(project, "sub3"),
  join(fixture, "fixture-root", "Design Docs"),
]) {
  mkdirSync(d, { recursive: true })
}
// parent dir above the project: only our plugin walks the ancestor chain;
// the import lines pin the scanner: a quoted path is never imported, a
// backslash-escaped space joins into one path
writeFileSync(join(fixture, "fixture-root", "CLAUDE.md"), `parent-level instructions\n${ANCESTOR}\n@Design\\ Docs/x.md\n@"quoted-target.md"\n<!-- stripped outside code: ${COMMENT_OUT} -->\n\n\`\`\`\n<!-- preserved inside a fence: ${COMMENT_IN} -->\n\`\`\`\n`)
writeFileSync(join(fixture, "fixture-root", "Design Docs", "x.md"), `design docs payload\n${ESCAPED}\n`)
writeFileSync(join(fixture, "fixture-root", "quoted-target.md"), `quoted target payload\n${QUOTED}\n`)
writeFileSync(join(project, "CLAUDE.md"), "# project instructions\nroot file (may also be picked up natively)\n")
writeFileSync(join(project, "sub", "CLAUDE.md"), `subdir instructions\n${SUB}\n`)
writeFileSync(join(project, "sub", "file.txt"), "subdir payload\n")
writeFileSync(join(project, "sub2", "CLAUDE.md"), `second subdir instructions\n${SUB2}\n`)
writeFileSync(join(project, "sub2", "other.txt"), "second subdir payload\n")
writeFileSync(join(project, "sub3", "CLAUDE.md"), `third subdir instructions\n${SUB3}\n`)
writeFileSync(join(project, "sub3", "notes.txt"), "third subdir payload\n")
// claude code reads claudeMdExcludes from its settings scopes; the glob below
// must drop the user-global file while the ancestor file stays injected
writeFileSync(join(home, ".claude", "CLAUDE.md"), `user global instructions\n${GLOBAL}\n`)
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ claudeMdExcludes: ["**/.claude/CLAUDE.md"] }, null, 2))

const opencodeJson = {
  $schema: "https://opencode.ai/config.json",
  plugins: process.env.E2E_NO_PLUGIN ? [] : [PLUGIN_ENTRY],
  providers: {
    capture: {
      name: "Capture",
      package: "@opencode/ai/providers/openai-compatible",
      env: ["CAPTURE_API_KEY"],
      settings: { baseURL: "" },
      models: { test: { name: "Test Model" } },
    },
  },
}

// --- run ------------------------------------------------------------------

if (!process.env.E2E_SKIP_INSTALL) {
  const inst = spawnSync("bun", ["install"], { cwd: REPO, encoding: "utf8" })
  if (inst.status !== 0) fail(`bun install in ${REPO} failed:\n${inst.stderr}`)
}

await new Promise((ok) => capture.listen(0, "127.0.0.1", ok))
const port = capture.address().port
opencodeJson.providers.capture.settings = { baseURL: `http://127.0.0.1:${port}/v1` }
writeFileSync(join(project, "opencode.json"), JSON.stringify(opencodeJson, null, 2))

// v2's session runner resolves a workspace from the VCS root; without a git
// repo the location lands elsewhere and the fixture config never loads
const ginit = spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8" })
if (ginit.error || ginit.status !== 0) fail(`git init in the fixture failed: ${ginit.error ?? ginit.stderr}`)

const runEnv = {
  ...process.env,
  HOME: home,
  // v2 resolves the session location from $PWD, which spawn's cwd does not update
  PWD: project,
  BUN_INSTALL: process.env.BUN_INSTALL ?? join(homedir(), ".bun"),
  XDG_CONFIG_HOME: join(xdg, "config"),
  XDG_DATA_HOME: join(xdg, "data"),
  XDG_STATE_HOME: join(xdg, "state"),
  XDG_CACHE_HOME: join(xdg, "cache"),
  CAPTURE_API_KEY: "e2e-dummy",
}
// --title suppresses v2's title-generation request (untitled root sessions
// fork a title call that falls back to the primary model and would land in
// requests[0]); assertions index the primary request
const runArgs = ["run", "--standalone", "--auto", "--format", "json", "--title", "e2e", "--log-level", "debug", "--print-logs", "-m", "capture/test", "read the file sub/file.txt then edit sub2/other.txt then say done"]
// async spawn: the capture server shares this process's event loop, so a
// sync wait would freeze it and leave the app's requests unanswered
const runOpencode = async (extraEnv) => {
  const startedAt = requests.length
  const child = spawn(BIN, runArgs, { cwd: project, env: { ...runEnv, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] })
  const childPid = child.pid
  let out = ""
  let errlog = ""
  child.stdout.on("data", (c) => (out += c))
  child.stderr.on("data", (c) => (errlog += c))
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 90_000)
  const [code, signal] = await new Promise((res) => {
    child.on("close", (c, s) => res([c, s]))
  })
  clearTimeout(killTimer)
  // the probe's direct child must not outlive the test: the recorded pid is
  // the only liveness handle; kill and assert removal by that pid, never a
  // pattern (grandchildren are not tracked — the check may false-fail, never
  // false-pass)
  let stray = false
  if (childPid && existsSync(`/proc/${childPid}`)) {
    stray = true
    try {
      process.kill(childPid, "SIGKILL")
    } catch {}
    stray = existsSync(`/proc/${childPid}`)
  }
  if (stray) fail(`opencode process ${childPid} outlived the run — cleanup asserted, not assumed`)
  const log = out + "\n--- stderr ---\n" + errlog
  console.error(`app: status=${code} signal=${signal} stdout=${out.length}B stderr=${errlog.length}B requests=${requests.length - startedAt} fixture=${fixture}`)
  if (process.env.E2E_VERBOSE) console.log(log)
  if (signal) fail(`opencode run was killed (${signal}) — likely the 90s timeout; output tail:\n${log.slice(-3000)}`)
  if (code !== 0) fail(`opencode run exited ${code}; output tail:\n${log.slice(-3000)}`)
  return requests.slice(startedAt)
}

const first = await runOpencode()
// claude code's off-switch: with the env set, nothing is injected at all
const second = await runOpencode({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" })

capture.close()

let passed = false
const cleanupFixture = () => {
  if (!process.env.E2E_KEEP && passed) rmSync(fixture, { recursive: true, force: true })
}
process.on("exit", cleanupFixture)

if (process.env.E2E_DUMP) writeFileSync(join(fixture, "bodies.json"), JSON.stringify(requests, null, 2))

// --- assertions ------------------------------------------------------------

if (first.length < 4) {
  // the fixture survives failures: its state dir holds the app's own debug log
  fail(`expected >=4 captured model requests in run 1, got ${first.length}`)
}
if (second.length < 1) {
  fail(`expected >=1 captured model request in run 2 (the off-switch run), got 0`)
}

const sysChannel = (body) => {
  const system = JSON.stringify(body.system ?? "")
  const systemMessages = (body.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => JSON.stringify(m))
    .join("")
  return system + systemMessages
}
const toolChannel = (body) =>
  (body.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => JSON.stringify(m))
    .join("")

for (const [i, req] of first.entries()) {
  const sys = sysChannel(req.body)
  const n = (sys.match(new RegExp(ANCESTOR, "g")) ?? []).length
  if (process.env.E2E_DEBUG) console.error(`DBG req${i + 1}: syslen=${sys.length} n=${n} roles=${JSON.stringify((req.body.messages ?? []).map((m) => m.role))}`)
  if (n !== 1) fail(`request ${i + 1} carries the ancestor marker ${n}x in a system channel (want exactly 1) — injection is not per model call.`)
  if (sys.includes(GLOBAL)) fail(`request ${i + 1} carries the excluded user-global marker — claudeMdExcludes was not honored`)
}

if (!toolChannel(first[1].body).includes(SUB)) {
  fail(`request 2 carries no read-subdir marker inside a tool-role message — the read attach did not land.\ntool roles present: ${(first[1].body.messages ?? []).map((m) => m.role).join(",")}`)
}
if (!sysChannel(first[0].body).includes(ESCAPED)) {
  fail(`request 1 carries no escaped-import marker in a system channel — a backslash-escaped space did not join into one path`)
}
if (sysChannel(first[0].body).includes(QUOTED)) {
  fail(`request 1 carries the quoted-import marker in a system channel — a quoted import path must never be imported`)
}
if (!sysChannel(first[0].body).includes(COMMENT_IN)) {
  fail(`request 1 carries no in-fence comment marker in a system channel — HTML comments inside code blocks must survive injection`)
}
if (sysChannel(first[0].body).includes(COMMENT_OUT)) {
  fail(`request 1 carries the outside-code comment marker in a system channel — HTML comments outside code must be stripped`)
}

if (!toolChannel(first[2].body).includes(SUB3)) {
  fail(`request 3 carries no shell-subdir marker inside a tool-role message — the shell-read attach did not land.\ntool roles present: ${(first[2].body.messages ?? []).map((m) => m.role).join(",")}`)
}
if (!toolChannel(first[3].body).includes(SUB2)) {
  fail(`request 4 carries no edit-subdir marker inside a tool-role message — the edit attach did not land.\ntool roles present: ${(first[3].body.messages ?? []).map((m) => m.role).join(",")}`)
}
for (const [i, body] of [first[1].body, first[2].body, first[3].body].entries()) {
  if (toolChannel(body).includes(ANCESTOR)) fail(`request ${i + 2} leaks the ancestor marker into a tool result — injection and subtree attach mixed`)
}
for (const [i, req] of second.entries()) {
  const sys = sysChannel(req.body)
  if (sys.includes(ANCESTOR) || sys.includes(GLOBAL) || sys.includes(COMMENT_IN)) {
    fail(`off-switch run request ${i + 1} still carries injected instruction content — CLAUDE_CODE_DISABLE_CLAUDE_MDS must inject nothing`)
  }
}

passed = true
console.log("PASS: v2 e2e — per-call system injection, lazy subtree attach (read+shell+edit), claudeMdExcludes, off-switch")
