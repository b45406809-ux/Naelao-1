"use client";

import * as React from "react";
import {
  ApiError,
  getProjectMainRestartRecipes,
  saveProjectMainRestartRecipes,
  type ProjectMainRestartRecipe,
  type ProjectMainRestartRecipeSet,
  type SessionCredentials,
} from "@/lib/api";

function initialRecipe(id: string): ProjectMainRestartRecipe {
  return { id, label: "Web service", workingDirectory: ".", argv: ["npm", "run", "start"],
    manualVerification: "Open the service health page and confirm it responds." };
}

export function ProjectMainRestartRecipesEditor({ spaceId, projectId, session }: {
  spaceId: string; projectId: string; session: SessionCredentials;
}) {
  const [saved, setSaved] = React.useState<ProjectMainRestartRecipeSet | null>(null);
  const [recipes, setRecipes] = React.useState<ProjectMainRestartRecipe[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");

  const refresh = React.useCallback(async () => {
    setError("");
    try {
      const result = await getProjectMainRestartRecipes(spaceId, projectId, session);
      setSaved(result);
      setRecipes(result.recipes);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Restart recipe settings are unavailable.";
      setError(failure instanceof ApiError && failure.status === 403
        ? "Owner or admin access is required to view or edit restart recipes." : message);
    }
  }, [spaceId, projectId, session]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  function update(index: number, change: Partial<ProjectMainRestartRecipe>) {
    setRecipes(current => current.map((recipe, position) => position === index ? { ...recipe, ...change } : recipe));
  }

  async function save() {
    if (!saved || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await saveProjectMainRestartRecipes(spaceId, projectId, session,
        { recipes, expected_version: saved.version });
      setSaved(result); setRecipes(result.recipes);
      setNotice("Recipe metadata saved. Nothing was executed.");
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Restart recipe settings could not be saved.";
      setError(failure instanceof ApiError && failure.status === 409
        ? "These recipes changed elsewhere. Reload before saving again." : message);
    } finally { setBusy(false); }
  }

  return <div style={{ display: "grid", gap: 10, margin: "12px 0 20px" }}>
    <div className="section-label">Project service restart notes</div>
    <p style={{ color: "var(--text3)", fontSize: 12, margin: 0 }}>
      Owner-reviewed metadata only. Recipes are inert: this deployment cannot execute them or verify service health. Use project-relative working directories and one argument per line; do not enter secrets, environment values, or credentials.
    </p>
    {!saved && !error && <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading restart recipe settings…</p>}
    {saved && <>
      {recipes.map((recipe, index) => <fieldset key={index} disabled={busy}
        style={{ display: "grid", gap: 8, border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
        <legend>{recipe.label || `Service ${index + 1}`}</legend>
        <label>Recipe ID<input aria-label={`Recipe ${index + 1} ID`} value={recipe.id}
          onChange={event => update(index, { id: event.target.value })} maxLength={64} /></label>
        <label>Service label<input aria-label={`Recipe ${index + 1} label`} value={recipe.label}
          onChange={event => update(index, { label: event.target.value })} maxLength={80} /></label>
        <label>Working directory, relative to project root<input aria-label={`Recipe ${index + 1} working directory`}
          value={recipe.workingDirectory} onChange={event => update(index, { workingDirectory: event.target.value })} maxLength={160} /></label>
        <label>Command arguments, one token per line<textarea aria-label={`Recipe ${index + 1} arguments`}
          value={recipe.argv.join("\n")} onChange={event => update(index, { argv: event.target.value.split("\n") })}
          rows={4} maxLength={2048} /></label>
        <label>Manual verification instructions<textarea aria-label={`Recipe ${index + 1} verification`}
          value={recipe.manualVerification} onChange={event => update(index, { manualVerification: event.target.value })}
          rows={2} maxLength={240} /></label>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
          onClick={() => setRecipes(current => current.filter((_, position) => position !== index))}>Remove recipe</button>
      </fieldset>)}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || recipes.length >= 10}
          onClick={() => setRecipes(current => {
            let suffix = current.length + 1;
            while (current.some(recipe => recipe.id === `service-${suffix}`)) suffix++;
            return [...current, initialRecipe(`service-${suffix}`)];
          })}>Add service recipe</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy}
          onClick={() => void save()}>{busy ? "Saving…" : "Save restart notes"}</button>
      </div>
      <span style={{ color: "var(--text3)", fontSize: 12 }}>Version {saved.version} · {saved.executionSupported ? "execution supported" : "execution unsupported"}</span>
    </>}
    {error && <p role="alert" style={{ color: "var(--danger, #b91c1c)", fontSize: 13, margin: 0 }}>{error}
      {saved && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void refresh()}>Reload</button>}</p>}
    {notice && <p role="status" aria-live="polite" style={{ color: "var(--text3)", fontSize: 12, margin: 0 }}>{notice}</p>}
  </div>;
}
