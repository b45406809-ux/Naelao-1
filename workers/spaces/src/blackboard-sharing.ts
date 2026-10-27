/** Standing grants cover only text already shared by the project. */
export function standingBlackboardPeer(input: { action:string; projectId:string; summary:string; params:Record<string,unknown>; request?:{source_project_id:string;target_project_id:string} | null }): {peer:string;actionKey:string} | null {
  const {action,projectId,summary,params,request}=input;
  if (typeof params.id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(params.id)) return null;
  if (action === "blackboard.request") {
    if (typeof params.target_project_id !== "string" || params.objective !== summary || params.expected_result !== "Review the shared project summary and provide a response.") return null;
    return {peer:params.target_project_id,actionKey:`request:${params.id}`};
  }
  if (action !== "blackboard.respond" || !request || !["accept","decline","complete","cancel"].includes(String(params.action)) || (params.response !== undefined && params.response !== summary)) return null;
  if (projectId === request.source_project_id && params.action === "cancel") return {peer:request.target_project_id,actionKey:`response:${params.id}:cancel`};
  if (projectId === request.target_project_id && ["accept","decline","complete"].includes(String(params.action))) return {peer:request.source_project_id,actionKey:`response:${params.id}:${params.action}`};
  return null;
}
