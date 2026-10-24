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
 *   - HTML comments stripped, <system-reminder> tags in content escaped
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

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "")
}

/** Instruction files must not be able to forge or close the wrapper tag. */
function sanitizeReminderTags(text: string): string {
  return text.replace(/<(\/?)system-reminder/gi, "&lt;$1system-reminder")
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

/** Find @path import targets, skipping fenced code blocks and inline code spans. */
function findImports(text: string): string[] {
  const out: string[] = []
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
      continue
    }
    if (delim) {
      fence = { char: delim[1][0], len: delim[1].length }
      continue
    }
    // a line indented >= 4 columns (tab = one stop) is a markdown indented
    // code block, so it can't introduce an @import
    if (/^(?:\t| {4})/.test(line)) continue
    const scannable = line.replace(/`[^`]*`/g, "")
    for (const match of scannable.matchAll(/(?:^|\s)@(\S+)/g)) {
      const candidate = match[1].replace(/[).,;:!?'"\]]+$/, "")
      if (candidate) out.push(candidate)
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
  skip?: Set<string>,
): void {
  if (seen.has(path)) return
  seen.add(path)
  const raw = readText(path)
  if (raw === undefined) return
  const content = stripHtmlComments(raw).trim()
  if (!content) return
  if (!skip?.has(path)) blocks.push({ path, label, content: sanitizeReminderTags(content) })
  if (depth >= MAX_IMPORT_DEPTH) return
  const importerDir = safeReal(dirname(path))
  for (const target of findImports(content)) {
    const resolved = resolveImport(target, path)
    if (!isFile(resolved)) continue
    // confine imports: an instruction file may only pull in files under the
    // worktree or under its own directory — never arbitrary local paths
    // (Claude Code gates external imports behind an approval dialog; a
    // plugin has no dialog, so it refuses instead)
    const real = safeReal(resolved)
    if (!real) continue
    if (!isWithin(real, worktreeReal) && !(importerDir && isWithin(real, importerDir))) continue
    collectFile(resolved, `imported by ${path}`, depth + 1, seen, blocks, worktreeReal, skip)
  }
}

function managedPolicyPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/CLAUDE.md"
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\CLAUDE.md"
    default:
      return "/etc/claude-code/CLAUDE.md"
  }
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
  skip?: Set<string>,
): void {
  const candidates: Array<[string, string]> = [
    [join(dir, "CLAUDE.md"), LABELS.project],
    [join(dir, ".claude", "CLAUDE.md"), LABELS.project],
    [join(dir, "CLAUDE.local.md"), LABELS.local],
  ]
  for (const [path, label] of candidates) {
    if (isFile(path)) collectFile(path, label, 0, seen, blocks, worktreeReal, skip)
  }
}

function assemble(
  directory: string,
  worktree: string,
  worktreeReal: string,
): { text: string; seen: Set<string> } {
  const skip = nativelyLoaded(directory, worktree)
  const seen = new Set<string>()
  const blocks: Block[] = []

  const collect = (path: string, label: string) => {
    if (isFile(path)) collectFile(path, label, 0, seen, blocks, worktreeReal, skip)
  }

  collect(managedPolicyPath(), LABELS.managed)
  collect(join(homedir(), ".claude", "CLAUDE.md"), LABELS.global)
  for (const dir of ancestorDirs(directory)) collectDir(dir, seen, blocks, worktreeReal, skip)

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
          let dir = state.directory
          for (const segment of rel.split(sep)) {
            dir = join(dir, segment)
            if (state.dirs.has(dir)) continue
            state.dirs.add(dir)
            collectDir(dir, state.files, blocks, state.worktreeReal)
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
