export type EventType = 
  | 'MESSAGE_SENT'
  | 'TASK_UPDATED'
  | 'AGENT_STATUS_CHANGED'
  | 'AUTOMATION_INCIDENT_REPORTED';

export interface BaseEvent {
  type: EventType;
  timestamp: number;
  payload?: any;
}

export interface AutomationIncidentEvent extends BaseEvent {
  type: 'AUTOMATION_INCIDENT_REPORTED';
  payload: {
    jobId: string;
    projectId: string;
    failureKind: "STALL" | "OOM" | "RATE_LIMIT" | "CRASH" | "UNAUTH";
    message: string;
    remedy: "AUTO_RETRY" | "MANUAL_REVIEW";
  };
}
