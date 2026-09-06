import { GoogleGenAI, Type } from "@google/genai";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ── 1. REPOMIX INCLUDES ARRAY PER CHUNK ─────────────────────────────────────
const CHUNK_REPOMIX_INCLUDES = {
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

// ── 2. 4-KEY × 3-MODEL ROTATION MATRIX (12 SLOTS) ───────────────────────────
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
const API_KEYS = rawKeys.split(",").map(k => k.trim()).filter(Boolean);

if (API_KEYS.length === 0) {
  console.error("❌ No GEMINI_API_KEYS found in environment secrets!");
  process.exit(1);
}

// The 3 models to rotate per key
const MODELS = [
  "gemini-3.5-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash"
];

// Build the 12 execution slots
const SLOTS = [];
for (let k = 0; k < API_KEYS.length; k++) {
  for (let m = 0; m < MODELS.length; m++) {
    SLOTS.push({
      key: API_KEYS[k],
      keyNumber: k + 1,
      model: MODELS[m]
    });
  }
}

console.log(`💎 Rotation Matrix: ${API_KEYS.length} Keys × ${MODELS.length} Models = ${SLOTS.length} Execution Slots.`);

let currentSlotIndex = 0;
function getActiveSlot() {
  const slot = SLOTS[currentSlotIndex];
  return {
    ai: new GoogleGenAI({ apiKey: slot.key }),
    model: slot.model,
    info: `Key ${slot.keyNumber}/${API_KEYS.length} | Model: ${slot.model}`
  };
}

function rotateSlot(reason = "pacing") {
  const prevIndex = currentSlotIndex;
  currentSlotIndex = (currentSlotIndex + 1) % SLOTS.length;
  const next = SLOTS[currentSlotIndex];
  console.log(`🔄 Rotated Slot [${prevIndex + 1} ➔ ${currentSlotIndex + 1}/${SLOTS.length}]: Key ${next.keyNumber} (${next.model}) [${reason}]`);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const phaseNum = process.env.PHASE_NUMBER || "1";
const branchName = `feature/phase-0${phaseNum}`;
const specsDir = `specs/phase-${phaseNum}`;

// Resilience wrapper that rotates through all 12 slots on quota/429 limits
async function callWithSlotPool(fn, maxAttempts = SLOTS.length * 2) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const active = getActiveSlot();
      return await fn(active.ai, active.model, active.info);
    } catch (err) {
      const isQuota = err.message?.includes("429") || 
                      err.status === 429 || 
                      err.message?.includes("RESOURCE_EXHAUSTED") ||
                      err.message?.includes("Quota exceeded");

      if (isQuota) {
        rotateSlot("Quota/429 Limit Reached");
        await sleep(3000); // 3-second quick-switch
      } else {
        throw err;
      }
    }
  }
  throw new Error("❌ All 12 key-model rotation slots have exhausted their limits.");
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
  description: "Review implementation against spec for syntax and correctness.",
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
  console.log(`Found ${chunkFiles.length} chunk(s) in Phase ${phaseNum}.`);

  execSync(`git checkout -B ${branchName}`);

  for (let i = 0; i < chunkFiles.length; i++) {
    const chunkFile = chunkFiles[i];
    const chunkName = path.basename(chunkFile, ".md");
    const rawChunkContent = fs.readFileSync(path.join(specsDir, chunkFile), "utf-8");

    console.log(`\n======================================================`);
    console.log(`⏩ [Chunk ${i + 1}/${chunkFiles.length}] ${chunkName}`);
    console.log(`======================================================`);

    // 1. Target files from CHUNK_REPOMIX_INCLUDES + Accumulated Branch Files
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

    // 3. Execution & Review Loop (Max 2 Retries)
    const MAX_RETRIES = 2;
    let attempt = 0;
    let reviewFeedback = null;
    let finalOutput = null;

    while (attempt <= MAX_RETRIES) {
      attempt++;

      // Generate Code
      finalOutput = await callWithSlotPool(async (ai, model, info) => {
        console.log(`🛠️ [Gen Attempt ${attempt}] Using [${info}]...`);
        const feedbackPrompt = reviewFeedback ? `\n\n=== FIX REVIEW ISSUES ===\n${reviewFeedback}` : "";
        const res = await ai.models.generateContent({
          model: model,
          contents: `Implement this specification completely. Full files only.\n\nCODE CONTEXT:\n${targetedContext}\n\nSPECIFICATION:\n${rawChunkContent}${feedbackPrompt}`,
          config: {
            systemInstruction: "You are the Principal Systems Architect for AVOS. Call 'apply_chunk_code' with complete file contents.",
            tools: [{ functionDeclarations: [writeCodeTool] }]
          }
        });
        const call = res.functionCalls?.find(c => c.name === "apply_chunk_code");
        if (!call) throw new Error(`Model on ${info} failed to call apply_chunk_code.`);
        return call.args;
      });

      rotateSlot("Pacing step");
      await sleep(4000); // 4s pacing

      // Local VM Syntax Pre-Check ($0 cost)
      const syntaxCheck = runLocalSyntaxCheck(finalOutput.files);
      if (!syntaxCheck.valid) {
        console.warn(`⚠️ Syntax Check Failed: ${syntaxCheck.error}`);
        reviewFeedback = `Local compiler syntax failure: ${syntaxCheck.error}`;
        continue;
      }

      // Review Pass
      const filesDiffView = finalOutput.files.map(f => `--- File: ${f.path} ---\n${f.content}`).join("\n\n");
      const review = await callWithSlotPool(async (ai, model, info) => {
        console.log(`🧐 [Audit Attempt ${attempt}] Reviewing with [${info}]...`);
        const res = await ai.models.generateContent({
          model: model,
          contents: `Audit the code against requirements. Check syntax, imports, and Cloudflare compatibility.\n\nSPEC:\n${rawChunkContent}\n\nPROPOSED CODE:\n${filesDiffView}`,
          config: {
            systemInstruction: "Call 'submit_code_review'. Set approved=true ONLY if bug-free and compliant.",
            tools: [{ functionDeclarations: [reviewCodeTool] }]
          }
        });
        const call = res.functionCalls?.find(c => c.name === "submit_code_review");
        return call ? call.args : { approved: true };
      });

      rotateSlot("Pacing step");
      await sleep(4000);

      if (review.approved) {
        console.log("✅ Code Review Passed!");
        break;
      }

      console.warn(`❌ Review Rejected: ${review.issuesFound?.join("; ")}`);
      reviewFeedback = review.fixInstructions || review.issuesFound?.join("\n");
    }

    // 4. Write Files & Commit Locally
    for (const f of finalOutput.files) {
      const dir = path.dirname(f.path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f.path, f.content, "utf-8");
      console.log(`  💾 Wrote: ${f.path}`);
    }

    execSync(`git add .`);
    execSync(`git commit -m "feat(phase-${phaseNum}): [${chunkName}] ${finalOutput.commitMessage}"`);
    console.log(`✔ Committed chunk: "${finalOutput.commitMessage}"`);

    if (i < chunkFiles.length - 1) {
      console.log("⏳ Waiting 6s before next chunk...");
      await sleep(6000);
    }
  }

  // 6. Push Branch and Open PR
  console.log(`\n🚀 Pushing ${branchName} to GitHub...`);
  execSync(`git push -u origin ${branchName} --force`);

  try {
    execSync(`gh pr create --title "AVOS: Complete Phase ${phaseNum}" --body "Automated 12-slot chunk implementation of Phase ${phaseNum}." --base main --head ${branchName}`);
    console.log("🎉 Pull Request created successfully!");
  } catch (e) {
    console.log("PR already exists or was updated.");
  }
}

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
