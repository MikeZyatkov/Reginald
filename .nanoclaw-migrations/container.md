# Container — Apple Container, runtime mounts, agent-runner, send_image MCP

This file covers infrastructure customizations: switching to Apple Container, .env injection fallback, expanded mounts for the main agent, and the `send_image` MCP tool added to the agent-runner.

**v2 caveat:** v2 makes Apple Container opt-in via `/convert-to-apple-container`. Apply that skill *before* layering these customizations.

---

## CT-1: Reapply Apple Container baseline

**Action:** In the worktree, after the v2 base is in:

```bash
cd "$WORKTREE"
git fetch upstream skill/apple-container
# Either: git merge upstream/skill/apple-container
# Or invoke /convert-to-apple-container skill via Claude Code
```

This brings in:
- `src/container-runtime.ts` — Apple Container API (replaces docker)
- Mount syntax: `--mount type=bind,source=...,target=...,readonly`
- Health check: `container system status`
- Build script default: `container` instead of `docker`

The customizations below (CT-2 through CT-7) are layered on top of the upstream Apple Container code.

---

## CT-2: .env injection fallback when OneCLI unavailable

**Intent:** Apple Container can't reach the OneCLI gateway (bridge network exists only while containers run, but the gateway must start before any container). When OneCLI is unreachable, inject all `.env` vars directly into the container as `-e KEY=VALUE` flags so the agent has credentials.

**Files:** `src/env.ts`, `src/container-runner.ts`

**Detail tier:** Non-standard

**How to apply:**

1. **Helper function** (`src/env.ts`, append to existing file):
   ```ts
   export function readAllEnvVars(): Record<string, string> {
     const envFile = path.join(process.cwd(), '.env');
     let content: string;
     try {
       content = fs.readFileSync(envFile, 'utf-8');
     } catch (err) {
       logger.debug({ err }, '.env file not found');
       return {};
     }
     const result: Record<string, string> = {};
     for (const line of content.split('\n')) {
       const trimmed = line.trim();
       if (!trimmed || trimmed.startsWith('#')) continue;
       const eqIdx = trimmed.indexOf('=');
       if (eqIdx === -1) continue;
       const key = trimmed.slice(0, eqIdx).trim();
       let value = trimmed.slice(eqIdx + 1).trim();
       if (
         value.length >= 2 &&
         ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
       ) {
         value = value.slice(1, -1);
       }
       if (value) result[key] = value;
     }
     return result;
   }
   ```

2. **Fallback in container-runner** (`src/container-runner.ts`, in `buildContainerArgs` after OneCLI check):
   ```ts
   import { readAllEnvVars } from './env.js';
   // ...
   if (onecliApplied) {
     logger.info({ containerName }, 'OneCLI gateway config applied');
   } else {
     // Apple Container path: inject all .env vars
     const envVars = readAllEnvVars();
     const envKeys = Object.keys(envVars);
     if (envKeys.length > 0) {
       for (const [key, value] of Object.entries(envVars)) {
         args.push('-e', `${key}=${value}`);
       }
       logger.info({ containerName, count: envKeys.length }, 'Injecting .env vars into container');
     } else {
       logger.warn({ containerName }, 'No .env vars found — container will have no credentials');
     }
   }
   ```

3. **Skip .env shadow mount on Apple Container** (`src/container-runner.ts`, in `buildVolumeMounts`):
   ```ts
   // Apple Container doesn't support file-level bind mounts
   if (CONTAINER_RUNTIME_BIN !== 'container') {
     const envFile = path.join(projectRoot, '.env');
     if (fs.existsSync(envFile)) {
       mounts.push({
         hostPath: '/dev/null',
         containerPath: '/workspace/project/.env',
         readonly: true,
       });
     }
   }
   ```

**Risk:** v2 may reorganize container-runner. The intent — fallback to .env injection when OneCLI is unreachable — is what to preserve. If v2 already handles this (e.g. detects Apple Container and switches), no action needed.

---

## CT-3: Main group rw mount + personal workspace mounts

**Intent:** Give the main agent (Sam) read-write access to the project root (so it can self-improve the codebase) and additional workspace directories (`my-workspace`, `interview-copilot-v2`) for cross-project work.

**Files:** `src/container-runner.ts`

**Detail tier:** Non-standard

**How to apply:**

In `buildVolumeMounts` for the main group (whatever v2's "main"/"owner" equivalent is):

1. **Project root** — change from `readonly: true` to `readonly: false`.

2. **Add personal workspace mount:**
   ```ts
   const workspace = process.env.HOME
     ? path.join(process.env.HOME, 'Projects', 'my-workspace')
     : '/Users/user/Projects/my-workspace';
   mounts.push({
     hostPath: workspace,
     containerPath: '/workspace/mike-personal-workspace',
     readonly: false,
   });
   ```

3. **Add interview-copilot mount:**
   ```ts
   const interviewCopilot = process.env.HOME
     ? path.join(process.env.HOME, 'Projects', 'interview-copilot-v2')
     : '/Users/user/Projects/interview-copilot-v2';
   mounts.push({
     hostPath: interviewCopilot,
     containerPath: '/workspace/interview-copilot',
     readonly: false,
   });
   ```

4. **Remove explicit store mount** if v2 still has one — no longer needed since project root is writable.

5. **Mount-allowlist update**: if v2 has `src/mount-security.ts`, register the new paths in the allowlist.

**Risk:** v2's mount logic may live elsewhere; the new entity model may dictate which agent gets which mounts. The *intent* is: the owner-role agent has full project-root rw + personal workspace mounts.

---

## CT-4: Memory limit (4GB) for containers

**Intent:** Cap container memory at 4GB to avoid runaway memory usage taking down the host.

**Files:** `src/container-runner.ts`

**Detail tier:** Standard

**How to apply:**

In `buildContainerArgs`, add memory flag:
```ts
args.push('--memory', '4g');
```

(Apple Container syntax may differ — verify against v2's container-runtime.ts.)

---

## CT-5: HOME directory fallback

**Intent:** When `process.env.HOME` is unset (some launchd contexts), fall back to `/Users/user` instead of `os.homedir()` (which can return unexpected values inside the daemon).

**Files:** `src/config.ts`

**Detail tier:** Standard

**How to apply:**

```ts
// Before:
const HOME_DIR = process.env.HOME || os.homedir();
// After:
const HOME_DIR = process.env.HOME || '/Users/user';
```

**Note:** This is fragile — `'/Users/user'` is a placeholder. The launchd plist already sets `HOME` correctly, so this is a fallback that should rarely fire. In v2, prefer reading `HOME` from the launchd-injected env consistently.

---

## CT-6: Container build script default — `container` not `docker`

**Intent:** The build script defaults to `container` (Apple Container) instead of `docker`, with override via `CONTAINER_RUNTIME=docker`.

**Files:** `container/build.sh`

**Detail tier:** Standard

**How to apply:**

Line 11:
```bash
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"
```

(v2's `/convert-to-apple-container` skill already does this — verify after applying the skill.)

---

## CT-7: send_image MCP tool in agent-runner

**Intent:** Give the agent a tool to send images to the user's chat. Emits an IPC `type: 'image'` event with a container path; the host (see `channels.md` C-6) translates and routes.

**Files:** `container/agent-runner/src/ipc-mcp-stdio.ts`

**Detail tier:** Non-standard

**How to apply:**

Add new MCP tool after `send_message` in `ipc-mcp-stdio.ts`:

```ts
server.tool(
  'send_image',
  'Send an image to the user or group. Use this to share screenshots, charts, maps, or any image file. Supports png, jpg, jpeg, gif, and webp.',
  {
    image_path: z
      .string()
      .describe(
        'Absolute path to the image file inside the container (e.g., "/workspace/group/media/screenshot.png")',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption text to display with the image'),
  },
  async (args) => {
    // Validate file exists
    if (!fs.existsSync(args.image_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.image_path}` }],
        isError: true,
      };
    }

    // Validate extension
    const ext = path.extname(args.image_path).toLowerCase();
    const supported = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    if (!supported.includes(ext)) {
      return {
        content: [{ type: 'text' as const, text: `Unsupported image type: ${ext}. Supported: ${supported.join(', ')}` }],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'image',
      chatJid,
      imagePath: args.image_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Image sent.' }] };
  },
);
```

`chatJid`, `groupFolder`, `MESSAGES_DIR`, and `writeIpcFile` are pulled from the surrounding scope (same as `send_message`). Imports needed: `fs`, `path`, `z` from zod (already present for other tools).

**Pairing:** This tool requires the host-side IPC handler (channels.md C-6) and per-channel `sendImage()` method to be in place, otherwise the IPC events will be ignored.

---

## CT-8: Dynamic model selection in agent-runner

**Intent:** The agent-runner reads `CLAUDE_MODEL` from input or env and passes it to the SDK so each container can run a different model.

**Files:** `container/agent-runner/src/index.ts`

**Detail tier:** Standard

**How to apply:**

1. Add `model?: string` to `ContainerInput` interface.

2. In `runQuery()` (or v2's equivalent):
   ```ts
   const model = containerInput.model || process.env.CLAUDE_MODEL || undefined;
   if (model) {
     log(`Using model: ${model}`);
   }
   for await (const message of query({
     prompt: stream,
     options: {
       model,
       // ... other options
     }
   })) {
     // ...
   }
   ```

If `model` is undefined, the SDK uses its default. This pairs with R-2 (per-group model overrides) — host passes `CLAUDE_MODEL` env into the container, agent-runner consumes it.

**Note:** v2 may have moved this into the agent SDK config — check v2's agent-runner before reimplementing.
