export interface DynamicUiWidget {
  type: "dynamic_ui";
  component: "BookingSlotPicker" | "DecisionTable" | "ActionCard" | "StatusMeter";
  props: Record<string, any>; // Schema-compliant properties
  callbackId: string;        // Used to route UI interactions back to the Agent
}

export interface UiActionEvent {
  type: "mcp.ui_action";
  callbackId: string;
  action: string;
  data: any;
}
