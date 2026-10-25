/** Restricted telephony response data. Transport renders XML and owns callback URLs.
 * This is a transport contract for extension handlers, not a customer-agent runtime.
 * No credentials, arbitrary TwiML, or outbound dial authority is implied. */
export type VoiceChannelAction =
 | {type:'say';text:string}
 | {type:'gather';text:string;input?:'dtmf'|'speech'|'dtmf speech';digits?:number}
 | {type:'hangup'};
export interface VoiceChannelResponse {actions:VoiceChannelAction[]}
export interface VoiceChannelEventPayload {
 voice_event:'call.received'|'call.digits'|'call.speech'|'message.received';
 caller:string;
 digits?:string;
 speech?:string;
 text?:string;
 confidence?:number;
}
