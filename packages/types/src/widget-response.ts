export interface WidgetResponsePayload {
  widgetId: string;
  widgetType: string; // e.g. "BookingSlotPicker", "BudgetSlider", "OptionSelector"
  action: string;     // e.g. "SLOT_SELECTED", "BUDGET_SUBMITTED", "APPROVED"
  payload: Record<string, any>;
  timestamp?: string;
}

export interface WidgetResponseApiResponse {
  ok: boolean;
  sessionId: string;
  widgetId: string;
  status: "queued" | "processing";
  message: string;
}
