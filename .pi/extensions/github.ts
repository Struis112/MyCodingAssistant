/**
 * GitHub browsing tool for pi.
 *
 * Registers a single read-only `github` tool that wraps the already-installed
 * and authenticated GitHub CLI (`gh`). It lets the agent browse GitHub —
 * list/search repos, read files without cloning, and view issues/PRs —
 * using the user's existing `gh auth` session (no extra tokens needed).
 *
 * Read-only by design: every action maps to a known read command. There is no
 * generic shell passthrough and no write/delete capability.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const githubToolSchema = Type.Object({
  action: StringEnum(
    [
      "list_repos",
      "view_repo",
      "read_file",
      "list_tree",
      "search_repos",
      "search_code",
      "search_issues",
      "list_issues",
      "list_prs",
      "view_issue",
      "view_pr",
      "api",
    ] as const,
    {
      description:
        "What to do. read_file/list_tree/view_* need `repo` (owner/name). search_* need `query`. list_repos needs `owner`.",
    },
  ),
  owner: Type.Optional(
    Type.String({ description: "User or org login, e.g. 'Struis112' (for list_repos)." }),
  ),
  repo: Type.Optional(
    Type.String({ description: "Repository as 'owner/name', e.g. 'Struis112/factuur'." }),
  ),
  path: Type.Optional(
    Type.String({ description: "File or directory path inside the repo (read_file/list_tree)." }),
  ),
  ref: Type.Optional(
    Type.String({
      description: "Branch, tag, or commit SHA. Defaults to the repo's default branch.",
    }),
  ),
  query: Type.Optional(Type.String({ description: "Search query for search_* actions." })),
  number: Type.Optional(Type.Number({ description: "Issue or PR number (view_issue/view_pr)." })),
  state: Type.Optional(
    StringEnum(["open", "closed", "all"] as const, {
      description: "Issue/PR state filter. Default: open.",
    }),
  ),
  endpoint: Type.Optional(
    Type.String({
      description: "Raw GitHub REST endpoint for action=api, e.g. 'repos/OWNER/REPO/releases'.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max results for list/search actions. Default: 30." }),
  ),
});

export type GithubToolInput = Static<typeof githubToolSchema>;

/** Run `gh` with the given args. Never goes through a shell, so args are safe. */
function runGh(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

function requireField(value: string | undefined, name: string, action: string): string {
  if (!value || !value.trim()) {
    throw new Error(`Action "${action}" requires "${name}".`);
  }
  return value.trim();
}

/** Map a tool call to a concrete, read-only `gh` argument list. */
function buildArgs(p: GithubToolInput): string[] {
  const limit = String(p.limit ?? 30);
  switch (p.action) {
    case "list_repos":
      return [
        "repo",
        "list",
        requireField(p.owner, "owner", p.action),
        "--limit",
        limit,
        "--json",
        "name,description,visibility,isFork,isArchived,updatedAt,pushedAt,primaryLanguage,url",
      ];
    case "view_repo":
      return [
        "repo",
        "view",
        requireField(p.repo, "repo", p.action),
        "--json",
        "name,description,defaultBranchRef,visibility,isFork,isArchived,stargazerCount,updatedAt,url",
      ];
    case "read_file": {
      const repo = requireField(p.repo, "repo", p.action);
      const path = requireField(p.path, "path", p.action);
      const ep =
        `repos/${repo}/contents/${path}` + (p.ref ? `?ref=${encodeURIComponent(p.ref)}` : "");
      // Accept raw so we get file contents directly instead of base64 JSON.
      return ["api", "-H", "Accept: application/vnd.github.raw+json", ep];
    }
    case "list_tree": {
      const repo = requireField(p.repo, "repo", p.action);
      const path = p.path?.trim() ?? "";
      const ep =
        `repos/${repo}/contents/${path}` + (p.ref ? `?ref=${encodeURIComponent(p.ref)}` : "");
      return ["api", ep, "--jq", "[.[] | {name, type, size, path}]"];
    }
    case "search_repos":
      return ["search", "repos", requireField(p.query, "query", p.action), "--limit", limit];
    case "search_code":
      return ["search", "code", requireField(p.query, "query", p.action), "--limit", limit];
    case "search_issues":
      return ["search", "issues", requireField(p.query, "query", p.action), "--limit", limit];
    case "list_issues":
      return [
        "issue",
        "list",
        "--repo",
        requireField(p.repo, "repo", p.action),
        "--state",
        p.state ?? "open",
        "--limit",
        limit,
        "--json",
        "number,title,state,author,labels,updatedAt,url",
      ];
    case "list_prs":
      return [
        "pr",
        "list",
        "--repo",
        requireField(p.repo, "repo", p.action),
        "--state",
        p.state ?? "open",
        "--limit",
        limit,
        "--json",
        "number,title,state,author,isDraft,updatedAt,url",
      ];
    case "view_issue":
      return [
        "issue",
        "view",
        String(p.number ?? requireField(undefined, "number", p.action)),
        "--repo",
        requireField(p.repo, "repo", p.action),
        "--json",
        "number,title,state,author,body,labels,comments,url",
      ];
    case "view_pr":
      return [
        "pr",
        "view",
        String(p.number ?? requireField(undefined, "number", p.action)),
        "--repo",
        requireField(p.repo, "repo", p.action),
        "--json",
        "number,title,state,author,body,isDraft,additions,deletions,files,url",
      ];
    case "api": {
      const ep = requireField(p.endpoint, "endpoint", p.action);
      // Guard against accidental writes: only allow safe GET-style endpoints.
      return ["api", "--method", "GET", ep];
    }
    default:
      throw new Error(`Unknown action: ${(p as { action: string }).action}`);
  }
}

function truncate(text: string, max = 40_000): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n…(truncated, ${text.length - max} more chars)`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "github",
    label: "GitHub",
    description:
      "Browse GitHub (read-only) via the authenticated gh CLI: list/search repos, " +
      "read files without cloning, view issues and pull requests. " +
      "Uses the user's existing gh login.",
    promptSnippet:
      "Browse GitHub: list/search repos, read remote files, view issues/PRs (read-only)",
    promptGuidelines: [
      "Use the github tool to browse GitHub repos, files, issues, and PRs without cloning.",
      "github read_file reads a remote file by repo + path; prefer it over cloning for quick lookups.",
    ],
    parameters: githubToolSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      let args: string[];
      try {
        args = buildArgs(params);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Invalid request: ${(err as Error).message}` }],
          isError: true,
          details: {},
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Running: gh ${args.join(" ")}` }] });

      let result: { stdout: string; stderr: string; code: number };
      try {
        result = await runGh(args, signal);
      } catch (err) {
        const msg = (err as Error).message;
        const hint = msg.includes("ENOENT")
          ? " (the `gh` CLI does not appear to be installed or on PATH)"
          : "";
        return {
          content: [{ type: "text", text: `Failed to run gh: ${msg}${hint}` }],
          isError: true,
          details: { args },
        };
      }

      if (result.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `gh exited ${result.code}\n${result.stderr || result.stdout}`.trim(),
            },
          ],
          isError: true,
          details: { args, code: result.code },
        };
      }

      return {
        content: [{ type: "text", text: truncate(result.stdout.trim() || "(no output)") }],
        details: { action: params.action, args },
      };
    },
  });
}
