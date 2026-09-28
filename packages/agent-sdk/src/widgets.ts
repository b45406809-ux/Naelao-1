/** Safe, declarative UI that a model may embed in a chat turn. */
export type GeneratedWidget =
  | { type: "datetime"; id: string; label: string; value?: string; min?: string; max?: string }
  | { type: "range"; id: string; label: string; min: number; max: number; step?: number; value?: number }
  | { type: "multi_select"; id: string; label: string; options: readonly string[]; selected?: readonly string[] }
  | { type: "decision_table"; id: string; columns: readonly string[]; rows: readonly Readonly<Record<string, string | number | boolean | null>>[] }
  | { type: "action_card"; id: string; title: string; description?: string; action: "approve" | "rollback"; progress?: number };

const TAG = /<\/?[a-z][^>]*>/i;
const EXECUTABLE = /(?:<script\b|javascript\s*:|data\s*:\s*text\/html|on(?:click|load|error)\s*=|\beval\s*\(|\bfunction\s*\()/i;
const text = (value: unknown, field: string, max = 500): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || TAG.test(value) || EXECUTABLE.test(value)) throw new Error(`invalid widget ${field}`);
  return value;
};
const number = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid widget ${field}`);
  return value;
};
function rejectExecutable(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > 64_000 || TAG.test(encoded) || EXECUTABLE.test(encoded)) throw new Error("executable or HTML widget content is forbidden");
}

export function validateGeneratedWidget(value: unknown): GeneratedWidget {
  rejectExecutable(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid widget");
  const v = value as Record<string, unknown>;
  const type = v.type;
  const id = text(v.id, "id", 100);
  if (type === "datetime") return { type, id, label: text(v.label, "label"), ...(v.value === undefined ? {} : { value: text(v.value, "value") }), ...(v.min === undefined ? {} : { min: text(v.min, "min") }), ...(v.max === undefined ? {} : { max: text(v.max, "max") }) };
  if (type === "range") {
    const min = number(v.min, "min"), max = number(v.max, "max");
    if (max <= min) throw new Error("widget max must exceed min");
    return { type, id, label: text(v.label, "label"), min, max, ...(v.step === undefined ? {} : { step: number(v.step, "step") }), ...(v.value === undefined ? {} : { value: number(v.value, "value") }) };
  }
  if (type === "multi_select") {
    if (!Array.isArray(v.options) || v.options.length > 100) throw new Error("invalid widget options");
    const options = v.options.map((item) => text(item, "option", 100));
    const selected = v.selected === undefined ? undefined : Array.isArray(v.selected) ? v.selected.map((item) => text(item, "selected", 100)) : (() => { throw new Error("invalid widget selected"); })();
    return { type, id, label: text(v.label, "label"), options, ...(selected ? { selected } : {}) };
  }
  if (type === "decision_table") {
    if (!Array.isArray(v.columns) || !Array.isArray(v.rows) || v.columns.length > 20 || v.rows.length > 200) throw new Error("invalid decision table");
    const columns = v.columns.map((item) => text(item, "column", 100));
    const rows = v.rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid decision row");
      const clean: Record<string, string | number | boolean | null> = {};
      for (const column of columns) { const cell = (row as Record<string, unknown>)[column]; if (cell !== null && !["string", "number", "boolean"].includes(typeof cell)) throw new Error("invalid decision cell"); clean[column] = cell as string | number | boolean | null; }
      return clean;
    });
    return { type, id, columns, rows };
  }
  if (type === "action_card") {
    if (v.action !== "approve" && v.action !== "rollback") throw new Error("invalid widget action");
    const progress = v.progress === undefined ? undefined : number(v.progress, "progress");
    if (progress !== undefined && (progress < 0 || progress > 100)) throw new Error("invalid widget progress");
    return { type, id, title: text(v.title, "title"), action: v.action, ...(v.description === undefined ? {} : { description: text(v.description, "description", 2000) }), ...(progress === undefined ? {} : { progress }) };
  }
  throw new Error("widget type is not allowed");
}
