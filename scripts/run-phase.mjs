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

// ── 2. KEY POOL MANAGEMENT (SANITIZES AQ. & AIza KEYS) ──────────────────────
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
const rawList = rawKeys.split(/[,\n]+/).map(k => k.trim()).filter(Boolean);

const API_KEYS = [];
for (const item of rawList) {
  let key = item.trim();
  const startIdx = key.search(/AQ\.|AIza/);
  if (startIdx !== -1) {
    key = key.slice(startIdx);
  }
  key = key.replace(/[^a-zA-Z0-9_.\-]/g, "").trim();
  if (key) {
    API_KEYS.push(key);
  }
}

if (API_KEYS.length === 0) {
  console.error("❌ No valid GEMINI_API_KEYS found!");
  process.exit(1);
}

console.log(`🔑 Loaded ${API_KEYS.length} valid key(s):`);
API_KEYS.forEach((k, idx) => {
  const masked = k.length > 12 ? `${k.slice(0, 7)}...${k.slice(-4)}` : "***";
  console.log(`   [Key ${idx + 1}] ${masked} (length: ${k.length})`);
});

// Quality-First Cascade Models Matrix
const MODELS = [
  "gemini-2.5-pro",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite"
];

let SLOTS = [];
for (const model of MODELS) {
  for (let k = 0; k < API_KEYS.length; k++) {
    const key = API_KEYS[k];
    const masked = key.length > 12 ? `${key.slice(0, 7)}...${key.slice(-4)}` : "***";
    SLOTS.push({
      key,
      maskedKey: masked,
      keyNumber: k + 1,
      model
    });
  }
}

console.log(`💎 Quality-First Cascade: ${API_KEYS.length} Keys × ${MODELS.length} Models = ${SLOTS.length} Slots.`);

let currentSlotIndex = 0;
function getActiveSlot() {
  if (SLOTS.length === 0) return null;
  currentSlotIndex = currentSlotIndex % SLOTS.length;
  const slot = SLOTS[currentSlotIndex];
  return {
    ai: new GoogleGenAI({ apiKey: slot.key }),
    key: slot.key,
    keyNumber: slot.keyNumber,
    maskedKey: slot.maskedKey,
    model: slot.model,
    info: `Key ${slot.keyNumber} (${slot.maskedKey}) | Model: ${slot.model}`
  };
}

function rotateSlot(reason = "pacing") {
  if (SLOTS.length <= 1) return;
  const prevIndex = currentSlotIndex;
  currentSlotIndex = (currentSlotIndex + 1) % SLOTS.length;
  const next = SLOTS[currentSlotIndex];
  console.log(`🔄 Cascade Hop [${prevIndex + 1} ➔ ${currentSlotIndex + 1}/${SLOTS.length}]: Key ${next.keyNumber} (${next.model}) [${reason}]`);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const phaseNum = process.env.PHASE_NUMBER || "1";
const branchName = `feature/phase-0${phaseNum}`;
const specsDir = `specs/phase-${phaseNum}`;

async function callWithSlotPool(fn, maxAttempts = 40) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const active = getActiveSlot();
    if (!active) {
      throw new Error("❌ All keys and models in the cascade were exhausted.");
    }

    try {
      return await fn(active.ai, active.model, active.info);
    } catch (err) {
      const errMsg = err.message || "";
      const status = err.status || err.code || 0;

      const isInvalidKey = errMsg.includes("API_KEY_INVALID") || 
                           errMsg.includes("API key not valid") || 
                           errMsg.includes("INVALID_ARGUMENT");

      const isModelNotFound = errMsg.includes("not found") || 
                              status === 404 || 
                              errMsg.includes("is not supported");

      const isNetworkTimeout = errMsg.includes("fetch failed") || 
                              errMsg.includes("HeadersTimeoutError") || 
                              errMsg.includes("UND_ERR_HEADERS_TIMEOUT") || 
                              errMsg.includes("ETIMEDOUT") || 
                              errMsg.includes("ECONNRESET");

      const isTransientOrQuota = status === 429 ||
                                 status === 503 ||
                                 status === 500 ||
                                 status === 502 ||
                                 status === 504 ||
                                 errMsg.includes("429") || 
                                 errMsg.includes("503") ||
                                 errMsg.includes("RESOURCE_EXHAUSTED") ||
                                 errMsg.includes("Quota exceeded") ||
                                 errMsg.includes("high demand") ||
                                 errMsg.includes("overloaded") ||
                                 errMsg.includes("UNAVAILABLE") ||
                                 isNetworkTimeout;

      const isToolMissing = errMsg.includes("failed to call apply_chunk_code");

      if (isInvalidKey) {
        console.warn(`❌ Key ${active.keyNumber} (${active.maskedKey}) is INVALID. Pruning key from cascade...`);
        const badKey = active.key;
        SLOTS = SLOTS.filter(s => s.key !== badKey);
        console.log(`ℹ️ Remaining slots in cascade: ${SLOTS.length}`);
        continue;
      } else if (isModelNotFound) {
        console.warn(`⚠️ Model '${active.model}' not found in region. Pruning model tier...`);
        const badModel = active.model;
        SLOTS = SLOTS.filter(s => s.model !== badModel);
        console.log(`ℹ️ Remaining slots in cascade: ${SLOTS.length}`);
        continue;
      } else if (isTransientOrQuota || isToolMissing) {
        rotateSlot(isToolMissing ? "Model returned text instead of tool call" : `Transient ${status || "Timeout/503/429"}`);
        await sleep(3000);
        continue;
      } else {
        throw err;
      }
    }
  }
  throw new Error("❌ Exhausted execution attempts across the quality cascade.");
}

// ── 4. TOOL SCHEMAS ─────────────────────────────────────────────────────────
const writeCodeTool = {
  name: "apply_chunk_code",
  description: "Apply file changes using exact line numbers from Repomix. For NEW files, provide 'content'. For EXISTING large files, provide 'patches' with exact search and replace blocks.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      commitMessage: { type: Type.STRING, description: "Descriptive git commit message" },
      files: {
        type: Type.ARRAY,
        description: "List of new files or files to patch",
        items: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "Relative file path" },
            content: { type: Type.STRING, description: "Full content (REQUIRED for new files)" },
            patches: {
              type: Type.ARRAY,
              description: "Array of line-based search-and-replace blocks for existing files",
              items: {
                type: Type.OBJECT,
                properties: {
                  search: { type: Type.STRING, description: "Exact existing lines to find and replace" },
                  replace: { type: Type.STRING, description: "New lines to replace with" }
                },
                required: ["search", "replace"]
              }
            }
          },
          required: ["path"]
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

// ── 5. HELPERS & RESILIENT PACKER ───────────────────────────────────────────
function getBranchAccumulatedFiles() {
  try {
    let baseRef = "main";
    try {
      execSync("git rev-parse --verify origin/main", { stdio: "ignore" });
      baseRef = "origin/main";
    } catch {
      baseRef = "main";
    }

    const stdout = execSync(`git diff --name-only ${baseRef}...HEAD`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"]
    });

    return stdout.split("\n").map(f => f.trim()).filter(f => f && fs.existsSync(f));
  } catch {
    return [];
  }
}

function generateTargetedContext(files) {
  if (files.length === 0) {
    return "<context>Greenfield initialization chunk.</context>";
  }

  try {
    const includeArg = files.map(f => `"${f}"`).join(",");
    execSync(`npx repomix --include ${includeArg} --no-security-check --style xml --show-line-numbers --output repomix-target.xml`, { stdio: "pipe" });
    return fs.readFileSync("repomix-target.xml", "utf-8");
  } catch {
    console.warn("⚠️ Repomix CLI encountered an error. Using native Node.js XML packer fallback...");
    let xml = `<repository>\n`;
    for (const f of files) {
      if (fs.existsSync(f)) {
        const content = fs.readFileSync(f, "utf-8");
        const lines = content.split("\n").map((line, idx) => `${idx + 1} | ${line}`).join("\n");
        xml += `  <file path="${f}">\n${lines}\n  </file>\n`;
      }
    }
    xml += `</repository>`;
    return xml;
  }
}

function applyFileChanges(fileSpec) {
  const filePath = fileSpec.path;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fileSpec.patches && fileSpec.patches.length > 0) {
    if (!fs.existsSync(filePath)) {
      if (fileSpec.content) {
        fs.writeFileSync(filePath, fileSpec.content, "utf-8");
        console.log(`  💾 Created: ${filePath}`);
        return;
      }
      throw new Error(`Cannot patch non-existent file: ${filePath}`);
    }

    let fileContent = fs.readFileSync(filePath, "utf-8");
    for (const patch of fileSpec.patches) {
      if (!patch.search) continue;
      if (fileContent.includes(patch.search)) {
        fileContent = fileContent.replace(patch.search, patch.replace);
      } else {
        const normSearch = patch.search.replace(/\r\n/g, "\n").trim();
        const normContent = fileContent.replace(/\r\n/g, "\n");
        if (normContent.includes(normSearch)) {
          fileContent = normContent.replace(normSearch, patch.replace.replace(/\r\n/g, "\n"));
        } else {
          console.warn(`  ⚠️ Could not find exact patch search block in ${filePath}. Appending safely before end of file.`);
          const lastBraceIdx = fileContent.lastIndexOf("}");
          if (lastBraceIdx !== -1) {
            fileContent = fileContent.slice(0, lastBraceIdx) + "\n" + patch.replace + "\n" + fileContent.slice(lastBraceIdx);
          } else {
            fileContent += "\n" + patch.replace;
          }
        }
      }
    }
    fs.writeFileSync(filePath, fileContent, "utf-8");
    console.log(`  🩹 Patched: ${filePath} (${fileSpec.patches.length} patch(es))`);
    return;
  }

  if (fileSpec.content) {
    fs.writeFileSync(filePath, fileSpec.content, "utf-8");
    console.log(`  💾 Wrote: ${filePath}`);
  }
}

function runLocalSyntaxCheck(files) {
  for (const f of files) {
    if (f.path.endsWith(".js") || f.path.endsWith(".mjs")) {
      try {
        fs.writeFileSync("/tmp/syntax_check.js", f.content || "");
        execSync("node --check /tmp/syntax_check.js", { stdio: "pipe" });
      } catch (err) {
        return { valid: false, error: `Syntax error in ${f.path}: ${err.message}` };
      }
    }
  }
  return { valid: true };
}

function parseFallbackJsonFromText(text) {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const rawJson = jsonMatch ? jsonMatch[1] : text;
    const parsed = JSON.parse(rawJson);
    if (parsed.files && Array.isArray(parsed.files)) {
      return {
        commitMessage: parsed.commitMessage || "Apply chunk changes",
        files: parsed.files
      };
    }
  } catch {}
  return null;
}

// ── 6. MAIN EXECUTION LOOP ──────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(specsDir)) {
    console.error(`Directory ${specsDir} does not exist!`);
    process.exit(1);
  }

  const chunkFiles = fs.readdirSync(specsDir).filter(f => f.endsWith(".md")).sort();
  console.log(`Found ${chunkFiles.length} chunk(s) in Phase ${phaseNum}.`);

  // Clean local working directory and switch branch cleanly
  try {
    execSync("git reset --hard HEAD", { stdio: "ignore" });
    execSync("git clean -fd", { stdio: "ignore" });
    execSync(`git fetch origin ${branchName}`, { stdio: "ignore" });
    execSync(`git checkout ${branchName}`);
    console.log(`✔ Pulled existing remote branch '${branchName}'.`);
  } catch {
    execSync(`git reset --hard HEAD`, { stdio: "ignore" });
    execSync(`git clean -fd`, { stdio: "ignore" });
    execSync(`git checkout -B ${branchName}`);
    console.log(`✔ Initialized fresh branch '${branchName}'.`);
  }

  for (let i = 0; i < chunkFiles.length; i++) {
    const chunkFile = chunkFiles[i];
    const chunkName = path.basename(chunkFile, ".md");
    const rawChunkContent = fs.readFileSync(path.join(specsDir, chunkFile), "utf-8");

    // Skip chunk if already committed on this branch
    try {
      const commitLog = execSync(`git log -n 25 --grep="\\[${chunkName}\\]" --oneline`, { encoding: "utf-8" });
      if (commitLog.trim().length > 0) {
        console.log(`\n⏩ [Skipping] Chunk [${i + 1}/${chunkFiles.length}] ${chunkName} is already committed!`);
        continue;
      }
    } catch {}

    console.log(`\n======================================================`);
    console.log(`⏩ [Chunk ${i + 1}/${chunkFiles.length}] ${chunkName}`);
    console.log(`======================================================`);

    // 1. Resolve Target Files
    const baseFiles = CHUNK_REPOMIX_INCLUDES[chunkName] || [];
    const accumulatedFiles = getBranchAccumulatedFiles();
    const allFilesToPack = [...new Set([...baseFiles, ...accumulatedFiles])].filter(f => fs.existsSync(f));

    console.log(`🎯 Packing ${allFilesToPack.length} file(s) for this chunk:`);
    allFilesToPack.forEach(f => console.log(`   - ${f}`));

    // 2. Generate Targeted Context (Repomix with fallback)
    const targetedContext = generateTargetedContext(allFilesToPack);

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
        const feedbackPrompt = reviewFeedback ? ("\n\n=== FIX REVIEW ISSUES ===\n" + reviewFeedback) : "";
        const res = await ai.models.generateContent({
          model: model,
          contents: `Implement this specification completely.

CRITICAL INSTRUCTIONS:
- The code context below includes LINE NUMBERS. Use them to reference exact blocks.
- For NEW files: provide 'content' (full file).
- For EXISTING files (e.g. SpaceDO.ts, index.ts): Use 'patches' with exact line-based 'search' and 'replace' blocks to avoid output truncation.

CODE CONTEXT (WITH LINE NUMBERS):
${targetedContext}

SPECIFICATION:
${rawChunkContent}${feedbackPrompt}`,
          config: {
            systemInstruction: "You are the Principal Systems Architect for AVOS. You MUST call 'apply_chunk_code'. For existing files, use line-based patches.",
            tools: [{ functionDeclarations: [writeCodeTool] }],
            toolConfig: {
              functionCallingConfig: {
                mode: "ANY" // FORCES function calling
              }
            }
          }
        });

        const call = res.functionCalls?.find(c => c.name === "apply_chunk_code");
        if (call) return call.args;

        const parsedFromText = parseFallbackJsonFromText(res.text || "");
        if (parsedFromText) {
          console.log("ℹ️ Extracted valid files payload from model text response.");
          return parsedFromText;
        }

        throw new Error(`Model on ${info} failed to call apply_chunk_code.`);
      });

      rotateSlot("Pacing step");
      await sleep(3000);

      // Local VM Syntax Pre-Check ($0 cost)
      const syntaxCheck = runLocalSyntaxCheck(finalOutput.files);
      if (!syntaxCheck.valid) {
        console.warn(`⚠️ Syntax Check Failed: ${syntaxCheck.error}`);
        reviewFeedback = `Local compiler syntax failure: ${syntaxCheck.error}`;
        continue;
      }

      // Review Pass
      const summaryDiff = JSON.stringify(finalOutput.files, null, 2);
      const review = await callWithSlotPool(async (ai, model, info) => {
        console.log(`🧐 [Audit Attempt ${attempt}] Reviewing with [${info}]...`);
        const res = await ai.models.generateContent({
          model: model,
          contents: `Audit the changes against requirements. Check syntax, imports, and Cloudflare compatibility.\n\nSPEC:\n${rawChunkContent}\n\nPROPOSED CHANGES:\n${summaryDiff}`,
          config: {
            systemInstruction: "Call 'submit_code_review'. Set approved=true ONLY if bug-free and compliant.",
            tools: [{ functionDeclarations: [reviewCodeTool] }],
            toolConfig: {
              functionCallingConfig: {
                mode: "ANY"
              }
            }
          }
        });

        const call = res.functionCalls?.find(c => c.name === "submit_code_review");
        return call ? call.args : { approved: true };
      });

      rotateSlot("Pacing step");
      await sleep(3000);

      if (review.approved) {
        console.log("✅ Code Review Passed!");
        break;
      }

      console.warn(`❌ Review Rejected: ${review.issuesFound?.join("; ")}`);
      reviewFeedback = review.fixInstructions || review.issuesFound?.join("\n");
    }

    // 4. Write Files & Patches to Disk
    for (const f of finalOutput.files) {
      applyFileChanges(f);
    }

    // 5. Commit Locally AND Push Immediately ONLY IF WORKING TREE HAS STAGED CHANGES
    execSync(`git add .`);
    const gitStatus = execSync("git status --porcelain", { encoding: "utf-8" }).trim();

    if (gitStatus.length > 0) {
      execSync(`git commit -m "feat(phase-${phaseNum}): [${chunkName}] ${finalOutput.commitMessage}"`);
      console.log(`✔ Committed chunk: "${finalOutput.commitMessage}"`);

      console.log(`☁️ Syncing chunk progress to remote branch '${branchName}'...`);
      execSync(`git push -u origin ${branchName}`);
    } else {
      console.warn(`⚠️ Working tree clean for [${chunkName}]. Skipping empty commit.`);
    }

    if (i < chunkFiles.length - 1) {
      console.log("⏳ Waiting 4s before next chunk...");
      await sleep(4000);
    }
  }

  // 6. Open Pull Request on Completion
  try {
    execSync(`gh pr create --title "AVOS: Complete Phase ${phaseNum}" --body "Automated Quality-First implementation of Phase ${phaseNum}." --base main --head ${branchN
