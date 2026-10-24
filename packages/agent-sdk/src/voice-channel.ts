/** Restricted telephony response data. Transport renders XML and owns callback URLs.
 * Send JSON.stringify(response) through ctx.channel.reply from a phone channel handler.
 * No planner, credentials, arbitrary TwiML or outbound dial authority is implied. */
export type VoiceChannelAction =
 | {type:'say';text:string}
 | {type:'gather';text:string;digits:number}
 | {type:'hangup'};
export interface VoiceChannelResponse {actions:VoiceChannelAction[]}
export interface VoiceChannelEventPayload {
 voice_event:'call.received'|'call.digits';
 caller:string;
 digits?:string;
}
