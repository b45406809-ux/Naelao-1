"use client";

import * as React from "react";
import { Badge, Button } from "@naelao/ui";

export interface DynamicUIBlock {
  type: "dynamic_ui" | "input_widget" | "decision_table" | "action_card";
  component: "BookingSlotPicker" | "BudgetSlider" | "MultiSelectChips" | "DecisionTable" | "QuickActionGrid" | "FormWidget";
  title?: string;
  description?: string;
  props: Record<string, any>;
}

interface DynamicGenerativeUIProps {
  block: DynamicUIBlock;
  onDispatchAction: (actionName: string, payload: Record<string, any>) => void;
  disabled?: boolean;
}

export function DynamicGenerativeUI({ block, onDispatchAction, disabled = false }: DynamicGenerativeUIProps) {
  const { component, title, description, props } = block;

  // State for interactive widgets
  const [selectedDate, setSelectedDate] = React.useState<string>(props.defaultDate || props.availableDates?.[0] || "");
  const [selectedSlot, setSelectedSlot] = React.useState<string>(props.defaultSlot || props.availableSlots?.[0] || "");
  const [sliderValue, setSliderValue] = React.useState<number>(Number(props.defaultValue ?? props.min ?? 50));
  const [selectedChips, setSelectedChips] = React.useState<Set<string>>(
    new Set(props.defaultSelected || [])
  );
  const [submitted, setSubmitted] = React.useState(false);

  const toggleChip = (chip: string) => {
    if (disabled || submitted) return;
    setSelectedChips((prev) => {
      const next = new Set(prev);
      if (next.has(chip)) next.delete(chip);
      else next.add(chip);
      return next;
    });
  };

  return (
    <div
      style={{
        marginTop: 10,
        marginBottom: 10,
        padding: "14px 16px",
        borderRadius: "12px",
        background: "var(--surface2, rgba(255, 255, 255, 0.04))",
        border: "1px solid var(--border, rgba(255, 255, 255, 0.1))",
        boxShadow: "0 2px 10px rgba(0, 0, 0, 0.04)",
        maxWidth: 520,
        fontSize: "12.5px",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>✨</span>
          <strong style={{ color: "var(--text)", fontSize: "13px" }}>{title || "Dynamic Interactive Input"}</strong>
        </div>
        <Badge color="purple">Generative UI</Badge>
      </div>

      {description && (
        <p style={{ margin: "0 0 12px", color: "var(--text3)", fontSize: "12px", lineHeight: 1.4 }}>
          {description}
        </p>
      )}

      {/* Component 1: BookingSlotPicker */}
      {component === "BookingSlotPicker" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {props.availableDates && (
            <div>
              <div style={{ fontSize: "11px", color: "var(--text3)", marginBottom: 4, fontWeight: 600 }}>
                SELECT DATE
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(props.availableDates as string[]).map((date) => (
                  <button
                    key={date}
                    type="button"
                    disabled={disabled || submitted}
                    onClick={() => setSelectedDate(date)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      fontSize: "11.5px",
                      border: selectedDate === date ? "1px solid var(--accent, #5b52f0)" : "1px solid var(--border)",
                      background: selectedDate === date ? "rgba(91, 82, 240, 0.15)" : "var(--surface)",
                      color: selectedDate === date ? "var(--accent, #5b52f0)" : "var(--text)",
                      cursor: disabled || submitted ? "default" : "pointer",
                      fontWeight: selectedDate === date ? 600 : 400,
                    }}
                  >
                    📅 {date}
                  </button>
                ))}
              </div>
            </div>
          )}

          {props.availableSlots && (
            <div>
              <div style={{ fontSize: "11px", color: "var(--text3)", marginBottom: 4, fontWeight: 600 }}>
                AVAILABLE TIME SLOTS
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(props.availableSlots as string[]).map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    disabled={disabled || submitted}
                    onClick={() => setSelectedSlot(slot)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      fontSize: "11.5px",
                      border: selectedSlot === slot ? "1px solid var(--accent, #5b52f0)" : "1px solid var(--border)",
                      background: selectedSlot === slot ? "rgba(91, 82, 240, 0.15)" : "var(--surface)",
                      color: selectedSlot === slot ? "var(--accent, #5b52f0)" : "var(--text)",
                      cursor: disabled || submitted ? "default" : "pointer",
                      fontWeight: selectedSlot === slot ? 600 : 400,
                    }}
                  >
                    ⏰ {slot}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <Button
              variant="primary"
              disabled={disabled || submitted || !selectedDate || !selectedSlot}
              onClick={() => {
                setSubmitted(true);
                onDispatchAction("CONFIRM_BOOKING_SLOT", {
                  date: selectedDate,
                  slot: selectedSlot,
                  tier: props.tier,
                });
              }}
              style={{ fontSize: "11.5px", padding: "6px 14px" }}
            >
              {submitted ? "✓ Confirmed" : `Confirm ${selectedDate} at ${selectedSlot}`}
            </Button>
          </div>
        </div>
      )}

      {/* Component 2: BudgetSlider */}
      {component === "BudgetSlider" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "11.5px", color: "var(--text3)" }}>
              {props.label || "Adjust Allocation"}
            </span>
            <strong style={{ fontSize: "14px", color: "var(--accent, #5b52f0)" }}>
              {props.prefix || ""}{sliderValue.toLocaleString()}{props.suffix || ""}
            </strong>
          </div>

          <input
            type="range"
            min={props.min ?? 10}
            max={props.max ?? 1000}
            step={props.step ?? 10}
            value={sliderValue}
            disabled={disabled || submitted}
            onChange={(e) => setSliderValue(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--accent, #5b52f0)", cursor: "pointer" }}
          />

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10.5px", color: "var(--text3)" }}>
            <span>{props.prefix || ""}{props.min ?? 10}{props.suffix || ""}</span>
            <span>{props.prefix || ""}{props.max ?? 1000}{props.suffix || ""}</span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
            <Button
              variant="primary"
              disabled={disabled || submitted}
              onClick={() => {
                setSubmitted(true);
                onDispatchAction("CONFIRM_SLIDER_VALUE", {
                  field: props.field || "value",
                  value: sliderValue,
                });
              }}
              style={{ fontSize: "11.5px", padding: "6px 14px" }}
            >
              {submitted ? "✓ Applied" : `Set ${props.prefix || ""}${sliderValue}${props.suffix || ""}`}
            </Button>
          </div>
        </div>
      )}

      {/* Component 3: MultiSelectChips */}
      {component === "MultiSelectChips" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {((props.options || []) as Array<{ id: string; label: string; icon?: string }>).map((opt) => {
              const isSelected = selectedChips.has(opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={disabled || submitted}
                  onClick={() => toggleChip(opt.id)}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 20,
                    fontSize: "11.5px",
                    border: isSelected ? "1px solid var(--accent, #5b52f0)" : "1px solid var(--border)",
                    background: isSelected ? "rgba(91, 82, 240, 0.15)" : "var(--surface)",
                    color: isSelected ? "var(--accent, #5b52f0)" : "var(--text)",
                    cursor: disabled || submitted ? "default" : "pointer",
                    fontWeight: isSelected ? 600 : 400,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {opt.icon && <span>{opt.icon}</span>}
                  {opt.label}
                  {isSelected && <span style={{ fontSize: 10 }}>✓</span>}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
            <Button
              variant="primary"
              disabled={disabled || submitted || selectedChips.size === 0}
              onClick={() => {
                setSubmitted(true);
                onDispatchAction("CONFIRM_CHIP_SELECTION", {
                  selected: Array.from(selectedChips),
                  field: props.field || "selection",
                });
              }}
              style={{ fontSize: "11.5px", padding: "6px 14px" }}
            >
              {submitted ? "✓ Selected" : `Apply (${selectedChips.size} selected)`}
            </Button>
          </div>
        </div>
      )}

      {/* Component 4: DecisionTable */}
      {component === "DecisionTable" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11.5px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text3)", textAlign: "left" }}>
                  {((props.columns || []) as string[]).map((col) => (
                    <th key={col} style={{ padding: "6px 8px", fontWeight: 600 }}>{col}</th>
                  ))}
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {((props.rows || []) as Array<Record<string, any>>).map((row, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.05))" }}>
                    {((props.columns || []) as string[]).map((col) => (
                      <td key={col} style={{ padding: "6px 8px", color: "var(--text)" }}>{row[col] ?? "—"}</td>
                    ))}
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      <button
                        type="button"
                        disabled={disabled || submitted}
                        onClick={() => {
                          setSubmitted(true);
                          onDispatchAction("SELECT_TABLE_ROW", {
                            row,
                            action: row.actionId || "select",
                          });
                        }}
                        style={{
                          padding: "3px 8px",
                          borderRadius: 4,
                          fontSize: "10.5px",
                          background: "var(--accent, #5b52f0)",
                          color: "#fff",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        Choose
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Component 5: QuickActionGrid */}
      {component === "QuickActionGrid" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {((props.actions || []) as Array<{ id: string; label: string; icon?: string; desc?: string }>).map((act) => (
            <button
              key={act.id}
              type="button"
              disabled={disabled || submitted}
              onClick={() => {
                setSubmitted(true);
                onDispatchAction("TRIGGER_QUICK_ACTION", {
                  actionId: act.id,
                  label: act.label,
                });
              }}
              style={{
                padding: "10px",
                borderRadius: 8,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                textAlign: "left",
                cursor: disabled || submitted ? "default" : "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--text)" }}>
                {act.icon && <span>{act.icon}</span>}
                <span>{act.label}</span>
              </div>
              {act.desc && <span style={{ fontSize: "10.5px", color: "var(--text3)" }}>{act.desc}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Helper to parse dynamic UI blocks embedded in message content or metadata
 */
export function extractDynamicUiBlock(content: string, metadata?: Record<string, any>): DynamicUIBlock | null {
  if (metadata?.dynamic_ui && typeof metadata.dynamic_ui === "object") {
    return metadata.dynamic_ui as DynamicUIBlock;
  }

  // Detect ```dynamic_ui ... ``` in raw text
  const match = content.match(/```dynamic_ui\s*([\s\S]*?)\s*```/);
  if (match && match[1]) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && (parsed.component || parsed.type)) {
        return parsed as DynamicUIBlock;
      }
    } catch {
      // ignore JSON parse error
    }
  }

  return null;
}
