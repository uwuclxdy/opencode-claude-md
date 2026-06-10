# opencode-claude-md: load CLAUDE.md files in opencode like Claude Code does

An [opencode](https://opencode.ai) plugin that loads the full CLAUDE.md hierarchy at session start. Every ancestor directory, `CLAUDE.local.md`, `@path` imports, managed policy files. If Claude Code would read it, opencode reads it too.

## Why opencode's built-in CLAUDE.md support isn't enough

opencode reads CLAUDE.md natively, but only as a fallback. Walking up from your working directory, it takes the first `AGENTS.md` or `CLAUDE.md` it finds and stops there. Claude Code stacks the whole tree, expands imports, and layers user-global and per-machine files on top. Move a project between the two tools and half your instructions silently vanish.

This plugin closes the gap:

| Source | Loaded |
|---|---|
| managed policy (`/etc/claude-code/CLAUDE.md`, per-OS) | ✓ |
| `~/.claude/CLAUDE.md` (user global) | ✓ |
| every `CLAUDE.md` from filesystem root down to cwd | ✓ (ancestors first, cwd last) |
| `.claude/CLAUDE.md` at each level | ✓ (Claude Code documents this location at the project root only; the plugin checks every level) |
| `CLAUDE.local.md` at each level | ✓ (after `CLAUDE.md` of the same dir) |
| `@path/to/file` imports | ✓ (max 4 hops, ignored inside code fences and inline spans) |
| `CLAUDE.md` in subdirectories below cwd | ✓ (lazily: attached to the tool result when a file in that subtree is first read, edited, or written) |
| HTML comments | stripped before injection |

Two safety rules on top of Claude Code's behavior, since a plugin can't show approval dialogs: an `@import` only resolves if its target (realpath, so symlinks can't cheat) lives under the worktree or under the importing file's own directory, and any `<system-reminder>` tag inside file content is escaped so instruction files can't forge wrapper tags.

Content is injected once per session as a `<system-reminder>` text part prepended to the first user message, with per-file labels matching Claude Code's ("project instructions, checked into the codebase", and so on). Subdirectory files load mid-session instead: when a tool touches a file below cwd, any not-yet-loaded `CLAUDE.md` / `CLAUDE.local.md` on that path is appended to the tool result, which is also how Claude Code delivers them. After a `/compact`, startup files re-inject on the next message and subdirectory files re-attach on the next read.

Whatever opencode's native instruction loader already picked up (its first-match `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` plus the global pick) is skipped, so nothing reaches the model twice.

## Install

Global (all projects):

```sh
git clone https://github.com/uwuclxdy/opencode-claude-md
mkdir -p ~/.config/opencode/plugins
ln -s "$PWD/opencode-claude-md/index.ts" ~/.config/opencode/plugins/opencode-claude-md.ts
```

Or per project: drop `index.ts` into `.opencode/plugins/`.

Or via `opencode.json` once published to npm:

```json
{ "plugin": ["opencode-claude-md"] }
```

The plugin only uses type imports, so the single file works without `node_modules`.

## Alternatives

Honest comparison, since none of these do quite the same thing:

- **opencode's native [rules support](https://opencode.ai/docs/rules/)**: reads one project file (first `AGENTS.md`, else `CLAUDE.md`) plus one global file. No ancestor stacking, no `CLAUDE.local.md`, no `@import` expansion. Fine for a single-file setup.
- **`instructions` array in `opencode.json`**: lets you list extra files by hand (globs, absolute paths, URLs). Works, but you maintain the list per project and it doesn't follow Claude Code's discovery rules.
- **symlinking `AGENTS.md` to `CLAUDE.md`**: covers exactly one file per directory level and opencode still stops at the first match.
- **[opencode-claude-memory](https://github.com/kuitos/opencode-claude-memory)**: shares Claude Code's persistent auto-memory directory with opencode. Different layer entirely (memory the model writes, not instructions you write). Runs fine alongside this plugin.

## FAQ

### How do I load CLAUDE.md in opencode?

Out of the box, opencode picks up a project `CLAUDE.md` only when no `AGENTS.md` exists, and only the closest one. Install this plugin to load the complete hierarchy the way Claude Code does at session start.

### Does opencode read AGENTS.md or CLAUDE.md first?

`AGENTS.md` wins natively; `CLAUDE.md` is the fallback. The plugin leaves that pick alone and stacks every other CLAUDE.md around it.

### Why isn't my `~/.claude/CLAUDE.md` injected by the plugin?

opencode itself autoloads `~/.claude/CLAUDE.md` when `~/.config/opencode/AGENTS.md` doesn't exist. In that (common) setup the global file reaches the model through opencode, and the plugin detects that and skips it to avoid duplication. The plugin injects it itself only when `~/.config/opencode/AGENTS.md` exists and wins the native pick.

### Do `@path` imports in CLAUDE.md work in opencode?

Natively no. With this plugin yes: relative, absolute, and `~/` paths, up to 4 hops deep, same as Claude Code documents. Two conservative choices on top, since Claude Code's docs don't specify them: imports inside code fences and inline code spans are ignored, and targets outside the worktree (or the importing file's directory) are refused. Claude Code gates external imports behind an approval dialog; a plugin can't ask, so it refuses.

### Can instructions end up in the context twice?

No. The plugin replicates opencode's native pick logic and skips those files, and it injects at most once per session (re-injecting only after compaction).

## Out of scope

- `.claude/rules/*.md` path-scoped rules.

## Development

```sh
bun install
bunx tsc --noEmit
```

## License

MIT
