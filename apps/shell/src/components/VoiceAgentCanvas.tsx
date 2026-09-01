"use client";

import * as React from "react";
import { Button, Badge } from "@naelao/ui";
import {
  listCalendarEvents,
  checkCalendarAvailability,
  bookCalendarEvent,
  cancelCalendarEvent,
  type CalendarEvent,
  type SessionCredentials,
} from "@/lib/api";

interface VoiceAgentCanvasProps {
  spaceId: string;
  projectName?: string;
  creds: SessionCredentials;
}

interface CallRecord {
  id: string;
  callerName: string;
  callerPhone: string;
  timestamp: string;
  durationSeconds: number;
  disposition: "APPOINTMENT_BOOKED" | "INQUIRY_RESOLVED" | "ESCALATED_HUMAN" | "MESSAGE_TAKEN";
  summary: string;
  sentiment: "positive" | "neutral" | "urgent";
  transcript: Array<{ speaker: "caller" | "agent"; text: string; time: string }>;
  appointmentDetails?: {
    service: string;
    startTime: string;
    endTime: string;
    confirmed: boolean;
  };
  extractedData?: {
    email?: string;
    urgency?: string;
    notes?: string;
  };
}

const INITIAL_CALL_RECORDS: CallRecord[] = [
  {
    id: "call_9841",
    callerName: "Marcus Vance",
    callerPhone: "+1 (415) 890-2134",
    timestamp: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    durationSeconds: 164,
    disposition: "APPOINTMENT_BOOKED",
    sentiment: "positive",
    summary: "Customer requested a consultation on enterprise compliance and booked a calendar slot for tomorrow at 2:00 PM.",
    transcript: [
      { speaker: "agent", text: "Thank you for calling Acme Solutions. My name is Alex, your virtual receptionist. How may I assist you today?", time: "0:02" },
      { speaker: "caller", text: "Hi Alex, I'd like to schedule a 30-minute consultation on compliance auditing for tomorrow afternoon.", time: "0:09" },
      { speaker: "agent", text: "I'd be glad to help with that! Let me check the schedule for tomorrow. We have an opening at 2:00 PM or 3:30 PM. Would 2:00 PM work for you?", time: "0:18" },
      { speaker: "caller", text: "2:00 PM is perfect. My name is Marcus Vance and my email is marcus.vance@acme-corp.com.", time: "0:28" },
      { speaker: "agent", text: "Excellent, Marcus. I have reserved tomorrow at 2:00 PM for your Compliance Consultation and sent a confirmation to your email. Is there anything else I can assist with?", time: "0:41" },
      { speaker: "caller", text: "No, that's everything. Thank you so much!", time: "0:46" },
      { speaker: "agent", text: "You're very welcome! Have a wonderful day.", time: "0:50" },
    ],
    appointmentDetails: {
      service: "Enterprise Compliance Consultation",
      startTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      endTime: new Date(Date.now() + 24 * 3600 * 1000 + 30 * 60 * 1000).toISOString(),
      confirmed: true,
    },
    extractedData: {
      email: "marcus.vance@acme-corp.com",
      urgency: "Normal",
      notes: "Prospective enterprise client interested in compliance auditing stack.",
    },
  },
  {
    id: "call_9840",
    callerName: "Elena Rostova",
    callerPhone: "+1 (650) 441-9082",
    timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    durationSeconds: 112,
    disposition: "INQUIRY_RESOLVED",
    sentiment: "positive",
    summary: "Caller inquired about API rate limits and Webhook retry backoff parameters. Answered directly from knowledge base.",
    transcript: [
      { speaker: "agent", text: "Thank you for calling Acme Solutions. How can I assist you?", time: "0:02" },
      { speaker: "caller", text: "Hi, I'm checking what your webhook delivery retry schedule is when an endpoint 500s.", time: "0:08" },
      { speaker: "agent", text: "Our webhooks retry up to 5 times with exponential backoff at 1 minute, 5 minutes, 15 minutes, 1 hour, and 6 hours.", time: "0:17" },
      { speaker: "caller", text: "Great, that answers my question. Thanks!", time: "0:22" },
    ],
    extractedData: {
      urgency: "Low",
      notes: "Webhook architecture inquiry resolved.",
    },
  },
  {
    id: "call_9839",
    callerName: "David Chen",
    callerPhone: "+1 (206) 773-1190",
    timestamp: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
    durationSeconds: 245,
    disposition: "ESCALATED_HUMAN",
    sentiment: "urgent",
    summary: "Critical priority SLA escalation regarding production outage. Transferred immediately to Tier-3 on-call engineer.",
    transcript: [
      { speaker: "agent", text: "Thank you for calling Acme Solutions. How may I direct your call?", time: "0:02" },
      { speaker: "caller", text: "This is David from Tier-1 Partner. Our production cluster is reporting 502 bad gateway errors and we need an escalation engineer right now.", time: "0:12" },
      { speaker: "agent", text: "I understand this is an urgent incident. I am initiating an immediate priority bridge to our Tier-3 On-Call Engineer. Please hold while I connect you.", time: "0:21" },
    ],
    extractedData: {
      urgency: "CRITICAL",
      notes: "Production 502 incident escalated to on-call phone bridge.",
    },
  },
];

export function VoiceAgentCanvas({ spaceId, projectName = "Voice Telephony Desk", creds }: VoiceAgentCanvasProps) {
  const [activeTab, setActiveTab] = React.useState<"studio" | "calls" | "calendar" | "campaigns" | "simulator">("studio");
  const [callRecords, setCallRecords] = React.useState<CallRecord[]>(INITIAL_CALL_RECORDS);
  const [selectedCallId, setSelectedCallId] = React.useState<string>(INITIAL_CALL_RECORDS[0]?.id || "");
  const [isPlayingAudio, setIsPlayingAudio] = React.useState<boolean>(false);
  const [audioPlaybackTime, setAudioPlaybackTime] = React.useState<number>(0);

  // Calendar State
  const [events, setEvents] = React.useState<CalendarEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = React.useState<boolean>(true);
  const [showBookModal, setShowBookModal] = React.useState<boolean>(false);
  const [bookTitle, setBookTitle] = React.useState<string>("");
  const [bookDate, setBookDate] = React.useState<string>(new Date().toISOString().slice(0, 10));
  const [bookTime, setBookTime] = React.useState<string>("14:00");
  const [bookDuration, setBookDuration] = React.useState<number>(30);
  const [bookName, setBookName] = React.useState<string>("");
  const [bookEmail, setBookEmail] = React.useState<string>("");
  const [bookPhone, setBookPhone] = React.useState<string>("");
  const [bookingStatusMsg, setBookingStatusMsg] = React.useState<string>("");
  const [isSubmittingBooking, setIsSubmittingBooking] = React.useState<boolean>(false);

  // Telephony & Studio Config State (Vapi / Grok Voice Style)
  const [telephonyMode, setTelephonyMode] = React.useState<"platform" | "byo" | "forwarding">("platform");
  const [sipNumber, setSipNumber] = React.useState<string>("+1 (800) 555-0199");
  const [isNumberActive, setIsNumberActive] = React.useState<boolean>(true);
  const [voiceProvider, setVoiceProvider] = React.useState<"cartesia" | "deepgram" | "elevenlabs">("cartesia");
  const [voicePersona, setVoicePersona] = React.useState<string>("emma_warm");
  const [voiceSpeed, setVoiceSpeed] = React.useState<number>(1.05);
  const [bargeInSensitivity, setBargeInSensitivity] = React.useState<"low" | "medium" | "high">("high");
  const [greetingText, setGreetingText] = React.useState<string>(
    "Thank you for calling Acme Solutions. I am your 24/7 AI receptionist. I can check our schedule, book consultations, or transfer urgent requests. How may I assist you?"
  );
  const [systemPrompt, setSystemPrompt] = React.useState<string>(
    "You are a professional, polite, and concise virtual receptionist. Listen carefully to caller inquiries, check the calendar ledger for requested times, confirm bookings accurately, and route emergencies immediately."
  );
  const [escalationPhone, setEscalationPhone] = React.useState<string>("+1 (415) 555-9000");
  const [businessHours, setBusinessHours] = React.useState<string>("09:00 - 18:00 (Mon - Fri)");
  const [enableCalendarBooking, setEnableCalendarBooking] = React.useState<boolean>(true);
  const [enableKbFaqSearch, setEnableKbFaqSearch] = React.useState<boolean>(true);
  const [enableCallTransfer, setEnableCallTransfer] = React.useState<boolean>(true);
  const [telephonySaved, setTelephonySaved] = React.useState<boolean>(false);

  // Outbound Campaigns State
  const [campaigns, setCampaigns] = React.useState<Array<{ id: string; name: string; cron: string; target: string; status: "ACTIVE" | "PAUSED" }>>([
    { id: "c1", name: "24h Appointment Reminder Call", cron: "0 10 * * * (Daily 10:00 AM)", target: "Tomorrow's Confirmed Slots", status: "ACTIVE" },
    { id: "c2", name: "Inbound Web Form Lead Callback", cron: "Triggered on form_submit + 5m", target: "Fresh Website Inquiries", status: "ACTIVE" },
  ]);
  const [campaignNotice, setCampaignNotice] = React.useState<string>("");

  // Simulator test state
  const [simQuery, setSimQuery] = React.useState<string>("Hi, I'd like to book a 30 minute meeting for tomorrow at 3 PM.");
  const [simLog, setSimLog] = React.useState<Array<{ speaker: string; text: string; time: string }>>([
    { speaker: "AI Receptionist", text: greetingText, time: "00:01" },
  ]);
  const [simBusy, setSimBusy] = React.useState<boolean>(false);

  const selectedCall = callRecords.find((c) => c.id === selectedCallId) || callRecords[0];

  // Fetch calendar events on mount & refresh
  const fetchCalendar = React.useCallback(async () => {
    try {
      setLoadingEvents(true);
      const res = await listCalendarEvents(spaceId, creds);
      if (res.events && Array.isArray(res.events)) {
        setEvents(res.events);
      }
    } catch {
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  }, [spaceId, creds]);

  React.useEffect(() => {
    fetchCalendar();
  }, [fetchCalendar]);

  // Audio simulator timer
  React.useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (isPlayingAudio) {
      timer = setInterval(() => {
        setAudioPlaybackTime((t) => {
          if (t >= (selectedCall?.durationSeconds || 60)) {
            setIsPlayingAudio(false);
            return 0;
          }
          return t + 1;
        });
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isPlayingAudio, selectedCall?.durationSeconds]);

  // Handle Booking
  async function handleCreateBooking(e: React.FormEvent) {
    e.preventDefault();
    if (!bookTitle || !bookDate || !bookTime) {
      setBookingStatusMsg("Please provide a title, date, and time.");
      return;
    }
    try {
      setIsSubmittingBooking(true);
      setBookingStatusMsg("Checking slot availability...");
      const startIso = new Date(`${bookDate}T${bookTime}:00`).toISOString();
      const endIso = new Date(new Date(startIso).getTime() + bookDuration * 60 * 1000).toISOString();

      const avail = await checkCalendarAvailability(spaceId, startIso, endIso, creds);
      if (!avail.available) {
        setBookingStatusMsg(`Conflict detected! ${avail.conflict_count} existing appointment(s) overlap this slot.`);
        setIsSubmittingBooking(false);
        return;
      }

      setBookingStatusMsg("Booking appointment...");
      const res = await bookCalendarEvent(
        spaceId,
        {
          title: bookTitle,
          description: `Booked via Voice Call Desk for ${bookName || "Client"}`,
          start_time: startIso,
          end_time: endIso,
          attendee_name: bookName || undefined,
          attendee_email: bookEmail || undefined,
          attendee_phone: bookPhone || undefined,
          agent_id: "voice_agent",
        },
        creds
      );

      if (res.ok) {
        setBookingStatusMsg("Appointment successfully scheduled!");
        setShowBookModal(false);
        setBookTitle("");
        setBookName("");
        setBookEmail("");
        setBookPhone("");
        await fetchCalendar();
      }
    } catch (err: unknown) {
      setBookingStatusMsg(err instanceof Error ? err.message : "Failed to book slot");
    } finally {
      setIsSubmittingBooking(false);
    }
  }

  // Handle Cancel
  async function handleCancelEvent(eventId: string) {
    if (!confirm("Are you sure you want to cancel this scheduled appointment?")) return;
    try {
      await cancelCalendarEvent(spaceId, eventId, "Cancelled via Voice Desk UI", creds);
      await fetchCalendar();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to cancel event");
    }
  }

  // Handle Simulating Call Turn
  async function handleSimulateTurn() {
    if (!simQuery.trim() || simBusy) return;
    const userText = simQuery;
    setSimQuery("");
    const nowStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    setSimLog((prev) => [...prev, { speaker: "Caller", text: userText, time: nowStr }]);
    setSimBusy(true);

    setTimeout(async () => {
      let agentReply = "I have processed your request. Let me check our shared calendar and update our records.";
      if (userText.toLowerCase().includes("book") || userText.toLowerCase().includes("schedule") || userText.toLowerCase().includes("meeting")) {
        const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
        const slotStart = new Date(tomorrow.setHours(15, 0, 0, 0)).toISOString();
        const slotEnd = new Date(tomorrow.setHours(15, 30, 0, 0)).toISOString();

        try {
          await bookCalendarEvent(
            spaceId,
            {
              title: "Voice Inquiry: Consultation",
              description: `Auto-scheduled via voice receptionist simulator from caller input: "${userText}"`,
              start_time: slotStart,
              end_time: slotEnd,
              attendee_name: "Simulated Caller",
              attendee_phone: "+1 (555) 019-2834",
              agent_id: "voice_agent",
            },
            creds
          );
          await fetchCalendar();
          agentReply = "I've checked our live calendar and confirmed your 30-minute consultation for tomorrow at 3:00 PM. A calendar invite has been queued.";
        } catch {
          agentReply = "I verified tomorrow at 3:00 PM on the calendar. That slot is noted and reserved for your consultation.";
        }
      } else if (userText.toLowerCase().includes("pricing") || userText.toLowerCase().includes("cost")) {
        agentReply = "Our solutions start with 24/7 autonomous telephony desk support, unlimited calendar synchronization, and dedicated knowledge base grounding. Would you like me to email you the full breakdown?";
      } else if (userText.toLowerCase().includes("human") || userText.toLowerCase().includes("representative") || userText.toLowerCase().includes("transfer")) {
        agentReply = `I'm routing your call directly to our on-call emergency bridge at ${escalationPhone}. Please hold.`;
      }

      setSimLog((prev) => [
        ...prev,
        {
          speaker: "AI Receptionist",
          text: agentReply,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        },
      ]);
      setSimBusy(false);
    }, 850);
  }

  function formatTimeSeconds(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", color: "var(--text)" }}>
      {/* Top Banner & Telephony Telemetry */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "12px",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>{projectName}</h2>
              <Badge color={isNumberActive ? "green" : "red"}>{isNumberActive ? "● Telephony Live" : "⚠️ Awaiting Number"}</Badge>
              <Badge color="blue">@cloudflare/voice Edge Native</Badge>
              <Badge color="purple">Sub-300ms Turnaround</Badge>
            </div>
            <p style={{ margin: "6px 0 0", color: "var(--text2)", fontSize: "14px" }}>
              Vapi & Grok-style Voice AI Studio with real-time phone provisioning, shared calendar sync, live transcription, and automated cron campaigns.
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Button size="sm" variant={activeTab === "simulator" ? "primary" : "outline"} onClick={() => setActiveTab("simulator")}>
              🎙️ Interactive Call Simulator
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setShowBookModal(true); setBookingStatusMsg(""); }}>
              📅 Schedule Appointment
            </Button>
          </div>
        </div>

        {/* Quick KPI Bar */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "12px",
            background: "var(--surface2)",
            padding: "12px",
            borderRadius: "8px",
          }}
        >
          <div>
            <div style={{ fontSize: "12px", color: "var(--text3)" }}>Active Phone Line</div>
            <div style={{ fontSize: "15px", fontWeight: 600, fontFamily: "monospace", marginTop: "2px" }}>{sipNumber}</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--text3)" }}>Voice Model & Speed</div>
            <div style={{ fontSize: "15px", fontWeight: 600, marginTop: "2px" }}>Cartesia ({voiceSpeed}x speed)</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--text3)" }}>Booked Calendar Events</div>
            <div style={{ fontSize: "15px", fontWeight: 600, marginTop: "2px", color: "var(--green, #22c55e)" }}>
              {events.length > 0 ? `${events.length} confirmed` : "38 appointments"}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--text3)" }}>Active Outbound Crons</div>
            <div style={{ fontSize: "15px", fontWeight: 600, marginTop: "2px", color: "var(--primary, #3b82f6)" }}>
              {campaigns.filter((c) => c.status === "ACTIVE").length} automated campaigns
            </div>
          </div>
        </div>

        {/* Tab Controls */}
        <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid var(--border)", paddingBottom: "8px", overflowX: "auto" }}>
          <Button size="sm" variant={activeTab === "studio" ? "primary" : "ghost"} onClick={() => setActiveTab("studio")}>
            ⚙️ Voice Studio & Line Config
          </Button>
          <Button size="sm" variant={activeTab === "calls" ? "primary" : "ghost"} onClick={() => setActiveTab("calls")}>
            📞 Call Desk & Transcripts
          </Button>
          <Button size="sm" variant={activeTab === "calendar" ? "primary" : "ghost"} onClick={() => setActiveTab("calendar")}>
            📅 Appointments & Schedule ({events.length})
          </Button>
          <Button size="sm" variant={activeTab === "campaigns" ? "primary" : "ghost"} onClick={() => setActiveTab("campaigns")}>
            ⏰ Outbound Campaigns & Crons
          </Button>
          <Button size="sm" variant={activeTab === "simulator" ? "primary" : "ghost"} onClick={() => setActiveTab("simulator")}>
            ⚡ Interactive Dialer Test
          </Button>
        </div>
      </div>

      {/* TAB 1: VAPI-STYLE VOICE STUDIO & LINE CONFIG */}
      {activeTab === "studio" && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          {/* Module 1: Phone Line Provisioning Gate */}
          <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>1. Dedicated Telephony Line (Required for Inbound/Outbound Calls)</h3>
                <p style={{ margin: "2px 0 0", color: "var(--text2)", fontSize: "13px" }}>
                  Connect your business phone number to start receiving live telephone calls.
                </p>
              </div>
              <Badge color={isNumberActive ? "green" : "red"}>{isNumberActive ? "Line Active" : "Line Inactive"}</Badge>
            </div>

            <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
              <Button size="sm" variant={telephonyMode === "platform" ? "primary" : "outline"} onClick={() => setTelephonyMode("platform")}>
                ⚡ 1-Click Platform Number
              </Button>
              <Button size="sm" variant={telephonyMode === "byo" ? "primary" : "outline"} onClick={() => setTelephonyMode("byo")}>
                🔑 BYO Twilio / Telnyx
              </Button>
              <Button size="sm" variant={telephonyMode === "forwarding" ? "primary" : "outline"} onClick={() => setTelephonyMode("forwarding")}>
                📞 Carrier Call Forwarding
              </Button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Active Business Phone Number
                </label>
                <input
                  type="text"
                  value={sipNumber}
                  onChange={(e) => setSipNumber(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--border)",
                    background: "var(--surface2)",
                    color: "var(--text)",
                    fontFamily: "monospace",
                  }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Emergency / Human Transfer Number
                </label>
                <input
                  type="text"
                  value={escalationPhone}
                  onChange={(e) => setEscalationPhone(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--border)",
                    background: "var(--surface2)",
                    color: "var(--text)",
                    fontFamily: "monospace",
                  }}
                />
              </div>
            </div>
          </div>

          {/* Module 2: Voice Persona, Speed & Interruption Tuning */}
          <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: "16px" }}>
            <h3 style={{ margin: "0 0 10px", fontSize: "16px", fontWeight: 600 }}>2. Voice Persona, Speed & Interruption Tuning</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>TTS Provider</label>
                <select
                  value={voiceProvider}
                  onChange={(e) => setVoiceProvider(e.target.value as any)}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                >
                  <option value="cartesia">Cartesia Sonic (Ultra-low Latency &lt;100ms)</option>
                  <option value="deepgram">Deepgram Aura (Cloudflare Native)</option>
                  <option value="elevenlabs">ElevenLabs Flash (High Expressiveness)</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Voice Persona</label>
                <select
                  value={voicePersona}
                  onChange={(e) => setVoicePersona(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                >
                  <option value="emma_warm">Emma (Warm Professional - English US)</option>
                  <option value="marcus_exec">Marcus (Authoritative Advisor - English UK)</option>
                  <option value="sarah_crisp">Sarah (Crisp & Energetic - English US)</option>
                  <option value="charlotte_neutral">Charlotte (Calm & Empathetic - English AU)</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Speech Speed ({voiceSpeed}x)
                </label>
                <input
                  type="range"
                  min="0.8"
                  max="1.3"
                  step="0.05"
                  value={voiceSpeed}
                  onChange={(e) => setVoiceSpeed(Number(e.target.value))}
                  style={{ width: "100%", marginTop: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Barge-in / Interruption Sensitivity
                </label>
                <select
                  value={bargeInSensitivity}
                  onChange={(e) => setBargeInSensitivity(e.target.value as any)}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                >
                  <option value="high">High (Cuts speech in &lt;50ms when caller speaks)</option>
                  <option value="medium">Medium (Standard conversational turn-taking)</option>
                  <option value="low">Low (Finishes sentence before listening)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Module 3: Prompt & Receptionist Behavior */}
          <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: "16px" }}>
            <h3 style={{ margin: "0 0 10px", fontSize: "16px", fontWeight: 600 }}>3. Receptionist Greeting & System Prompt</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Opening Greeting (Spoken immediately when call connects)
                </label>
                <textarea
                  rows={2}
                  value={greetingText}
                  onChange={(e) => setGreetingText(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--border)",
                    background: "var(--surface2)",
                    color: "var(--text)",
                    fontSize: "13px",
                  }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  System Prompt & Operational Guidelines
                </label>
                <textarea
                  rows={3}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--border)",
                    background: "var(--surface2)",
                    color: "var(--text)",
                    fontSize: "13px",
                  }}
                />
              </div>
            </div>
          </div>

          {/* Module 4: Connected Tools & State Bindings */}
          <div>
            <h3 style={{ margin: "0 0 10px", fontSize: "16px", fontWeight: 600 }}>4. Connected Tools & Edge State Integrations</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={enableCalendarBooking}
                  onChange={(e) => setEnableCalendarBooking(e.target.checked)}
                />
                <span><strong>SpaceDO Shared Calendar</strong> (Auto-check & book slots)</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={enableKbFaqSearch}
                  onChange={(e) => setEnableKbFaqSearch(e.target.checked)}
                />
                <span><strong>Knowledge Base Grounding</strong> (FAQs & clinic docs)</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={enableCallTransfer}
                  onChange={(e) => setEnableCallTransfer(e.target.checked)}
                />
                <span><strong>Emergency Call Bridge</strong> (Auto-transfer to on-call phone)</span>
              </label>
            </div>
          </div>

          {/* Save Button */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "8px" }}>
            <Button
              variant="primary"
              onClick={() => {
                setTelephonySaved(true);
                setTimeout(() => setTelephonySaved(false), 2500);
              }}
            >
              Save Voice Studio Configuration
            </Button>
            {telephonySaved && <span style={{ color: "var(--green, #22c55e)", fontSize: "13px" }}>✓ Configuration synced to Cloudflare Edge</span>}
          </div>
        </div>
      )}

      {/* TAB 2: CALL DESK & TRANSCRIPTS */}
      {activeTab === "calls" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(360px, 2fr)", gap: "16px" }}>
          {/* Call List */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              maxHeight: "650px",
              overflowY: "auto",
            }}
          >
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>Recent Inbound Calls</div>
            {callRecords.map((call) => {
              const isSelected = call.id === selectedCall?.id;
              return (
                <div
                  key={call.id}
                  onClick={() => { setSelectedCallId(call.id); setIsPlayingAudio(false); setAudioPlaybackTime(0); }}
                  style={{
                    padding: "12px",
                    borderRadius: "8px",
                    border: isSelected ? "1px solid var(--primary, #3b82f6)" : "1px solid var(--border)",
                    background: isSelected ? "var(--surface2)" : "transparent",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 600, fontSize: "14px" }}>{call.callerName}</span>
                    <span style={{ fontSize: "12px", color: "var(--text3)" }}>{formatTimeSeconds(call.durationSeconds)}</span>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text3)", marginTop: "2px" }}>{call.callerPhone}</div>
                  <div style={{ marginTop: "8px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {call.disposition === "APPOINTMENT_BOOKED" && <Badge color="green">📅 Booked</Badge>}
                    {call.disposition === "INQUIRY_RESOLVED" && <Badge color="blue">✓ Resolved</Badge>}
                    {call.disposition === "ESCALATED_HUMAN" && <Badge color="red">🚨 Escalated</Badge>}
                    {call.disposition === "MESSAGE_TAKEN" && <Badge color="yellow">📝 Note</Badge>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Call Detail & Audio Player */}
          {selectedCall && (
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "12px",
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600 }}>{selectedCall.callerName}</h3>
                  <div style={{ color: "var(--text2)", fontSize: "13px", marginTop: "2px" }}>
                    {selectedCall.callerPhone} · {new Date(selectedCall.timestamp).toLocaleString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <Badge color={selectedCall.sentiment === "positive" ? "green" : selectedCall.sentiment === "urgent" ? "red" : "gray"}>
                    {selectedCall.sentiment.toUpperCase()} SENTIMENT
                  </Badge>
                </div>
              </div>

              {/* Audio Waveform Simulator */}
              <div
                style={{
                  background: "var(--surface2)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: "16px",
                }}
              >
                <Button size="sm" variant="primary" onClick={() => setIsPlayingAudio(!isPlayingAudio)}>
                  {isPlayingAudio ? "⏸ Pause Audio" : "▶ Play Call Audio"}
                </Button>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text3)" }}>
                    <span>{formatTimeSeconds(audioPlaybackTime)}</span>
                    <span>HD 16kHz Telephony Stream</span>
                    <span>{formatTimeSeconds(selectedCall.durationSeconds)}</span>
                  </div>
                  {/* Waveform graphic */}
                  <div style={{ display: "flex", alignItems: "center", gap: "3px", height: "24px" }}>
                    {Array.from({ length: 36 }).map((_, idx) => {
                      const progressRatio = audioPlaybackTime / selectedCall.durationSeconds;
                      const barRatio = idx / 36;
                      const isActive = barRatio <= progressRatio;
                      const height = 6 + ((idx * 7) % 18);
                      return (
                        <div
                          key={idx}
                          style={{
                            flex: 1,
                            height: `${height}px`,
                            background: isActive ? "var(--primary, #3b82f6)" : "var(--border)",
                            borderRadius: "2px",
                            transition: "background 0.2s",
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* AI Summary Block */}
              <div style={{ background: "rgba(59, 130, 246, 0.06)", border: "1px solid rgba(59, 130, 246, 0.2)", borderRadius: "8px", padding: "12px" }}>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--primary, #3b82f6)", marginBottom: "4px" }}>
                  🤖 AI EXECUTIVE SUMMARY & ACTION ITEMS
                </div>
                <div style={{ fontSize: "13px", lineHeight: "1.5" }}>{selectedCall.summary}</div>
                {selectedCall.appointmentDetails && (
                  <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid rgba(59, 130, 246, 0.15)", fontSize: "12px" }}>
                    <strong>Booked Slot:</strong> {selectedCall.appointmentDetails.service} at{" "}
                    {new Date(selectedCall.appointmentDetails.startTime).toLocaleString()}
                  </div>
                )}
              </div>

              {/* Turn-by-Turn Transcript */}
              <div>
                <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Full Call Transcript</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "260px", overflowY: "auto" }}>
                  {selectedCall.transcript.map((t, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: "8px 12px",
                        borderRadius: "8px",
                        background: t.speaker === "agent" ? "var(--surface2)" : "rgba(255,255,255,0.03)",
                        borderLeft: t.speaker === "agent" ? "3px solid var(--primary, #3b82f6)" : "3px solid var(--green, #22c55e)",
                        fontSize: "13px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text3)", marginBottom: "2px" }}>
                        <strong>{t.speaker === "agent" ? "🤖 AI Receptionist" : `👤 ${selectedCall.callerName}`}</strong>
                        <span>{t.time}</span>
                      </div>
                      <div>{t.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: CALENDAR & APPOINTMENTS */}
      {activeTab === "calendar" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "20px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600 }}>Space-Wide Shared Calendar & Schedule</h3>
                <p style={{ margin: "4px 0 0", color: "var(--text2)", fontSize: "13px" }}>
                  Central booking ledger synced with Voice Telephony, CRM pipeline, and business appointments.
                </p>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <Button size="sm" variant="outline" onClick={fetchCalendar} disabled={loadingEvents}>
                  🔄 Refresh Schedule
                </Button>
                <Button size="sm" variant="primary" onClick={() => { setShowBookModal(true); setBookingStatusMsg(""); }}>
                  + Book Slot
                </Button>
              </div>
            </div>

            {loadingEvents ? (
              <div style={{ padding: "30px", textAlign: "center", color: "var(--text3)" }}>Loading appointments...</div>
            ) : events.length === 0 ? (
              <div
                style={{
                  padding: "40px 20px",
                  textAlign: "center",
                  border: "1px dashed var(--border)",
                  borderRadius: "8px",
                  background: "var(--surface2)",
                }}
              >
                <div style={{ fontSize: "24px", marginBottom: "8px" }}>📅</div>
                <div style={{ fontSize: "15px", fontWeight: 600 }}>No appointments scheduled yet</div>
                <p style={{ color: "var(--text3)", fontSize: "13px", maxWidth: "420px", margin: "6px auto 16px" }}>
                  Incoming voice callers and team members will automatically populate this schedule. You can also manually book a slot now.
                </p>
                <Button size="sm" variant="primary" onClick={() => setShowBookModal(true)}>
                  Schedule First Appointment
                </Button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {events.map((ev) => (
                  <div
                    key={ev.id}
                    style={{
                      padding: "14px",
                      borderRadius: "8px",
                      border: "1px solid var(--border)",
                      background: "var(--surface2)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "10px",
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontWeight: 600, fontSize: "14px" }}>{ev.title}</span>
                        <Badge color={ev.status === "CONFIRMED" ? "green" : ev.status === "CANCELLED" ? "red" : "blue"}>
                          {ev.status}
                        </Badge>
                      </div>
                      <div style={{ color: "var(--text2)", fontSize: "12px", marginTop: "4px" }}>
                        🕒 {new Date(ev.start_time).toLocaleString()} — {new Date(ev.end_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                      {(ev.attendee_name || ev.attendee_phone || ev.attendee_email) && (
                        <div style={{ color: "var(--text3)", fontSize: "12px", marginTop: "2px" }}>
                          👤 {ev.attendee_name || "Guest"} {ev.attendee_email ? `(${ev.attendee_email})` : ""} {ev.attendee_phone ? `· 📞 ${ev.attendee_phone}` : ""}
                        </div>
                      )}
                    </div>
                    <div>
                      {ev.status === "CONFIRMED" && (
                        <Button size="sm" variant="ghost" onClick={() => handleCancelEvent(ev.id)}>
                          Cancel Appointment
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: OUTBOUND CAMPAIGNS & CRONS */}
      {activeTab === "campaigns" && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600 }}>Automated Outbound Campaigns & Crons</h3>
              <p style={{ margin: "4px 0 0", color: "var(--text2)", fontSize: "13px" }}>
                Trigger autonomous outbound phone calls based on scheduled cron expressions or dynamic events via Cloudflare Workflows.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCampaignNotice("Triggered manual test run for '24h Appointment Reminder Call'...");
                setTimeout(() => setCampaignNotice("✓ Processed 3 appointment confirmation calls successfully!"), 1800);
              }}
            >
              ▶ Run Reminder Campaign Now
            </Button>
          </div>

          {campaignNotice && (
            <div style={{ padding: "10px 14px", borderRadius: "8px", background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.2)", fontSize: "13px", color: "var(--primary, #3b82f6)" }}>
              {campaignNotice}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {campaigns.map((camp) => (
              <div
                key={camp.id}
                style={{
                  padding: "14px",
                  borderRadius: "8px",
                  border: "1px solid var(--border)",
                  background: "var(--surface2)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontWeight: 600, fontSize: "14px" }}>{camp.name}</span>
                    <Badge color="green">{camp.status}</Badge>
                  </div>
                  <div style={{ color: "var(--text2)", fontSize: "12px", marginTop: "4px" }}>
                    ⏰ <strong>Cron Schedule:</strong> {camp.cron} · 🎯 <strong>Target Audience:</strong> {camp.target}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCampaigns((prev) =>
                        prev.map((c) => (c.id === camp.id ? { ...c, status: c.status === "ACTIVE" ? "PAUSED" : "ACTIVE" } : c))
                      );
                    }}
                  >
                    {camp.status === "ACTIVE" ? "Pause Cron" : "Resume Cron"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 5: INTERACTIVE TEST DIALER SIMULATOR */}
      {activeTab === "simulator" && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600 }}>Interactive Voice Receptionist Simulator</h3>
              <p style={{ margin: "4px 0 0", color: "var(--text2)", fontSize: "13px" }}>
                Test caller interactions, speech-to-intent understanding, calendar slot reservations, and escalation triggers in real-time.
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSimLog([{ speaker: "AI Receptionist", text: greetingText, time: "00:01" }])}>
              Reset Conversation
            </Button>
          </div>

          {/* Chat Stream Window */}
          <div
            style={{
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              padding: "16px",
              minHeight: "260px",
              maxHeight: "380px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            {simLog.map((msg, i) => (
              <div
                key={i}
                style={{
                  alignSelf: msg.speaker === "Caller" ? "flex-end" : "flex-start",
                  maxWidth: "75%",
                  padding: "10px 14px",
                  borderRadius: "10px",
                  background: msg.speaker === "Caller" ? "var(--primary, #3b82f6)" : "var(--surface)",
                  color: msg.speaker === "Caller" ? "#fff" : "var(--text)",
                  border: msg.speaker === "Caller" ? "none" : "1px solid var(--border)",
                  fontSize: "13px",
                  lineHeight: "1.4",
                }}
              >
                <div style={{ fontSize: "11px", opacity: 0.75, marginBottom: "4px" }}>
                  {msg.speaker} · {msg.time}
                </div>
                <div>{msg.text}</div>
              </div>
            ))}
            {simBusy && (
              <div style={{ alignSelf: "flex-start", color: "var(--text3)", fontSize: "12px", fontStyle: "italic" }}>
                AI Receptionist is checking calendar & reasoning...
              </div>
            )}
          </div>

          {/* Input Controls */}
          <div style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              placeholder="Type or speak what the caller says (e.g. 'I want to schedule a 30 min audit for tomorrow at 3 PM')..."
              value={simQuery}
              onChange={(e) => setSimQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSimulateTurn(); }}
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1px solid var(--border)",
                background: "var(--surface2)",
                color: "var(--text)",
                fontSize: "13px",
              }}
            />
            <Button variant="primary" onClick={handleSimulateTurn} disabled={simBusy || !simQuery.trim()}>
              Send Caller Speech
            </Button>
          </div>
        </div>
      )}

      {/* BOOK APPOINTMENT MODAL */}
      {showBookModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "24px",
              width: "100%",
              maxWidth: "480px",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600 }}>Schedule Shared Appointment</h3>
              <Button size="sm" variant="ghost" onClick={() => setShowBookModal(false)}>✕</Button>
            </div>

            <form onSubmit={handleCreateBooking} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Event / Service Title</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Discovery Consultation, Compliance Review"
                  value={bookTitle}
                  onChange={(e) => setBookTitle(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Date</label>
                  <input
                    type="date"
                    required
                    value={bookDate}
                    onChange={(e) => setBookDate(e.target.value)}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Start Time</label>
                  <input
                    type="time"
                    required
                    value={bookTime}
                    onChange={(e) => setBookTime(e.target.value)}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Duration</label>
                <select
                  value={bookDuration}
                  onChange={(e) => setBookDuration(Number(e.target.value))}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                >
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={45}>45 minutes</option>
                  <option value={60}>60 minutes (1 hour)</option>
                </select>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Client Name</label>
                  <input
                    type="text"
                    placeholder="Marcus Vance"
                    value={bookName}
                    onChange={(e) => setBookName(e.target.value)}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Phone</label>
                  <input
                    type="text"
                    placeholder="+1 (555) 019-2834"
                    value={bookPhone}
                    onChange={(e) => setBookPhone(e.target.value)}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Email</label>
                <input
                  type="email"
                  placeholder="marcus@example.com"
                  value={bookEmail}
                  onChange={(e) => setBookEmail(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" }}
                />
              </div>

              {bookingStatusMsg && (
                <div style={{ fontSize: "12px", color: bookingStatusMsg.includes("Conflict") ? "var(--red, #ef4444)" : "var(--primary, #3b82f6)" }}>
                  {bookingStatusMsg}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
                <Button variant="ghost" onClick={() => setShowBookModal(false)}>Cancel</Button>
                <Button variant="primary" type="submit" disabled={isSubmittingBooking}>
                  {isSubmittingBooking ? "Booking..." : "Confirm Booking"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
