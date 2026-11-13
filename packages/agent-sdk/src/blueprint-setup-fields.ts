import type { BlueprintSetupField, SpaceBlueprint } from "./types.js";

export type BlueprintSetupValue = string | number | boolean;
export type BlueprintSetupValues = Record<string, Record<string, BlueprintSetupValue>>;
export interface BlueprintSetupFieldGroup {
  project_id: string;
  project_name: string;
  fields: BlueprintSetupField[];
}

const MAX_FIELDS_PER_PROJECT = 32;
const MAX_FIELDS_TOTAL = 128;
const MAX_SETUP_SCHEMA_BYTES = 64 * 1024;
const MAX_LABEL_LENGTH = 80;
const MAX_HELP_LENGTH = 240;
const MAX_TEXT_LENGTH = 2_000;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_LOCALE_MAP_SIZE = 12;
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const SECRET_WORDING = /(?:password|passphrase|secret|credential|\btoken\b|api[\s_-]*key|private[\s_-]*key|access[\s_-]*key|connection[\s_-]*string)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} contains unsupported property: ${key}`);
}

function boundedText(value: unknown, min: number, max: number, label: string): value is string {
  return typeof value === "string" && value.trim().length >= min && value.length <= max && !value.includes("\0");
}

function validateLocaleMap(raw: unknown, maxText: number, label: string): string[] {
  if (!isRecord(raw) || Object.keys(raw).length < 1 || Object.keys(raw).length > MAX_LOCALE_MAP_SIZE) throw new Error(`Invalid ${label} translations`);
  const values: string[] = [];
  for (const [locale, value] of Object.entries(raw)) {
    if (!LOCALE_PATTERN.test(locale) || !boundedText(value, 1, maxText, `${label} translation`)) throw new Error(`Invalid ${label} translation`);
    values.push(value);
  }
  return values;
}

function validateFieldLocalization(raw: unknown, field: Record<string, unknown>, fieldId: string): string[] {
  if (!isRecord(raw)) throw new Error(`Invalid setup field localization: ${fieldId}`);
  rejectUnknownKeys(raw, ["label", "helpText", "optionLabels"], `setup field localization ${fieldId}`);
  const translated: string[] = [];
  if (raw.label !== undefined) translated.push(...validateLocaleMap(raw.label, MAX_LABEL_LENGTH, fieldId));
  if (raw.helpText !== undefined) translated.push(...validateLocaleMap(raw.helpText, MAX_HELP_LENGTH, fieldId));
  if (raw.optionLabels !== undefined) {
    if (!isRecord(raw.optionLabels) || Object.keys(raw.optionLabels).length < 1 || Object.keys(raw.optionLabels).length > 30)
      throw new Error(`Invalid setup option translations: ${fieldId}`);
    const options = field.type === "select" && Array.isArray(field.options)
      ? new Set(field.options.flatMap(option => isRecord(option) && typeof option.value === "string" ? [option.value] : [])) : new Set<string>();
    for (const [optionValue, translations] of Object.entries(raw.optionLabels)) {
      if (!options.has(optionValue)) throw new Error(`Unknown translated option: ${fieldId}`);
      translated.push(...validateLocaleMap(translations, MAX_LABEL_LENGTH, fieldId));
    }
  }
  return translated;
}

function validateField(field: unknown, schemaVersion: 1 | 2 = 1): asserts field is BlueprintSetupField {
  if (!isRecord(field)) throw new Error("Invalid setup field");
  if (typeof field.id !== "string" || !ID_PATTERN.test(field.id)) throw new Error("Invalid setup field id");
  if (!boundedText(field.label, 1, MAX_LABEL_LENGTH, `setup field ${field.id} label`)) throw new Error(`Invalid setup field label: ${field.id}`);
  if (field.helpText !== undefined && !boundedText(field.helpText, 1, MAX_HELP_LENGTH, `setup field ${field.id} help text`)) throw new Error(`Invalid setup field help text: ${field.id}`);
  if (field.required !== undefined && typeof field.required !== "boolean") throw new Error(`Invalid setup field required flag: ${field.id}`);
  const v2Keys = schemaVersion === 2 ? ["localization", "visibleWhen"] : [];
  const localizedStrings = field.localization === undefined || schemaVersion !== 2 ? [] : validateFieldLocalization(field.localization, field, field.id);
  if (field.visibleWhen !== undefined && schemaVersion === 2) {
    if (!isRecord(field.visibleWhen)) throw new Error(`Invalid setup visibility condition: ${field.id}`);
    rejectUnknownKeys(field.visibleWhen, ["fieldId", "equals"], `setup field visibility ${field.id}`);
    if (typeof field.visibleWhen.fieldId !== "string" || !ID_PATTERN.test(field.visibleWhen.fieldId)
      || !["string", "number", "boolean"].includes(typeof field.visibleWhen.equals)
      || (typeof field.visibleWhen.equals === "number" && !Number.isFinite(field.visibleWhen.equals)))
      throw new Error(`Invalid setup visibility condition: ${field.id}`);
  }
  if (SECRET_WORDING.test(`${field.id} ${field.label} ${field.helpText ?? ""} ${localizedStrings.join(" ")}`)) throw new Error(`Setup fields cannot request provider credentials: ${field.id}`);
  const typed = field as unknown as BlueprintSetupField;

  if (typed.type === "text") {
    rejectUnknownKeys(field, ["id", "type", "label", "helpText", "required", "defaultValue", "minLength", "maxLength", ...v2Keys], `setup field ${field.id}`);
    const minRaw = field.minLength, maxRaw = field.maxLength;
    if ((minRaw !== undefined && typeof minRaw !== "number") || (maxRaw !== undefined && typeof maxRaw !== "number")) throw new Error(`Invalid setup field text bounds: ${field.id}`);
    const min = minRaw === undefined ? 0 : minRaw, max = maxRaw === undefined ? 1_000 : maxRaw;
    if (!Number.isInteger(min) || min < 0 || min > MAX_TEXT_LENGTH || !Number.isInteger(max) || max < 1 || max > MAX_TEXT_LENGTH || min > max)
      throw new Error(`Invalid setup field text bounds: ${field.id}`);
    if (typed.defaultValue !== undefined && (!boundedText(typed.defaultValue, min, max, `setup field ${field.id} default`) || typed.defaultValue.length < min))
      throw new Error(`Invalid setup field default: ${field.id}`);
    return;
  }
  if (typed.type === "number") {
    rejectUnknownKeys(field, ["id", "type", "label", "helpText", "required", "defaultValue", "minimum", "maximum", "integer", ...v2Keys], `setup field ${field.id}`);
    const minimum = typed.minimum ?? -1_000_000_000, maximum = typed.maximum ?? 1_000_000_000;
    if (typeof minimum !== "number" || !Number.isFinite(minimum) || Math.abs(minimum) > 1_000_000_000
      || typeof maximum !== "number" || !Number.isFinite(maximum) || Math.abs(maximum) > 1_000_000_000 || minimum > maximum)
      throw new Error(`Invalid setup field number bounds: ${field.id}`);
    if (typed.integer !== undefined && typeof typed.integer !== "boolean") throw new Error(`Invalid setup field integer flag: ${field.id}`);
    if (typed.defaultValue !== undefined && (typeof typed.defaultValue !== "number" || !Number.isFinite(typed.defaultValue)
      || typed.defaultValue < minimum || typed.defaultValue > maximum || (typed.integer === true && !Number.isInteger(typed.defaultValue))))
      throw new Error(`Invalid setup field default: ${field.id}`);
    return;
  }
  if (typed.type === "boolean") {
    rejectUnknownKeys(field, ["id", "type", "label", "helpText", "required", "defaultValue", ...v2Keys], `setup field ${field.id}`);
    if (typed.defaultValue !== undefined && typeof typed.defaultValue !== "boolean") throw new Error(`Invalid setup field default: ${field.id}`);
    return;
  }
  if (typed.type === "select") {
    rejectUnknownKeys(field, ["id", "type", "label", "helpText", "required", "defaultValue", "options", ...v2Keys], `setup field ${field.id}`);
    if (!Array.isArray(typed.options) || typed.options.length < 1 || typed.options.length > 30) throw new Error(`Invalid setup field options: ${field.id}`);
    const seen = new Set<string>();
    for (const option of typed.options) {
      if (!isRecord(option)) throw new Error(`Invalid setup field option: ${field.id}`);
      rejectUnknownKeys(option, ["value", "label"], `setup field option ${field.id}`);
      if (!boundedText(option.value, 1, 64, `setup field option ${field.id} value`)
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(option.value)
        || !boundedText(option.label, 1, MAX_LABEL_LENGTH, `setup field option ${field.id} label`)
        || seen.has(option.value)) throw new Error(`Invalid or duplicate setup field option: ${field.id}`);
      seen.add(option.value);
    }
    if (typed.defaultValue !== undefined && (typeof typed.defaultValue !== "string" || !seen.has(typed.defaultValue)))
      throw new Error(`Invalid setup field default: ${field.id}`);
    return;
  }
  throw new Error(`Unsupported setup field type: ${field.type}`);
}

/** Validates bounded versioned field definitions; extension settings keep their version-1 default. */
export function validateSetupFieldDefinitions(raw: unknown, options: { schemaVersion?: 1 | 2 } = {}): BlueprintSetupField[] {
  if (!Array.isArray(raw) || raw.length > MAX_FIELDS_PER_PROJECT) throw new Error("Setup field list exceeds the field limit");
  const ids = new Set<string>();
  for (const field of raw) {
    validateField(field, options.schemaVersion ?? 1);
    if (ids.has(field.id)) throw new Error(`Duplicate setup field id: ${field.id}`);
    ids.add(field.id);
  }
  const definitions = structuredClone(raw) as BlueprintSetupField[];
  if ((options.schemaVersion ?? 1) === 2) validateVisibilityConditions(definitions);
  return definitions;
}

function validateVisibilityConditions(fields: readonly BlueprintSetupField[]): void {
  const positions = new Map(fields.map((field, index) => [field.id, index]));
  for (const [index, field] of fields.entries()) {
    const condition = field.visibleWhen;
    if (!condition) continue;
    const sourceIndex = positions.get(condition.fieldId);
    if (sourceIndex === undefined || sourceIndex >= index) throw new Error(`Setup visibility must reference an earlier field: ${field.id}`);
    const source = fields[sourceIndex]!;
    const value = condition.equals;
    const valid = source.type === "text" ? typeof value === "string" && boundedText(value, source.minLength ?? 0, source.maxLength ?? 1_000, `visibility value ${field.id}`) && !(source.required && value.trim() === "")
      : source.type === "number" ? typeof value === "number" && Number.isFinite(value) && value >= (source.minimum ?? -1_000_000_000) && value <= (source.maximum ?? 1_000_000_000) && (source.integer !== true || Number.isInteger(value))
      : source.type === "boolean" ? typeof value === "boolean"
      : typeof value === "string" && source.options.some(option => option.value === value);
    if (!valid) throw new Error(`Setup visibility value does not match controller field: ${field.id}`);
  }
}

function localeCandidates(locale: string): string[] {
  const parts = locale.replaceAll("_", "-").split("-");
  const language = parts[0]?.toLowerCase() ?? "";
  const normalized = parts.length > 1 ? `${language}-${parts[1]!.toUpperCase()}` : language;
  return [...new Set([normalized, language])];
}
function localizedValue(values: Record<string, string> | undefined, locale: string): string | undefined {
  if (!values) return undefined;
  for (const candidate of localeCandidates(locale)) if (values[candidate] !== undefined) return values[candidate];
  return undefined;
}
export function resolveBlueprintSetupFieldLabel(field: BlueprintSetupField, locale: string): string {
  return localizedValue(field.localization?.label, locale) ?? field.label;
}
export function resolveBlueprintSetupFieldHelpText(field: BlueprintSetupField, locale: string): string | undefined {
  return localizedValue(field.localization?.helpText, locale) ?? field.helpText;
}
export function resolveBlueprintSetupOptionLabel(field: Extract<BlueprintSetupField, { type: "select" }>, optionValue: string, locale: string): string {
  const option = field.options.find(item => item.value === optionValue);
  return localizedValue(field.localization?.optionLabels?.[optionValue], locale) ?? option?.label ?? optionValue;
}

/** Resolve the single equality condition supported by v2; conditions are data, never code. */
export function isBlueprintSetupFieldVisible(fields: readonly BlueprintSetupField[], field: BlueprintSetupField, values: Readonly<Record<string, BlueprintSetupValue | undefined>>): boolean {
  if (!field.visibleWhen) return true;
  const controller = fields.find(candidate => candidate.id === field.visibleWhen!.fieldId);
  if (!controller) return false;
  const value = Object.hasOwn(values, controller.id) ? values[controller.id] : controller.defaultValue;
  return value === field.visibleWhen.equals;
}

/** Validates values against one field list and applies declared defaults. */
export function validateSetupFieldValues(fields: readonly BlueprintSetupField[], raw: unknown, options: { allowIncomplete?: boolean } = {}): Record<string, BlueprintSetupValue> {
  const definitions = validateSetupFieldDefinitions(fields, { schemaVersion: 2 });
  validateVisibilityConditions(definitions);
  if (!isRecord(raw)) throw new Error("Setup values must be an object");
  const byId = new Map(definitions.map(field => [field.id, field]));
  for (const fieldId of Object.keys(raw)) if (!byId.has(fieldId)) throw new Error(`Unknown setup field: ${fieldId}`);
  const normalized: Record<string, BlueprintSetupValue> = Object.create(null) as Record<string, BlueprintSetupValue>;
  let bytes = 0;
  for (const field of definitions) {
    if (!isBlueprintSetupFieldVisible(definitions, field, raw as Record<string, BlueprintSetupValue | undefined>)) continue;
    const supplied = Object.hasOwn(raw, field.id) ? raw[field.id] : undefined;
    const value = supplied === undefined ? field.defaultValue : supplied;
    if (value === undefined) {
      if (options.allowIncomplete) continue;
      if (field.required) throw new Error(`Required setup value missing: ${field.id}`);
      continue;
    }
    if (field.required && typeof value === "string" && value.trim() === "") throw new Error(`Required setup value missing: ${field.id}`);
    if (field.type === "text") {
      const min = field.minLength ?? 0, max = field.maxLength ?? 1_000;
      if (!boundedText(value, min, max, `setup value ${field.id}`) || value.length < min) throw new Error(`Invalid setup value: ${field.id}`);
    } else if (field.type === "number") {
      const minimum = field.minimum ?? -1_000_000_000, maximum = field.maximum ?? 1_000_000_000;
      if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (field.integer === true && !Number.isInteger(value)))
        throw new Error(`Invalid setup value: ${field.id}`);
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`Invalid setup value: ${field.id}`);
    } else if (typeof value !== "string" || !field.options.some(option => option.value === value)) {
      throw new Error(`Invalid setup value: ${field.id}`);
    }
    bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > MAX_VALUE_BYTES) throw new Error("Setup values exceed the byte limit");
    normalized[field.id] = value;
  }
  return normalized;
}

/** Validates the bounded declarative schema used by signed Space Template artifacts. */
export function validateBlueprintSetupSchema(blueprint: SpaceBlueprint): BlueprintSetupFieldGroup[] {
  const schemaVersion = blueprint.setupSchemaVersion ?? 1;
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error("Unsupported setup schema version");
  let total = 0;
  const groups: BlueprintSetupFieldGroup[] = [];
  const projectIds = new Set<string>();
  for (const project of blueprint.projects) {
    const fields = project.setupFields;
    if (fields === undefined) continue;
    if (!Array.isArray(fields) || fields.length > MAX_FIELDS_PER_PROJECT) throw new Error(`Invalid setup fields for project: ${project.name}`);
    if (fields.length === 0) continue;
    if (blueprint.setupSchemaVersion === undefined) throw new Error("setupSchemaVersion 1 is required when setup fields are declared");
    if (typeof project.id !== "string" || !PROJECT_ID_PATTERN.test(project.id) || projectIds.has(project.id)) throw new Error(`Setup fields require a unique stable project id: ${project.name}`);
    projectIds.add(project.id);
    const checkedFields = validateSetupFieldDefinitions(fields, { schemaVersion });
    validateVisibilityConditions(checkedFields);
    total += fields.length;
    if (total > MAX_FIELDS_TOTAL) throw new Error("Space Template setup schema exceeds the field limit");
    groups.push({ project_id: project.id, project_name: project.name, fields: checkedFields });
  }
  return validateBlueprintSetupGroups(groups);
}

/** Validates persisted setup schema data before it is used by a runtime consumer. */
export function validateBlueprintSetupGroups(raw: unknown): BlueprintSetupFieldGroup[] {
  if (!Array.isArray(raw) || raw.length > MAX_FIELDS_TOTAL) throw new Error("Invalid setup schema groups");
  const projectIds = new Set<string>();
  let total = 0;
  const groups = raw.map(value => {
    if (!isRecord(value)) throw new Error("Invalid setup schema group");
    rejectUnknownKeys(value, ["project_id", "project_name", "fields"], "setup schema group");
    if (typeof value.project_id !== "string" || !PROJECT_ID_PATTERN.test(value.project_id) || projectIds.has(value.project_id))
      throw new Error("Setup schema groups require unique stable project ids");
    if (!boundedText(value.project_name, 1, 120, "setup project name")) throw new Error("Invalid setup project name");
    const fields = validateSetupFieldDefinitions(value.fields, { schemaVersion: 2 });
    if (!fields.length) throw new Error("Setup schema groups must contain fields");
    validateVisibilityConditions(fields);
    total += fields.length;
    if (total > MAX_FIELDS_TOTAL) throw new Error("Space Template setup schema exceeds the field limit");
    projectIds.add(value.project_id);
    return { project_id: value.project_id, project_name: value.project_name, fields };
  });
  if (new TextEncoder().encode(JSON.stringify(groups)).byteLength > MAX_SETUP_SCHEMA_BYTES) throw new Error("Space Template setup schema exceeds the byte limit");
  return groups;
}

/** Validates values against an already validated setup schema and supplies declared defaults. */
export function validateBlueprintSetupValuesForSchema(groups: readonly BlueprintSetupFieldGroup[], raw: unknown, options: { allowIncomplete?: boolean } = {}): BlueprintSetupValues {
  const checkedGroups = validateBlueprintSetupGroups(groups);
  if (!isRecord(raw)) throw new Error("Setup values must be an object");
  const byProject = new Map(checkedGroups.map(group => [group.project_id, group]));
  for (const projectId of Object.keys(raw)) if (!byProject.has(projectId)) throw new Error(`Unknown setup project: ${projectId}`);
  const normalized: BlueprintSetupValues = Object.create(null) as BlueprintSetupValues;
  for (const group of checkedGroups) {
    const submitted = raw[group.project_id];
    if (submitted !== undefined && !isRecord(submitted)) throw new Error(`Setup values for ${group.project_id} must be an object`);
    const values = validateSetupFieldValues(group.fields, submitted ?? {}, options);
    if (Object.keys(values).length) normalized[group.project_id] = values;
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_VALUE_BYTES) throw new Error("Setup values exceed the byte limit");
  return normalized;
}

/** Validates user values against the signed schema and supplies declared defaults. */
export function validateBlueprintSetupValues(blueprint: SpaceBlueprint, raw: unknown): BlueprintSetupValues {
  return validateBlueprintSetupValuesForSchema(validateBlueprintSetupSchema(blueprint), raw);
}
