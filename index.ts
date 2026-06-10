/**
 * opencode-claude-md — opencode plugin that loads CLAUDE.md files the way
 * Claude Code does at session start.
 *
 * Mirrors Claude Code's memory loading:
 *   - managed policy CLAUDE.md (per-OS path)
 *   - ~/.claude/CLAUDE.md (user global)
 *   - every CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md walking from
 *     the filesystem root down to cwd (ancestors first, cwd last)
 *   - subdirectory CLAUDE.md files lazily, attached to tool results when
 *     a tool first touches a file in that subtree
 *   - @path imports, max 4 hops, ignored inside code fences/spans,
 *     confined to the worktree or the importing file's directory
 *   - HTML comments stripped, <system-reminder> tags in content escaped
 *
 * Skips whatever opencode's native instruction loader already injects
 * (first AGENTS.md/CLAUDE.md/CONTEXT.md found between cwd and the
 * worktree root, plus the global pick) so nothing appears twice.
 *
 * Only type imports from @opencode-ai/plugin — the file runs without
 * node_modules when dropped into a plugins directory.
 */
import type { Plugin } from "@opencode-ai/plugin"
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

/** Read a file, emit its block, then recurse into its @imports. */
function collectFile(
  path: string,
  label: string,
  depth: number,
  seen: Set<string>,
  blocks: Block[],
  worktreeReal: string,
): void {
  if (seen.has(path)) return
  seen.add(path)
  const raw = readText(path)
  if (raw === undefined) return
  const content = stripHtmlComments(raw).trim()
  if (!content) return
  blocks.push({ path, label, content: sanitizeReminderTags(content) })
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
    collectFile(resolved, `imported by ${path}`, depth + 1, seen, blocks, worktreeReal)
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
 * Replicate opencode's native instruction pick so we never inject a file
 * it already loaded: global = ~/.config/opencode/AGENTS.md else
 * ~/.claude/CLAUDE.md; project = first AGENTS.md > CLAUDE.md > CONTEXT.md
 * walking up from cwd to the worktree root.
 */
function nativelyLoaded(directory: string, worktree: string): Set<string> {
  const native = new Set<string>()
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
  if (isFile(join(configDir, "AGENTS.md"))) {
    native.add(join(configDir, "AGENTS.md"))
  } else if (isFile(join(homedir(), ".claude", "CLAUDE.md"))) {
    native.add(join(homedir(), ".claude", "CLAUDE.md"))
  }
  const root = resolve(worktree)
  outer: for (const name of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
    let dir = resolve(directory)
    while (true) {
      const candidate = join(dir, name)
      if (isFile(candidate)) {
        native.add(candidate)
        break outer
      }
      if (dir === root || dirname(dir) === dir) break
      dir = dirname(dir)
    }
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
    if (!skip?.has(path) && isFile(path)) collectFile(path, label, 0, seen, blocks, worktreeReal)
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
    if (!skip.has(path) && isFile(path)) collectFile(path, label, 0, seen, blocks, worktreeReal)
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

function sessionIdOf(properties: any): string | undefined {
  return properties?.sessionID ?? properties?.info?.id
}

interface SessionState {
  // directories whose instruction files are already in context
  dirs: Set<string>
  // instruction files already in context (incl. expanded imports)
  files: Set<string>
}

export const OpenClaudeMd: Plugin = async (input) => {
  const directory = resolve(input.directory)
  const worktree = resolve(input.worktree)
  const worktreeReal = safeReal(worktree) ?? worktree
  const sessions = new Map<string, SessionState>()

  return {
    event: async ({ event }) => {
      const id = sessionIdOf((event as any).properties)
      if (!id) return
      // dropping the state re-injects everything on the next message /
      // re-attaches subdir files on the next read, like Claude Code
      if (event.type === "session.compacted") sessions.delete(id)
      if (event.type === "session.deleted") sessions.delete(id)
    },

    "chat.message": async (input, output) => {
      try {
        if (sessions.has(input.sessionID)) return
        const { text, seen } = assemble(directory, worktree, worktreeReal)
        sessions.set(input.sessionID, { dirs: new Set(ancestorDirs(directory)), files: seen })
        if (!text) return
        // opencode persists hook-added parts verbatim (no id backfill);
        // a part missing id/sessionID/messageID fails schema validation
        // downstream and kills the whole message. synthetic = hidden in
        // the TUI but still sent to the model.
        const messageID = input.messageID ?? output.message?.id
        if (!messageID) return
        output.parts.unshift({
          id: `prt_ocm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          sessionID: input.sessionID,
          messageID,
          type: "text",
          text,
          synthetic: true,
        } as any)
      } catch (err) {
        // never crash the host process over instruction loading
        console.error("[opencode-claude-md]", err)
      }
    },

    // lazy per-subdirectory loading: when a tool touches a file below cwd,
    // attach the not-yet-loaded CLAUDE.md files on that path to the tool
    // result, the way Claude Code does mid-session
    "tool.execute.after": async (input, output) => {
      try {
        if (!["read", "edit", "write"].includes(input.tool)) return
        const state = sessions.get(input.sessionID)
        if (!state) return
        const filePath = (input as any).args?.filePath
        if (typeof filePath !== "string") return
        const fileDir = dirname(resolve(directory, filePath))
        const rel = relative(directory, fileDir)
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return
        const blocks: Block[] = []
        let dir = directory
        for (const segment of rel.split(sep)) {
          dir = join(dir, segment)
          if (state.dirs.has(dir)) continue
          state.dirs.add(dir)
          collectDir(dir, state.files, blocks, worktreeReal)
        }
        const text = render(
          blocks,
          "The following instruction files apply to the directory subtree this tool just touched. Adhere to them.",
        )
        if (text) output.output += `\n\n${text}`
      } catch (err) {
        console.error("[opencode-claude-md]", err)
      }
    },
  }
}
