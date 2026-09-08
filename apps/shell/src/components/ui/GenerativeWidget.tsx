import React, { useState } from "react";
import type { DynamicUiWidget } from "@avos/types";

interface GenerativeWidgetProps {
  widget: DynamicUiWidget;
}

export function GenerativeWidget({ widget }: GenerativeWidgetProps) {
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const onAction = (action: string, data: any) => {
    setLoading(true);
    setStatusMessage("Sending action...");
    // Emit MCP-UI event to parent chat session or window/websocket
    window.postMessage(
      {
        type: "mcp.ui_action",
        callbackId: widget.callbackId,
        action,
        data,
      },
      "*"
    );

    // Also dispatch custom event for direct local container listeners if needed
    window.dispatchEvent(
      new CustomEvent("mcp:ui_action", {
        detail: { callbackId: widget.callbackId, action, data },
      })
    );

    setTimeout(() => {
      setLoading(false);
      setStatusMessage(`Action '${action}' submitted successfully.`);
    }, 600);
  };

  switch (widget.component) {
    case "BookingSlotPicker": {
      const slots = widget.props.slots || ["09:00 AM", "11:30 AM", "02:00 PM", "04:30 PM"];
      const title = widget.props.title || "Select a Booking Slot";
      return (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 shadow-sm my-2 max-w-md">
          <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">{title}</h4>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {slots.map((slot: string) => (
              <button
                key={slot}
                disabled={loading}
                onClick={() => onAction("SELECT_SLOT", { slot })}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 transition-colors disabled:opacity-50"
              >
                {slot}
              </button>
            ))}
          </div>
          {statusMessage && <p className="text-xs text-emerald-600 dark:text-emerald-400">{statusMessage}</p>}
        </div>
      );
    }
    case "ActionCard": {
      const title = widget.props.title || "Confirm Action";
      const description = widget.props.description || "Please review and confirm your choice.";
      const confirmText = widget.props.confirmText || "Confirm";
      return (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 shadow-sm my-2 max-w-md">
          <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">{title}</h4>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-3">{description}</p>
          <div className="flex items-center gap-2">
            <button
              disabled={loading}
              onClick={() => onAction("CONFIRM", widget.props)}
              className="px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {confirmText}
            </button>
            <button
              disabled={loading}
              onClick={() => onAction("CANCEL", widget.props)}
              className="px-4 py-2 text-xs font-medium border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
          {statusMessage && <p className="text-xs mt-2 text-emerald-600 dark:text-emerald-400">{statusMessage}</p>}
        </div>
      );
    }
    case "DecisionTable": {
      const options = widget.props.options || [{ id: "opt1", label: "Option A" }, { id: "opt2", label: "Option B" }];
      return (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 shadow-sm my-2 max-w-md">
          <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Decision Required</h4>
          <div className="space-y-2 mb-3">
            {options.map((opt: any) => (
              <div key={opt.id} className="flex items-center justify-between p-2 border border-zinc-200 dark:border-zinc-800 rounded-lg">
                <span className="text-xs text-zinc-800 dark:text-zinc-200">{opt.label}</span>
                <button
                  disabled={loading}
                  onClick={() => onAction("SELECT_OPTION", { optionId: opt.id })}
                  className="px-2.5 py-1 text-xs bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:opacity-90 disabled:opacity-50"
                >
                  Select
                </button>
              </div>
            ))}
          </div>
          {statusMessage && <p className="text-xs text-emerald-600 dark:text-emerald-400">{statusMessage}</p>}
        </div>
      );
    }
    case "StatusMeter": {
      const value = widget.props.value ?? 50;
      const label = widget.props.label || "Status Progress";
      return (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 shadow-sm my-2 max-w-md">
          <div className="flex justify-between items-center mb-1">
            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{label}</span>
            <span className="text-xs text-zinc-500">{value}%</span>
          </div>
          <div className="w-full bg-zinc-200 dark:bg-zinc-800 h-2 rounded-full overflow-hidden">
            <div className="bg-blue-600 h-full transition-all duration-300" style={{ width: `${value}%` }} />
          </div>
        </div>
      );
    }
    default:
      return (
        <div className="p-3 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg text-xs text-zinc-500">
          Unknown UI Widget: {widget.component}
        </div>
      );
  }
}
