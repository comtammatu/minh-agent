export interface OperatorFlattenResponse {
  ok: true;
  cancelled: number;
  closed: number;
}

export interface OperatorPauseResponse {
  ok: true;
  paused: true;
  reason: string;
}

export interface OperatorResumeResponse {
  ok: true;
  resumed: true;
}

export interface OperatorErrorResponse {
  error: string;
  code?: string;
}

async function postJson<T>(
  url: string,
  body?: unknown,
): Promise<T | OperatorErrorResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json()) as T | OperatorErrorResponse;
  if (!response.ok) {
    return payload as OperatorErrorResponse;
  }
  return payload;
}

export async function flattenAll(reason = "dashboard flatten") {
  return postJson<OperatorFlattenResponse>("/api/operator/flatten", {
    confirm: true,
    reason,
  });
}

export async function pauseAgent(reason = "dashboard pause") {
  return postJson<OperatorPauseResponse>("/api/operator/pause", {
    confirm: true,
    reason,
  });
}

export async function resumeAgent() {
  return postJson<OperatorResumeResponse>("/api/operator/resume");
}

export function isOperatorError(
  result: unknown,
): result is OperatorErrorResponse {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof (result as OperatorErrorResponse).error === "string"
  );
}
