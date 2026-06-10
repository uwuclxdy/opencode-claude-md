/**
 * opencode-claude-md — opencode plugin that loads CLAUDE.md files the way
 * Claude Code does at session start.
 *
 * Mirrors Claude Code's memory loading:
 *   - managed policy CLAUDE.md (per-OS path)
 *   - ~/.claude/CLAUDE.md (user global)
 *   - every CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md walking from
 *     the filesystem root down to cwd (ancestors first, cwd last)
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

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

function assemble(directory: string, worktree: string): string {
  const skip = nativelyLoaded(directory, worktree)
  const seen = new Set<string>()
  const blocks: Block[] = []
  const worktreeReal = safeReal(resolve(worktree)) ?? resolve(worktree)

  const collect = (path: string, label: string) => {
    if (!skip.has(path) && isFile(path)) collectFile(path, label, 0, seen, blocks, worktreeReal)
  }

  collect(managedPolicyPath(), LABELS.managed)
  collect(join(homedir(), ".claude", "CLAUDE.md"), LABELS.global)
  for (const dir of ancestorDirs(directory)) {
    collect(join(dir, "CLAUDE.md"), LABELS.project)
    collect(join(dir, ".claude", "CLAUDE.md"), LABELS.project)
    collect(join(dir, "CLAUDE.local.md"), LABELS.local)
  }

  if (blocks.length === 0) return ""
  const body = blocks
    .map((b) => `Contents of ${b.path} (${b.label}):\n\n${b.content}`)
    .join("\n\n")
  return [
    "<system-reminder>",
    "As you answer the user's questions, you can use the following context.",
    "IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
    "",
    body,
    "</system-reminder>",
  ].join("\n")
}

function sessionIdOf(properties: any): string | undefined {
  return properties?.sessionID ?? properties?.info?.id
}

export const OpenClaudeMd: Plugin = async (input) => {
  const directory = resolve(input.directory)
  const worktree = resolve(input.worktree)
  const injected = new Set<string>()

  return {
    event: async ({ event }) => {
      const id = sessionIdOf((event as any).properties)
      if (!id) return
      // re-inject on the next message after compaction; forget dead sessions
      if (event.type === "session.compacted") injected.delete(id)
      if (event.type === "session.deleted") injected.delete(id)
    },

    "chat.message": async (input, output) => {
      try {
        if (injected.has(input.sessionID)) return
        injected.add(input.sessionID)
        const text = assemble(directory, worktree)
        if (text) output.parts.unshift({ type: "text", text } as any)
      } catch (err) {
        // never crash the host process over instruction loading
        console.error("[opencode-claude-md]", err)
      }
    },
  }
}
