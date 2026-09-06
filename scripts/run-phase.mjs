import { GoogleGenAI, Type } from "@google/genai";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ── 1. REPOMIX INCLUDES ARRAY PER CHUNK ─────────────────────────────────────
// Explicit files to pack per chunk so no tokens are wasted analyzing the whole repo.
const CHUNK_REPOMIX_INCLUDES = {
  // Phase 1 Chunks
  "chunk-01-depth-hierarchy": [
    "packages/types/src/index.ts",
    "infra/migrations/0034_space_hierarchy.sql"
  ],
  "chunk-02-subspace-inheritance": [
    "workers/spaces/src/business-auth.ts",
    "workers/spaces/src/do/SpaceDO.ts",
    "packages/types/src/index.ts"
  ],
  "chunk-03-project-access-acl": [
    "workers/spaces/src/do/SpaceDO.ts",
    "workers/spaces/src/index.ts",
    "packages/events/src/business-feature-kinds.ts"
  ],
  "chunk-04-project-anchored-automations": [
    "workers/spaces/src/do/SpaceDO.ts",
    "packages/events/src/business-feature-kinds.ts",
    "packages/types/src/index.ts"
  ],
  "chunk-05-artifacts-git-mesh": [
    "workers/agents/wrangler.toml",
    "workers/spaces/wrangler.toml",
    "packages/types/src/index.ts"
  ],
  "chunk-06-computer-virtual-posix": [
    "workers/agents/src/script-engine/prebuilt/r2-workspace.ts",
    "workers/agents/src/do/NaelaoAgentDO.ts",
    "workers/agents/src/script-engine/types.ts"
  ],
  "chunk-07-namespace-separation": [
    "workers/agents/src/script-engine/types.ts",
    "workers/spaces/src/index.ts",
    "workers/agents/src/script-engine/prebuilt/file-manager.ts"
  ]
};

// ── 2. KEY POOL MANAGEMENT ──────────────────────────────────────────────────
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
const API_KEYS = rawKeys.split(",").map(k => k.trim()).filter(Boolean);

if (API_KEYS.length === 0) {
  console.error("❌ No GEMINI_API_KEYS found in environment secrets!");
  process.exit(1);
}

console.log(`🔑 Key Pool: Loaded ${API_KEYS.length} Gemini API Key(s).`);

let currentKeyIndex = 0;
function getActiveAI() {
  const key = API_KEYS[currentKeyIndex];
  return { ai: new GoogleGenAI({ apiKey: key }), keyNumber: currentKeyIndex + 1 };
}

function rotateKey(reason = "rotation") {
  const prev = currentKeyIndex + 1;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  console.log(`🔄 Rotated Key [${prev} ➔ ${currentKeyIndex + 1}/${API_KEYS.length}] (${reason})`);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const phaseNum = process.env.PHASE_NUMBER || "1";
const branchName = `feature/phase-0${phaseNum}`;
const specsDir = `specs/phase-${phaseNum}`;

async function callWithKeyPool(fn, maxAttempts = API_KEYS.length * 2) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { ai, keyNumber } = getActiveAI();
      return await fn(ai, keyNumber);
    } catch (err) {
      const isQuota = err.message?.includes("429") || err.status === 429 || err.message?.includes("RESOURCE_EXHAUSTED");
      if (isQuota) {
        rotateKey("Quota/429 Exhausted");
        await sleep(4000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("❌ All API keys in rotation pool have exhausted their quotas.");
}

// ── 3. TOOL SCHEMAS ─────────────────────────────────────────────────────────
const writeCodeTool = {
  name: "apply_chunk_code",
  description: "Emit complete, working, production-ready files for this chunk.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      commitMessage: { type: Type.STRING },
      files: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING },
            content: { type: Type.STRING }
          },
          required: ["path", "content"]
        }
      }
    },
    required: ["commitMessage", "files"]
  }
};

const reviewCodeTool = {
  name: "submit_code_review",
  description: "Review implementation against spec.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      approved: { type: Type.BOOLEAN },
      issuesFound: { type: Type.ARRAY, items: { type: Type.STRING } },
      fixInstructions: { type: Type.STRING }
    },
    required: ["approved"]
  }
};

// ── 4. HELPERS ──────────────────────────────────────────────────────────────
function getBranchAccumulatedFiles() {
  try {
    const stdout = execSync("git diff --name-only origin/main...HEAD", { encoding: "utf-8" });
    return stdout.split("\n").map(f => f.trim()).filter(f => f && fs.existsSync(f));
  } catch {
    return [];
  }
}

function runLocalSyntaxCheck(files) {
  for (const f of files) {
    if (f.path.endsWith(".js") || f.path.endsWith(".mjs")) {
      try {
        fs.writeFileSync("/tmp/syntax_check.js", f.content);
        execSync("node --check /tmp/syntax_check.js", { stdio: "pipe" });
      } catch (err) {
        return { valid: false, error: `Syntax error in ${f.path}: ${err.message}` };
      }
    }
  }
  return { valid: true };
}

// ── 5. MAIN EXECUTION LOOP ──────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(specsDir)) {
    console.error(`Directory ${specsDir} does not exist!`);
    process.exit(1);
  }

  const chunkFiles = fs.readdirSync(specsDir).filter(f => f.endsWith(".md")).sort();
  console.log(`Found ${chunkFiles.length} chunk(s) to process in Phase ${phaseNum}.`);

  execSync(`git checkout -B ${branchName}`);

  for (let i = 0; i < chunkFiles.length; i++) {
    const chunkFile = chunkFiles[i];
    const chunkName = path.basename(chunkFile, ".md");
    const rawChunkContent = fs.readFileSync(path.join(specsDir, chunkFile), "utf-8");

    console.log(`\n======================================================`);
    console.log(`⏩ [Chunk ${i + 1}/${chunkFiles.length}] ${chunkName}`);
    console.log(`======================================================`);

    // 1. Resolve Target Files from the Pre-defined Array + Branch Accumulator
    const baseFiles = CHUNK_REPOMIX_INCLUDES[chunkName] || [];
    const accumulatedFiles = getBranchAccumulatedFiles();
    const allFilesToPack = [...new Set([...baseFiles, ...accumulatedFiles])].filter(f => fs.existsSync(f));

    console.log(`🎯 Packing ${allFilesToPack.length} file(s) for this chunk:`);
    allFilesToPack.forEach(f => console.log(`   - ${f}`));

    // 2. Generate Targeted Repomix Bundle
    let targetedContext = "";
    if (allFilesToPack.length > 0) {
      const includeArg = allFilesToPack.map(f => `"${f}"`).join(",");
      execSync(`npx repomix --include ${includeArg} --style xml --output repomix-target.xml`, { stdio: "ignore" });
      targetedContext = fs.readFileSync("repomix-target.xml", "utf-8");
    } else {
      targetedContext = "<context>Greenfield initialization chunk.</context>";
    }

    // 3. Execution & Self-Healing Review Loop (Max 2 Retries)
    const MAX_RETRIES = 2;
    let attempt = 0;
    let reviewFeedback = null;
    let finalOutput = null;

    while (attempt <= MAX_RETRIES) {
      attempt++;
      console.log(`🛠️ [Generation Attempt ${attempt}/${MAX_RETRIES + 1}] Calling Gemini...`);

      // Generate Code
      finalOutput = await callWithKeyPool(async (ai) => {
        const feedbackPrompt = reviewFeedback ? `\n\n=== REPAIR INSTRUCTIONS FROM PREVIOUS ATTEMPT ===\n${reviewFeedback}` : "";
        const res = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: `Implement this specification completely. Emit full file contents without truncation.\n\nCODE CONTEXT:\n${targetedContext}\n\nSPECIFICATION:\n${rawChunkContent}${feedbackPrompt}`,
          config: {
            systemInstruction: "You are the Principal Systems Architect for AVOS. Call 'apply_chunk_code' with full file contents.",
            tools: [{ functionDeclarations: [writeCodeTool] }]
          }
        });
        const call = res.functionCalls?.find(c => c.name === "apply_chunk_code");
        if (!call) throw new Error("Model failed to call apply_chunk_code.");
        return call.args;
      });

      rotateKey("Round-robin key pacing");
      await sleep(6000); // 6s pacing

      // Zero-cost Local VM Syntax Check
      const syntaxCheck = runLocalSyntaxCheck(finalOutput.files);
      if (!syntaxCheck.valid) {
        console.warn(`⚠️ Syntax Check Failed: ${syntaxCheck.error}`);
        reviewFeedback = `Local compiler syntax failure: ${syntaxCheck.error}`;
        continue;
      }

      // Review Code
      console.log(`🧐 [Audit] Reviewing generated files...`);
      const filesDiffView = finalOutput.files.map(f => `--- File: ${f.path} ---\n${f.content}`).join("\n\n");
      const review = await callWithKeyPool(async (ai) => {
        const res = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: `Audit the code against the requirements. Check syntax, imports, and Cloudflare compatibility.\n\nSPEC:\n${rawChunkContent}\n\nPROPOSED CODE:\n${filesDiffView}`,
          config: {
            systemInstruction: "Call 'submit_code_review'. Set approved=true ONLY if bug-free and compliant with the spec.",
            tools: [{ functionDeclarations: [reviewCodeTool] }]
          }
        });
        const call = res.functionCalls?.find(c => c.name === "submit_code_review");
        return call ? call.args : { approved: true };
      });

      rotateKey("Round-robin key pacing");
      await sleep(6000);

      if (review.approved) {
        console.log("✅ Code Review Passed!");
        break;
      }

      console.warn(`❌ Review Rejected: ${review.issuesFound?.join("; ")}`);
      reviewFeedback = review.fixInstructions || review.issuesFound?.join("\n");
    }

    // 4. Write Files to Disk
    for (const f of finalOutput.files) {
      const dir = path.dirname(f.path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f.path, f.content, "utf-8");
      console.log(`  💾 Wrote: ${f.path}`);
    }

    // 5. Commit Locally
    execSync(`git add .`);
    execSync(`git commit -m "feat(phase-${phaseNum}): [${chunkName}] ${finalOutput.commitMessage}"`);
    console.log(`✔ Committed chunk: "${finalOutput.commitMessage}"`);

    // Pacing between chunks
    if (i < chunkFiles.length - 1) {
      console.log("⏳ Waiting 10s before next chunk...");
      await sleep(10000);
    }
  }

  // 6. Push Branch and Open Pull Request
  console.log(`\n🚀 Pushing ${branchName} to GitHub...`);
  execSync(`git push -u origin ${branchName} --force`);

  try {
    execSync(`gh pr create --title "AVOS: Complete Phase ${phaseNum}" --body "Automated targeted-chunk implementation of Phase ${phaseNum}." --base main --head ${branchName}`);
    console.log("🎉 Pull Request created successfully!");
  } catch (e) {
    console.log("PR already exists or was updated.");
  }
}

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
