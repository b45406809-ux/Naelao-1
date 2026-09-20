# Gemini batch patches

Download Gemini AI Studio's response as a unified Git diff and commit it here using the batch name
from the prompt, for example `repomix/patches/batch-01.patch`.

The **Apply Gemini batch patch** workflow validates the file as data (it never executes it as a
shell script), applies it with `git apply`, regenerates and verifies the prompts, commits the code
changes to the same branch, and uploads the next batch's XML and prompt as a GitHub Actions
artifact. A fenced `diff` response is accepted, but a raw diff beginning with `diff --git` is
preferred.

Only upload one new or changed `batch-NN.patch` in a commit. If a batch needs another continuation,
replace that same patch file with the next AI Studio response after the previous workflow finishes.
