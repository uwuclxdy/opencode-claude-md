/**
 * opencode-claude-md — opencode plugin that loads CLAUDE.md files the way
 * Claude Code does at session start.
 *
 * Mirrors Claude Code's memory loading:
 *   - managed policy CLAUDE.md (per-OS path)
 *   - ~/.claude/CLAUDE.md (user global)
 *   - every CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md walking from
 *     the filesystem root down to the session's directory (ancestors
 *     first, session directory last)
 *   - subdirectory CLAUDE.md files lazily, attached to tool results when
 *     a tool first touches a file in that subtree
 *   - @path imports, max 4 hops, ignored inside code fences/spans and
 *     indented code blocks, confined to the worktree or the importing file's dir
 *   - HTML comments stripped outside code blocks, <system-reminder> tags in
 *     content escaped
 *   - claudeMdExcludes, read from the settings scopes claude code reads with
 *     the arrays merging, drops any injected file but the managed policy
 *     source; the claudeMd key inside managed-settings.json loads with the
 *     managed file's precedence
 *   - CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 injects nothing, managed policy included
 *
 * Skips whatever opencode's native instruction loader already injects
 * (<config>/AGENTS.md globally, plus every AGENTS.md between the session
 * directory and the project root) so nothing appears twice.
 *
 * Built on the opencode v2 plugin API: a default `Plugin.define` whose
 * setup registers a session `context` hook (the assembled block rides in
 * every primary model request's system parts, never persisted) and a tool
 * `execute.after` hook (lazy subtree attach).
 */

/// <reference types="bun-types" />
import { Plugin } from "@opencode/plugin"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const MAX_IMPORT_DEPTH = 4

const LABELS = {
  managed: "managed policy instructions",
  global: "user's private global instructions for all projects",
  project: "project instructions, checked into the codebase",
  local: "user's private project instructions, not checked in",
} as const

/** Tools whose result tells the model about a file below the session directory. */
const FILE_TOOLS: readonly string[] = ["read", "write", "edit"]

interface Block {
  path: string
  label: string
  content: string
}

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function pathExists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return undefined
  }
}

/**
 * The one shared reading of what is code in instruction text — fenced and
 * indented blocks — so comment stripping and import scanning can never
 * disagree about a line.
 */
function lineKinds(text: string): { line: string; isCode: boolean }[] {
  const kinds: { line: string; isCode: boolean }[] = []
  // a fence closes only on the same delimiter char, at least as long, bare line
  let fence: { char: string; len: number } | null = null
  for (const line of text.split("\n")) {
    const delim = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (
        delim &&
        delim[1][0] === fence.char &&
        delim[1].length >= fence.len &&
        /^\s*(?:`{3,}|~{3,})\s*$/.test(line)
      ) {
        fence = null
      }
      kinds.push({ line, isCode: true })
      continue
    }
    if (delim) {
      fence = { char: delim[1][0], len: delim[1].length }
      kinds.push({ line, isCode: true })
      continue
    }
    // a line indented >= 4 columns (tab = one stop) is a markdown indented
    // code block
    kinds.push({ line, isCode: /^(?:\t| {4})/.test(line) })
  }
  return kinds
}

/**
 * Pair each comment opener with the first `-->` after it on one prose line,
 * the one-span pairing of the regex this code replaces. `text` is what
 * survives outside the comment spans, `spans` the character ranges the
 * comments cover on this line, and `openAt` where the final opener — the one
 * still unmatched at line end — sits, so an unterminated comment restores
 * from exactly there.
 */
function stripProseLine(
  line: string,
  inComment: boolean,
): { text: string; spans: Array<[number, number]>; inComment: boolean; openAt: number } {
  let rest = line
  let base = 0
  let out = ""
  let openAt = -1
  const spans: Array<[number, number]> = []
  // an extent carried in from an earlier line covers this line from column 0
  let spanStart = inComment ? 0 : -1
  while (rest !== "") {
    if (inComment) {
      const close = rest.indexOf("-->")
      if (close === -1) break
      base += close + 3
      rest = rest.slice(close + 3)
      inComment = false
      openAt = -1
      spans.push([spanStart, base])
      spanStart = -1
      continue
    }
    const open = rest.indexOf("<!--")
    if (open === -1) {
      out += rest
      break
    }
    out += rest.slice(0, open)
    base += open + 4
    rest = rest.slice(open + 4)
    openAt = base - 4
    spanStart = openAt
    inComment = true
  }
  if (spanStart !== -1) spans.push([spanStart, line.length])
  return { text: out, spans, inComment, openAt }
}

/**
 * Strip HTML comments from prose only: code content never opens one, so
 * comment text inside fenced and indented blocks survives verbatim. A
 * comment opened on a prose line keeps the one-span semantics of the strip
 * it replaces — it runs to the first `-->` on any line — and strips whole
 * or not at all, so one left unterminated to EOF stays.
 */
function stripHtmlComments(text: string): string {
  const kept: string[] = []
  let inComment = false
  // a comment opened but not yet closed: `head` is the text emitted before
  // its final opener, `suffix` the original text from that opener, `tail`
  // the whole original lines after it — together what restores verbatim if
  // the comment never closes
  let held: { head: string; suffix: string; tail: string[] } | null = null
  for (const { line, isCode } of lineKinds(text)) {
    // an open comment's extent is raw text: code lines carry it too, and
    // what follows its closer on such a line scans as prose
    if (isCode && !inComment) {
      kept.push(line)
      continue
    }
    const stripped = stripProseLine(line, inComment)
    inComment = stripped.inComment
    if (!inComment) {
      // a closed comment is one span: the lines it crossed collapse into
      // its head joined to its tail
      kept.push(held ? held.head + stripped.text : stripped.text)
      held = null
    } else if (stripped.openAt !== -1) {
      // the still-unmatched opener sits on this line: closed comments
      // before it emit now, and only from the opener on can restore
      held = { head: (held ? held.head : "") + stripped.text, suffix: line.slice(stripped.openAt), tail: [] }
    } else if (held) {
      held.tail.push(line)
    }
  }
  if (held) kept.push(held.head + held.suffix, ...held.tail)
  return kept.join("\n")
}

/**
 * Neutralize `@` inside the comment extents the strip would remove, so the
 * import scanner can run on the raw text and read the fences the file
 * actually has: a fence a stripped span happens to swallow must never
 * un-shield what it shields here, and a commented-out import must never
 * fire. Extents left unterminated to EOF are not masked — they survive the
 * strip whole, exactly as today.
 */
function maskCommentedImports(text: string): string {
  const lines: string[] = []
  let inComment = false
  // masked and original copies of the lines of a comment not yet closed:
  // closed -> the masked lines count, unterminated at EOF -> the originals
  let held: { masked: string[]; original: string[] } | null = null
  for (const { line, isCode } of lineKinds(text)) {
    if (isCode && !inComment) {
      lines.push(line)
      continue
    }
    const stripped = stripProseLine(line, inComment)
    inComment = stripped.inComment
    let masked = ""
    let prev = 0
    for (const [start, end] of stripped.spans) {
      masked += line.slice(prev, start) + line.slice(start, end).replace(/@/g, "\0")
      prev = end
    }
    masked += line.slice(prev)
    if (held) {
      held.masked.push(masked)
      held.original.push(line)
      if (!inComment) {
        lines.push(...held.masked)
        held = null
      }
    } else if (inComment) {
      held = { masked: [masked], original: [line] }
    } else {
      lines.push(masked)
    }
  }
  if (held) lines.push(...held.original)
  return lines.join("\n")
}

/** Instruction files must not be able to forge or close the wrapper tag. */
function sanitizeReminderTags(text: string): string {
  return text.replace(/<(\/?)system-reminder/gi, "&lt;$1system-reminder")
}

/** Instruction text as the model sees it: prose comments stripped, reminder tags neutralized. */
function preparedContent(raw: string): string | undefined {
  const content = stripHtmlComments(raw).trim()
  return content ? sanitizeReminderTags(content) : undefined
}

function safeReal(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Parse the import token just after an anchored '@', per Claude Code's token
 * forms: a quote-wrapped path is never an import, and '\' followed by a space
 * joins the token into one path. A lone trailing backslash is an unterminated
 * escape, so its token imports nothing. `end` is where scanning resumes:
 * past a whole quoted span, or past just an unterminated quote so later
 * tokens on the same line still scan.
 */
function importTokenAt(line: string, start: number): { path: string | undefined; end: number } {
  const first = line[start]
  if (first === '"' || first === "'") {
    const close = line.indexOf(first, start + 1)
    return { path: undefined, end: close === -1 ? start + 1 : close + 1 }
  }
  let token = ""
  let end = start
  while (end < line.length) {
    const ch = line[end]
    if (/\s/.test(ch)) break
    if (ch === "\\") {
      // only '\ ' is an escape; a backslash before any other char is literal
      if (end + 1 < line.length && line[end + 1] === " ") {
        token += " "
        end += 2
        continue
      }
      if (end + 1 === line.length) return { path: undefined, end: line.length }
    }
    token += ch
    end++
  }
  const path = token.replace(/[).,;:!?'"\]]+$/, "")
  return { path: path || undefined, end }
}

/** Find @path import targets, skipping fenced code blocks and inline code spans. */
function findImports(text: string): string[] {
  const out: string[] = []
  for (const { line, isCode } of lineKinds(text)) {
    if (isCode) continue
    const scannable = line.replace(/`[^`]*`/g, "")
    for (let i = 0; i < scannable.length; i++) {
      if (scannable[i] !== "@") continue
      if (i > 0 && !/\s/.test(scannable[i - 1])) continue
      const token = importTokenAt(scannable, i + 1)
      if (token.path !== undefined) out.push(token.path)
      i = token.end
    }
  }
  return out
}

function resolveImport(target: string, importingFile: string): string {
  const expanded = expandHome(target)
  if (isAbsolute(expanded)) return expanded
  return resolve(dirname(importingFile), expanded)
}

/**
 * Read a file, emit its block, then recurse into its @imports. Files in `skip`
 * are parsed for their @imports but their own block is not emitted — opencode
 * already injected those bodies natively, yet its loader never expands @path,
 * so we still have to pull the imports in ourselves.
 */
function collectFile(
  path: string,
  label: string,
  depth: number,
  seen: Set<string>,
  blocks: Block[],
  worktreeReal: string,
  excludes: readonly string[],
  skip?: Set<string>,
): void {
  if (seen.has(path)) return
  seen.add(path)
  const raw = readText(path)
  if (raw === undefined) return
  const content = preparedContent(raw)
  if (content === undefined) return
  if (!skip?.has(path)) blocks.push({ path, label, content })
  if (depth >= MAX_IMPORT_DEPTH) return
  const importerDir = safeReal(dirname(path))
  for (const target of findImports(maskCommentedImports(raw))) {
    const resolved = resolveImport(target, path)
    if (!isFile(resolved)) continue
    if (isExcluded(resolved, excludes)) continue
    // confine imports: an instruction file may only pull in files under the
    // worktree or under its own directory — never arbitrary local paths
    // (Claude Code gates external imports behind an approval dialog; a
    // plugin has no dialog, so it refuses instead)
    const real = safeReal(resolved)
    if (!real) continue
    if (!isWithin(real, worktreeReal) && !(importerDir && isWithin(real, importerDir))) continue
    collectFile(resolved, `imported by ${path}`, depth + 1, seen, blocks, worktreeReal, excludes, skip)
  }
}

function managedSettingsDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode"
    case "win32":
      return "C:\\Program Files\\ClaudeCode"
    default:
      return "/etc/claude-code"
  }
}

function managedPolicyPath(): string {
  return join(managedSettingsDir(), "CLAUDE.md")
}

function managedSettingsPath(): string {
  return join(managedSettingsDir(), "managed-settings.json")
}

/** CLAUDE_CODE_DISABLE_CLAUDE_MDS: exactly "1" turns every memory load off. */
function claudeMdsDisabled(): boolean {
  return process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === "1"
}

/** A parsed settings file, or undefined when missing or malformed — claude code ignores such files. */
function readSettings(file: string): Record<string, unknown> | undefined {
  const raw = readText(file)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * claudeMdExcludes from the settings scopes claude code reads; the arrays
 * merge across layers. A non-string entry contributes nothing.
 */
function claudeMdExcludes(worktree: string): readonly string[] {
  const files = [
    join(homedir(), ".claude", "settings.json"),
    join(worktree, ".claude", "settings.json"),
    join(worktree, ".claude", "settings.local.json"),
    managedSettingsPath(),
  ]
  const patterns: string[] = []
  for (const file of files) {
    const excludes = readSettings(file)?.claudeMdExcludes
    if (!Array.isArray(excludes)) continue
    for (const pattern of excludes) if (typeof pattern === "string") patterns.push(pattern)
  }
  return patterns
}

/**
 * A claudeMdExcludes entry — glob pattern or absolute path — against a file's
 * absolute path. A symlinked memory file is excludable by either its link
 * path or its target, so both are matched. A malformed pattern matches nothing.
 */
function isExcluded(path: string, excludes: readonly string[]): boolean {
  const paths = [path]
  const real = safeReal(path)
  if (real !== undefined && real !== path) paths.push(real)
  return excludes.some((pattern) =>
    paths.some((candidate) => {
      try {
        return new Bun.Glob(pattern).match(candidate)
      } catch {
        return false
      }
    }),
  )
}

/**
 * The claudeMd key of managed-settings.json: managed policy content inline,
 * honored only there — claude code ignores the key in every other settings
 * file — loading with the managed file's precedence.
 */
function managedClaudeMdContent(): string | undefined {
  const claudeMd = readSettings(managedSettingsPath())?.claudeMd
  if (typeof claudeMd !== "string") return undefined
  return preparedContent(claudeMd)
}

/** Filesystem root down to (and including) dir. */
function ancestorDirs(dir: string): string[] {
  const dirs: string[] = []
  let current = resolve(dir)
  while (true) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs.reverse()
}

/**
 * Replicate the directory a v2 session belongs to: opencode resolves a
 * location's project root from the nearest .git/.hg marker, falling back to
 * the location itself when no repository encloses it.
 */
function worktreeRoot(directory: string): string {
  let current = resolve(directory)
  while (true) {
    if (pathExists(join(current, ".git")) || pathExists(join(current, ".hg"))) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/**
 * Replicate opencode's native instruction pick so we never inject a file
 * it already loaded: global = <config>/opencode/AGENTS.md; project = every
 * AGENTS.md walking up from the session directory to the project root.
 * Unlike v1, v2's loader reads no CLAUDE.md/CONTEXT.md and has no
 * ~/.claude fallback, so those stay fully ours to deliver.
 */
function nativelyLoaded(directory: string, worktree: string): Set<string> {
  const native = new Set<string>()
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
  const globalFile = join(configDir, "AGENTS.md")
  if (isFile(globalFile)) native.add(globalFile)
  // v2's native AGENTS.md walk stops at $HOME when the session directory is
  // under it, else at the project root — both bounds inclusive
  const home = resolve(homedir())
  const stop = isWithin(resolve(directory), home) ? home : worktree
  let dir = resolve(directory)
  while (true) {
    const candidate = join(dir, "AGENTS.md")
    if (isFile(candidate)) native.add(candidate)
    if (dir === stop || dirname(dir) === dir) break
    dir = dirname(dir)
  }
  return native
}

function render(blocks: Block[], intro: string): string {
  if (blocks.length === 0) return ""
  const body = blocks
    .map((b) => `Contents of ${b.path} (${b.label}):\n\n${b.content}`)
    .join("\n\n")
  return ["<system-reminder>", intro, "", body, "</system-reminder>"].join("\n")
}

/** Collect the per-directory instruction files of a single directory. */
function collectDir(
  dir: string,
  seen: Set<string>,
  blocks: Block[],
  worktreeReal: string,
  excludes: readonly string[],
  skip?: Set<string>,
): void {
  const candidates: Array<[string, string]> = [
    [join(dir, "CLAUDE.md"), LABELS.project],
    [join(dir, ".claude", "CLAUDE.md"), LABELS.project],
    [join(dir, "CLAUDE.local.md"), LABELS.local],
  ]
  for (const [path, label] of candidates) {
    if (isFile(path) && !isExcluded(path, excludes)) {
      collectFile(path, label, 0, seen, blocks, worktreeReal, excludes, skip)
    }
  }
}

function assemble(
  directory: string,
  worktree: string,
  worktreeReal: string,
): { text: string; seen: Set<string> } {
  const skip = nativelyLoaded(directory, worktree)
  const excludes = claudeMdExcludes(worktree)
  const seen = new Set<string>()
  const blocks: Block[] = []

  // the managed policy source is the one thing claudeMdExcludes can never drop
  const managedPath = managedPolicyPath()
  if (isFile(managedPath)) collectFile(managedPath, LABELS.managed, 0, seen, blocks, worktreeReal, excludes, skip)
  const managedClaudeMd = managedClaudeMdContent()
  if (managedClaudeMd !== undefined) {
    blocks.push({ path: managedSettingsPath(), label: LABELS.managed, content: managedClaudeMd })
  }
  const globalPath = join(homedir(), ".claude", "CLAUDE.md")
  if (isFile(globalPath) && !isExcluded(globalPath, excludes)) {
    collectFile(globalPath, LABELS.global, 0, seen, blocks, worktreeReal, excludes, skip)
  }
  for (const dir of ancestorDirs(directory)) collectDir(dir, seen, blocks, worktreeReal, excludes, skip)

  const text = render(
    blocks,
    [
      "As you answer the user's questions, you can use the following context.",
      "IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
    ].join("\n"),
  )
  return { text, seen }
}

/** The model-visible form of a result carrying no content field (runtime stringify). */
function outputText(output: unknown): string {
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output) ?? String(output)
  } catch {
    return String(output)
  }
}

/** Same members as the runtime's tool result content union. */
type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

function appendedContent(
  content: string | ReadonlyArray<ToolContent> | undefined,
  output: unknown,
  text: string,
): string | ReadonlyArray<ToolContent> {
  if (typeof content === "string") return `${content}\n\n${text}`
  if (Array.isArray(content) && content.length > 0) return [...content, { type: "text" as const, text }]
  return `${outputText(output)}\n\n${text}`
}

/**
 * v2 read/write/edit inputs name the target `path`; the `filePath` branch
 * covers non-builtin tools. `patch` carries only `patchText` — no target —
 * so it cannot drive a subtree attach.
 */
function targetPathOf(input: unknown): unknown {
  if (typeof input === "object" && input !== null && "path" in input) {
    return (input as { path: unknown }).path
  }
  if (typeof input === "object" && input !== null && "filePath" in input) {
    return (input as { filePath: unknown }).filePath
  }
  return undefined
}

// their separated value word is not a file operand; grep/sed -e/-f stay out
// (their value fills the pattern/script operand slot)
const VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  head: ["-n", "-c"],
  tail: ["-n", "-c"],
  grep: ["-A", "-B", "-C", "-m"],
}

/**
 * v2's shell tool (claude code's bash) takes a whole command line, so it
 * counts as a file touch only in the plain forms claude code counts as a
 * read: one of cat/head/tail/sed -n/grep over exactly one existing file,
 * with no shell operator outside quotes. Every other shape returns no target.
 */
function shellReadTargetOf(input: unknown, cwd: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const command = (input as { command?: unknown }).command
  if (typeof command !== "string") return undefined
  const words: string[] = []
  let word = ""
  let started = false
  const endWord = () => {
    if (started) words.push(word)
    word = ""
    started = false
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    // a pipe, chain, redirect, subshell or substitution makes the line more
    // than a bare read command
    if (/[|&;<>()`\n]/.test(ch)) return undefined
    if (ch === "\\") {
      if (i + 1 >= command.length) return undefined
      word += command[++i]
      started = true
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < command.length && command[i] !== quote) {
        const quoted = command[i]
        // inside double quotes a backslash only escapes " \ $ `
        if (quote === '"' && quoted === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) {
          word += command[i + 1]
          i += 2
          continue
        }
        word += quoted
        i++
      }
      if (i >= command.length) return undefined
      started = true
      continue
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord()
      continue
    }
    word += ch
    started = true
  }
  endWord()

  const [name, ...args] = words
  const valueFlags = VALUE_FLAGS[name] ?? []
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (valueFlags.includes(arg) && i + 1 < args.length) {
      i++
      continue
    }
    if (!arg.startsWith("-")) operands.push(arg)
  }
  let file: string | undefined
  switch (name) {
    case "cat":
    case "head":
    case "tail":
      if (operands.length === 1) file = operands[0]
      break
    case "sed":
      // claude code counts only sed's print-selected (-n) form as a read; an
      // -i anywhere means an in-place write
      if (operands.length === 2 && args.some((arg) => arg.startsWith("-") && arg.includes("n") && !arg.includes("i"))) {
        file = operands[1]
      }
      break
    case "grep":
      // operands are pattern then file; a third operand is a second file
      if (operands.length === 2) file = operands[1]
      break
  }
  if (file === undefined) return undefined
  const resolved = resolve(cwd, expandHome(file))
  return isFile(resolved) ? resolved : undefined
}

interface SessionState {
  directory: string
  worktreeReal: string
  // directories whose instruction files are already in context
  dirs: Set<string>
  // instruction files already in context (incl. expanded imports)
  files: Set<string>
}

export default Plugin.define({
  id: "opencode-claude-md",
  async setup(ctx) {
    const sessions = new Map<string, SessionState>()
    const controller = new AbortController()

    // dropping a session's attach state re-attaches subtree instruction
    // files on the next touch after a compaction or deletion
    const resetSession = (sessionID: string) => {
      sessions.delete(sessionID)
    }

    const pump = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event.type === "session.compaction.ended" || event.type === "session.deleted") {
            resetSession(event.data.sessionID)
          }
        } catch (err) {
          console.error("[opencode-claude-md]", err)
        }
      }
    })()
    // the subscription ends with an AbortError on cleanup; anything earlier is a failure
    pump.catch((err) => {
      if (!controller.signal.aborted) console.error("[opencode-claude-md]", err)
    })

    // the attach-state reset rides the compaction request path so it cannot
    // lose a race against the next primary request; the pump stays as the
    // backstop for late compaction-ended and deletion events
    const registrations = [
      await ctx.session.hook("compaction", async (input) => {
        try {
          resetSession(input.sessionID)
        } catch (err) {
          console.error("[opencode-claude-md]", err)
        }
      }),

      await ctx.session.hook("context", async (input) => {
        try {
          if (claudeMdsDisabled()) return
          // the context hook builds fresh system parts per request, so the
          // block rides every primary model call; no gate, nothing to
          // re-inject after compaction
          let directory: string
          try {
            const session = await ctx.session.get({ sessionID: input.sessionID })
            directory = resolve(session.location.directory)
          } catch {
            // ctx.location is the instance location opencode built this
            // plugin context from; the fallback covers sessions whose own
            // record lookup fails
            directory = resolve(ctx.location.directory)
          }
          const worktree = worktreeRoot(directory)
          const worktreeReal = safeReal(worktree) ?? worktree
          const { text, seen } = assemble(directory, worktree, worktreeReal)
          sessions.set(input.sessionID, {
            directory,
            worktreeReal,
            dirs: new Set(ancestorDirs(directory)),
            files: seen,
          })
          if (!text) return
          input.system.push({ type: "text", text })
        } catch (err) {
          // never crash the host process over instruction loading
          console.error("[opencode-claude-md]", err)
        }
      }),

      // lazy per-subdirectory loading: when a tool touches a file below the
      // session directory, attach the not-yet-loaded CLAUDE.md files on that
      // path to the tool result, the way Claude Code does mid-session
      await ctx.tool.hook("execute.after", async (event) => {
        try {
          if (claudeMdsDisabled()) return
          if (event.status !== "completed") return
          const isShell = event.tool === "shell"
          if (!isShell && !FILE_TOOLS.includes(event.tool)) return
          const state = sessions.get(event.sessionID)
          if (!state) return
          const target = isShell
            ? shellReadTargetOf(event.input, state.directory)
            : targetPathOf(event.input)
          if (typeof target !== "string") return
          const fileDir = dirname(resolve(state.directory, target))
          const rel = relative(state.directory, fileDir)
          if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return
          const blocks: Block[] = []
          const excludes = claudeMdExcludes(worktreeRoot(state.directory))
          let dir = state.directory
          for (const segment of rel.split(sep)) {
            dir = join(dir, segment)
            if (state.dirs.has(dir)) continue
            state.dirs.add(dir)
            collectDir(dir, state.files, blocks, state.worktreeReal, excludes)
          }
          const text = render(
            blocks,
            "The following instruction files apply to the directory subtree this tool just touched. Adhere to them.",
          )
          if (!text) return
          // the model reads the result's normalized content, so the block
          // extends whatever text the result already exposes to the model
          event.result = { ...event.result, content: appendedContent(event.result.content, event.result.output, text) }
        } catch (err) {
          console.error("[opencode-claude-md]", err)
        }
      }),
    ]

    return async () => {
      controller.abort()
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch (err) {
          console.error("[opencode-claude-md]", err)
        }
      }
      await pump.catch(() => {})
    }
  },
})
