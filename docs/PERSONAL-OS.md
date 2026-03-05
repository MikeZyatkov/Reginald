# Personal OS — Architecture & First Principles

Building a personal AI assistant (Sam) that knows everything and can do everything, orchestrated through a single chat.

## Two Repos

| Repo | Role | Analogy |
|------|------|---------|
| **NanoClaw (Reginald)** | Infrastructure — messaging, containers, scheduling, IPC, agent SDK | The kernel |
| **my-workspace** | Knowledge — projects, tasks, ideas, lessons, knowledge bases | The filesystem |

They connect through: container mounts (my-workspace mounted into Sam's container), CLAUDE.md references, and scheduled tasks that operate on my-workspace files. Either side can evolve independently.

## First Principles

### 1. Memory is the bottleneck, not intelligence

Claude is smart enough. The hard problem is: how does Sam know what it needs to know, when it needs to know it? Context windows are finite. The entire architecture revolves around solving this.

### 2. Files are the universal interface

Markdown files in git are the ideal substrate:
- Human-readable and editable (never locked out)
- Version controlled (undo anything, see history)
- Searchable (qmd, grep)
- AI-native (LLMs work great with text)
- Portable (no vendor lock-in, no database to corrupt)

Everything should be a file. Projects, tasks, ideas, decisions, lessons — all markdown.

### 3. Pull, don't push

Don't cram everything into Sam's context at startup. Give Sam a **map** of what exists and let it pull details on demand. A good index beats a loaded context.

### 4. Convention over configuration

No routing rules, no config files for "which project goes where." Use folder structures and naming conventions that both human and AI understand. Add a new project by creating a folder in the right place — Sam discovers it automatically.

Sam learns conventions from `my-workspace/CLAUDE.md` — one source of truth for how the workspace is organized.

### 5. Idempotent by default

Every automated loop should be safe to run twice. If a daily review runs and nothing changed, nothing happens. No side effects from re-runs.

### 6. One chat, Sam orchestrates

User talks to Sam through one main channel. Sam dispatches background work to isolated contexts (teammates, scheduled tasks) and reports back. User never has to choose which channel to use or orchestrate between chats.

## Hierarchical Memory

Four layers solving the context window problem:

```
L0  STATUS.md              Always read at startup. <100 lines.
    │                      What's active, what's priority, what needs attention.
    │                      Lives in my-workspace/ (knowledge layer, not infra).
    │
L1  Index files            Lightweight maps of what exists.
    │                      Projects/index.md, tasks/open-tasks.md, lessons/index.md
    │                      Sam reads these to know what exists without loading details.
    │
L2  Full documents         Project READMEs, research docs, strategy docs.
    │                      Pulled on demand via qmd or file reads.
    │
L3  Archive/History        Past conversations, completed tasks, old research.
                           Searchable via qmd but rarely touched directly.
```

**L0 is the most important.** It's what Sam sees every session. It contains:
- Active projects (name + one-line status + path)
- Current priorities / focus
- Pending items that need user input
- Links to L1 indexes

**L1 indexes** are the scaling mechanism. 20 projects? Sam reads one index, not 20 READMEs. Convention: every directory with multiple items has an `index.md`.

## CLAUDE.md Files — What Goes Where

| File | Purpose | Read when |
|------|---------|-----------|
| `groups/global/CLAUDE.md` | Sam's core identity and rules (shared across all chats) | Auto-loaded every session, every group |
| `groups/main/CLAUDE.md` | Admin capabilities, workspace mounts, startup tasks, group management | Auto-loaded in main chat |
| `my-workspace/CLAUDE.md` | Workspace conventions — folder structure, project format, qmd usage, index rules | Sam reads on startup; also loaded by Claude Code when working in my-workspace |
| `my-workspace/STATUS.md` | L0 map — current state dashboard | Sam reads on startup; updated after work |

## Standard Formats

### Project (`my-workspace/Projects/{name}/README.md`)

```markdown
# Project Name
Status: active | paused | idea | completed
Priority: high | medium | low
Last touched: YYYY-MM-DD

## What
One paragraph description.

## Current state
What's done, what's not.

## Next actions
- [ ] Specific next step

## Open questions
- Thing to decide
```

### Index (`{directory}/index.md`)

Lightweight list with one-line status per item. Sam maintains these — adds entries when creating items, updates status when things change.

## The Session Chain

```
Sam starts session
  -> reads groups/main/CLAUDE.md        (how to behave)
  -> reads my-workspace/CLAUDE.md       (conventions)
  -> reads my-workspace/STATUS.md       (current state)
  -> now knows what's active, what's priority, where to find details

User asks something
  -> Sam checks STATUS.md for relevance
  -> drills into index.md or specific README.md if needed
  -> uses qmd for deep search across all knowledge

Sam finishes work
  -> updates STATUS.md if state changed
  -> updates relevant project README.md
  -> updates index.md if items added/removed
```

## Three Layers of the System

| Layer | What it does | Implementation |
|-------|-------------|----------------|
| **Projects** | Structured project tracking with standard formats, discoverable by convention | Standard README template, index files, STATUS.md dashboard |
| **Pulse** | Proactive loops — daily triage, weekly reviews, project monitors | NanoClaw scheduled tasks reading/writing my-workspace files, messaging main chat |
| **Intake** | Capture anything (ideas, links, voice notes) -> Sam triages into the right place | Conventions in CLAUDE.md for how Sam routes incoming information |

## Expandability

The system grows without rewiring:
- **New project** -> create folder following convention -> automatically discoverable
- **New knowledge base** -> add to my-workspace, index with qmd -> searchable
- **New pulse loop** -> add scheduled task -> runs independently
- **New capability** -> NanoClaw skill or tool -> available to Sam
- **New intake source** -> Gmail, voice notes, screenshots -> all route to same file-based triage