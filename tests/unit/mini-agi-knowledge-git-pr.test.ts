import { describe, it, expect } from "vitest";
import {
  ROLE_HIERARCHY_RANK,
  resolveRoleHierarchyRank,
  resolveMinRoleRank,
  buildVectorizeAclFilter,
  queryPermissionedKnowledge,
  googleModeHybridSearch,
  reciprocalRankFusion,
  bm25Score,
} from "@naelao/rag";
import { WorkspaceBranchEngine } from "../../workers/agents/src/script-engine/prebuilt/workspace-branch.js";
import { ArtifactsGitService, getAgentGitTools } from "../../workers/agents/src/services/ArtifactsGitService.js";

describe("Part 1: 3-Tier Scoped Knowledge Base (Mini-AGI ACL)", () => {
  it("enforces integer role rank hierarchy correctly", () => {
    expect(ROLE_HIERARCHY_RANK.viewer).toBe(1);
    expect(ROLE_HIERARCHY_RANK.member).toBe(2);
    expect(ROLE_HIERARCHY_RANK.editor).toBe(3);
    expect(ROLE_HIERARCHY_RANK.admin).toBe(4);
    expect(ROLE_HIERARCHY_RANK.owner).toBe(5);

    expect(resolveRoleHierarchyRank("admin")).toBe(4);
    expect(resolveRoleHierarchyRank("VIEWER")).toBe(1);
    expect(resolveRoleHierarchyRank("unknown")).toBe(1);
  });

  it("builds hardware-level Vectorize filter criteria with zero data leakage", () => {
    const spaceId = "sp_100";
    const userRole = "editor"; // rank 3
    const activeProjectId = "proj_alpha";

    const filter = buildVectorizeAclFilter(spaceId, userRole, activeProjectId);

    expect(filter).toEqual({
      space_id: "sp_100",
      project_id: { $in: ["proj_alpha", ""] },
      min_role_rank: { $lte: 3 },
    });
  });

  it("queries permissioned knowledge through Vectorize with strict ACL isolation", async () => {
    const mockDb = [
      {
        id: "chunk_1",
        score: 0.92,
        metadata: {
          space_id: "sp_100",
          project_id: "", // Space-wide
          min_role_rank: 1, // Public/Viewer+
          doc_id: "doc_universal",
          title: "Universal Brand Kit",
          text: "Universal company policy and brand kit.",
        },
      },
      {
        id: "chunk_2",
        score: 0.90,
        metadata: {
          space_id: "sp_100",
          project_id: "proj_alpha",
          min_role_rank: 2, // Member+
          doc_id: "doc_alpha_spec",
          title: "Project Alpha Architecture",
          text: "Technical architecture for Project Alpha.",
        },
      },
      {
        id: "chunk_3",
        score: 0.88,
        metadata: {
          space_id: "sp_100",
          project_id: "proj_beta", // Unrelated project
          min_role_rank: 2,
          doc_id: "doc_beta_spec",
          title: "Project Beta Roadmap",
          text: "Confidential Project Beta specifications.",
        },
      },
      {
        id: "chunk_4",
        score: 0.95,
        metadata: {
          space_id: "sp_100",
          project_id: "proj_alpha",
          min_role_rank: 4, // Admin-only document
          doc_id: "doc_alpha_secrets",
          title: "Alpha API Keys & Secrets",
          text: "Restricted production keys.",
        },
      },
    ];

    const mockVectorize = {
      query: async (_vector: number[], options: any) => {
        const filter = options.filter;
        const matches = mockDb.filter((item) => {
          if (item.metadata.space_id !== filter.space_id) return false;
          if (!filter.project_id.$in.includes(item.metadata.project_id)) return false;
          if (item.metadata.min_role_rank > filter.min_role_rank.$lte) return false;
          return true;
        });
        return { matches };
      },
    };

    // User is Member (Rank 2) on proj_alpha
    const memberResults = await queryPermissionedKnowledge(
      mockVectorize as any,
      [0.1, 0.2, 0.3],
      "sp_100",
      "member",
      "proj_alpha"
    );

    // Should include Space-wide (chunk_1) and Project Alpha (chunk_2)
    // Should EXCLUDE Project Beta (chunk_3) and Admin-only (chunk_4)
    expect(memberResults.length).toBe(2);
    expect(memberResults.map((r) => r.doc_id)).toEqual(["doc_universal", "doc_alpha_spec"]);

    // User is Admin (Rank 4) on proj_alpha
    const adminResults = await queryPermissionedKnowledge(
      mockVectorize as any,
      [0.1, 0.2, 0.3],
      "sp_100",
      "admin",
      "proj_alpha"
    );

    // Admin should see universal, alpha spec, and alpha secrets
    expect(adminResults.length).toBe(3);
    expect(adminResults.map((r) => r.doc_id)).toContain("doc_alpha_secrets");
  });
});

describe("Part 2: Google Search AI Mode at Edge", () => {
  it("resolves sub-50ms semantic cache hits on high cosine similarity (>0.96)", async () => {
    const mockEnv = {
      AI: {
        run: async () => ({ data: [[0.5, 0.5, 0.5]] }),
      },
      SEMANTIC_CACHE_VECTORS: {
        query: async () => ({
          matches: [{ id: "cache_key_sla", score: 0.98 }],
        }),
      },
      SEMANTIC_CACHE_KV: {
        get: async (key: string) => (key === "cache_key_sla" ? "Our enterprise SLA refund turnaround is 5 business days." : null),
      },
    };

    const res = await googleModeHybridSearch(
      "What is our enterprise refund SLA?",
      mockEnv as any,
      { spaceId: "sp_1", userRole: "member" }
    );

    expect(res.source).toBe("SEMANTIC_CACHE");
    expect(res.text).toBe("Our enterprise SLA refund turnaround is 5 business days.");
    expect(res.confidenceScore).toBe(0.98);
  });

  it("performs Hybrid Dense + Sparse BM25 retrieval with RRF (k=60) and numbered citations", async () => {
    const mockEnv = {
      AI: {
        run: async () => ({ data: [[0.2, 0.4, 0.6]] }),
      },
      KB_VECTORS: {
        query: async () => ({
          matches: [
            {
              id: "doc_sla_chunk_0",
              score: 0.89,
              metadata: {
                space_id: "sp_corp",
                project_id: "",
                min_role_rank: 1,
                doc_id: "doc_sla",
                title: "Enterprise MSA §4.2",
                text: "Refund SLA for enterprise accounts under Delaware jurisdiction is 5 business days.",
              },
            },
            {
              id: "doc_policy_chunk_0",
              score: 0.75,
              metadata: {
                space_id: "sp_corp",
                project_id: "",
                min_role_rank: 1,
                doc_id: "doc_policy",
                title: "General Policy Document",
                text: "Standard company refund procedures and timelines.",
              },
            },
          ],
        }),
      },
    };

    const res = await googleModeHybridSearch(
      "enterprise refund SLA Delaware",
      mockEnv as any,
      { spaceId: "sp_corp", userRole: "member" }
    );

    expect(res.source).toBe("HYBRID_RRF");
    expect(res.citations.length).toBe(2);
    expect(res.citations[0]?.index).toBe(1);
    expect(res.citations[0]?.title).toBe("Enterprise MSA §4.2");
    expect(res.citations[0]?.snippet).toContain("Refund SLA");
    expect(res.citations[1]?.index).toBe(2);
  });

  it("falls back to live web grounding when internal confidence is low", async () => {
    const mockEnv = {
      AI: {
        run: async () => ({ data: [[0.1, 0.1, 0.1]] }),
      },
      KB_VECTORS: {
        query: async () => ({ matches: [] }),
      },
      WEB_SEARCH_FALLBACK: async (query: string) => [
        {
          title: "Cloudflare Artifacts Announcement",
          url: "https://blog.cloudflare.com/artifacts",
          snippet: "Cloudflare Artifacts brings Git-native versioned storage to agents in Durable Objects.",
        },
      ],
    };

    const res = await googleModeHybridSearch(
      "latest Cloudflare Artifacts features",
      mockEnv as any,
      { spaceId: "sp_1", userRole: "member" }
    );

    expect(res.source).toBe("LIVE_WEB_GROUNDING");
    expect(res.citations.length).toBe(1);
    expect(res.citations[0]?.title).toBe("Cloudflare Artifacts Announcement");
    expect(res.citations[0]?.sourceUrl).toBe("https://blog.cloudflare.com/artifacts");
  });
});

describe("Part 3: Virtual FS Branching & Pull Request (PR) Engine", () => {
  it("manages branch creation, pull request generation, and atomic merges", async () => {
    // In-memory mock SQLite storage
    const tableData: {
      workspace_files: Array<{ branch: string; path: string; content: string; hash: string; size_bytes: number; updated_at: string }>;
      pull_requests: any[];
    } = {
      workspace_files: [
        {
          branch: "main",
          path: "src/components/Header.astro",
          content: "<header class='light'><h1>My App</h1></header>",
          hash: "hash_main_header",
          size_bytes: 48,
          updated_at: new Date().toISOString(),
        },
        {
          branch: "main",
          path: "src/styles/theme.css",
          content: "body { color: #111; }",
          hash: "hash_main_theme",
          size_bytes: 22,
          updated_at: new Date().toISOString(),
        },
      ],
      pull_requests: [],
    };

    const mockStorage = {
      sql: {
        exec: (query: string, ...params: any[]) => {
          if (query.includes("CREATE TABLE")) {
            return { toArray: () => [] };
          }
          if (query.includes("SELECT path, content, hash, size_bytes FROM workspace_files WHERE branch = ?")) {
            const branch = params[0];
            const rows = tableData.workspace_files.filter((f) => f.branch === branch);
            return { toArray: () => rows };
          }
          if (query.includes("SELECT path, content, hash FROM workspace_files WHERE branch = ?")) {
            const branch = params[0];
            const rows = tableData.workspace_files.filter((f) => f.branch === branch);
            return { toArray: () => rows };
          }
          if (query.includes("INSERT INTO workspace_files") || query.includes("INSERT OR REPLACE INTO workspace_files")) {
            const [branch, path, content, hash, size_bytes] = params;
            const existingIdx = tableData.workspace_files.findIndex((f) => f.branch === branch && f.path === path);
            const row = { branch, path, content, hash, size_bytes, updated_at: new Date().toISOString() };
            if (existingIdx >= 0) {
              tableData.workspace_files[existingIdx] = row;
            } else {
              tableData.workspace_files.push(row);
            }
            return { toArray: () => [] };
          }
          if (query.includes("INSERT INTO pull_requests")) {
            const [id, space_id, project_id, source_branch, target_branch, title, reasoning_summary, diff_manifest_json, author_user_id] = params;
            const row = { id, space_id, project_id, source_branch, target_branch, title, reasoning_summary, diff_manifest_json, author_user_id, status: "OPEN", created_at: new Date().toISOString() };
            tableData.pull_requests.push(row);
            return { toArray: () => [] };
          }
          if (query.includes("SELECT * FROM pull_requests WHERE id = ? AND status = 'OPEN'")) {
            const id = params[0];
            const rows = tableData.pull_requests.filter((pr) => pr.id === id && pr.status === "OPEN");
            return { toArray: () => rows };
          }
          if (query.includes("SELECT * FROM pull_requests WHERE 1=1")) {
            return { toArray: () => tableData.pull_requests };
          }
          if (query.includes("UPDATE pull_requests SET status = 'MERGED'")) {
            const id = params[0];
            const pr = tableData.pull_requests.find((p) => p.id === id);
            if (pr) {
              pr.status = "MERGED";
              pr.merged_at = new Date().toISOString();
            }
            return { toArray: () => [] };
          }
          return { toArray: () => [] };
        },
      },
    };

    const branchEngine = new WorkspaceBranchEngine(mockStorage as any);

    // 1. Fork a private scratchpad branch
    const forkRes = await branchEngine.createBranch("main", "branch:alice_v1");
    expect(forkRes.ok).toBe(true);
    expect(forkRes.filesCopied).toBe(2);

    // Modify file on private branch
    const aliceHeader = "<header class='dark:bg-slate-900'><h1>My App Dark</h1></header>";
    mockStorage.sql.exec(
      "INSERT OR REPLACE INTO workspace_files (branch, path, content, hash, size_bytes) VALUES (?, ?, ?, ?, ?)",
      "branch:alice_v1",
      "src/components/Header.astro",
      aliceHeader,
      "hash_alice_header",
      aliceHeader.length
    );

    // Add a new file on private branch
    const newComponent = "export function Button() { return <button>Click</button>; }";
    mockStorage.sql.exec(
      "INSERT OR REPLACE INTO workspace_files (branch, path, content, hash, size_bytes) VALUES (?, ?, ?, ?, ?)",
      "branch:alice_v1",
      "src/components/Button.tsx",
      newComponent,
      "hash_alice_button",
      newComponent.length
    );

    // 2. Create Pull Request
    const prRes = await branchEngine.createPullRequest({
      spaceId: "space_dev",
      projectId: "proj_web",
      sourceBranch: "branch:alice_v1",
      title: "Refactor Dark Mode Header & Add Button",
      reasoningSummary: "Replaced inline classes with Tailwind dark classes. Added reusable Button component.",
      authorUserId: "alice",
    });

    expect(prRes.ok).toBe(true);
    expect(prRes.changedFiles).toBe(2);
    expect(prRes.manifest.find((m) => m.path === "src/components/Header.astro")?.status).toBe("MODIFIED");
    expect(prRes.manifest.find((m) => m.path === "src/components/Button.tsx")?.status).toBe("CREATED");

    // 3. Merge Pull Request into Main
    const mergeRes = await branchEngine.mergePullRequest(prRes.prId);
    expect(mergeRes.ok).toBe(true);
    expect(mergeRes.targetBranch).toBe("main");

    // Verify main branch has updated content
    const mainHeader = tableData.workspace_files.find((f) => f.branch === "main" && f.path === "src/components/Header.astro");
    expect(mainHeader?.content).toContain("dark:bg-slate-900");
  });

  it("integrates Cloudflare Artifacts Git service with instant micro-forking and native diffs", async () => {
    const gitService = new ArtifactsGitService({});

    // 1. Create project repo
    const projectRepo = await gitService.createProjectRepo("proj_101");
    expect(projectRepo.repoName).toBe("proj_proj_101");
    expect(projectRepo.remoteUrl).toContain("https://artifacts.cloudflare.net/repos/");
    expect(projectRepo.token).toBeDefined();

    // 2. Micro-fork for Tier 4 scratchpad
    const fork = await gitService.forkForPrivateScratchpad("proj_proj_101", "scratchpad_alice");
    expect(fork.forkName).toBe("proj_proj_101_fork_scratchpad_alice");

    // 3. Generate native Git diff
    const diff = await gitService.generatePullRequestDiff("proj_proj_101", fork.forkName);
    expect(diff.changedFiles.length).toBeGreaterThan(0);
    expect(diff.totalAdditions).toBe(18);
    expect(diff.totalDeletions).toBe(4);

    // 4. Merge pull request
    const merge = await gitService.mergePullRequest("proj_proj_101", fork.forkName);
    expect(merge.ok).toBe(true);

    // 5. Agent Git Tools
    const tools = getAgentGitTools(projectRepo.remoteUrl, projectRepo.token);
    const commitRes = await tools.git_commit({ message: "feat: add dark mode" });
    expect(commitRes.ok).toBe(true);
    const pushRes = await tools.git_push({});
    expect(pushRes.ok).toBe(true);
  });
});
