import { randomUUID } from "crypto";
import { getConfig } from "./config";
import { t } from "./i18n";

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamEvent {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  finishReason?: string | null;
}

interface StreamAcc {
  content: string;
  reasoning: string;
  tools: Map<number, { id: string; name: string; arguments: string }>;
}

// Jedno miejsce na błędy sieci i autoryzacji: proxy, certyfikaty, zły token.
async function request(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted && !(err instanceof Error && err.name === "TimeoutError")) {
      throw err;
    }
    // fetch w Node chowa prawdziwy powód (np. certyfikat, ECONNREFUSED) w err.cause.
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw new Error(t("netError", url, cause || (err instanceof Error ? err.message : String(err))));
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(t("authFailed", res.status));
  }
  return res;
}

export async function listModels(): Promise<string[]> {
  const { baseUrl, apiKey } = getConfig();
  const res = await request(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  // Reverse proxy potrafi oddać 200 ze stroną HTML; liczy się tylko odpowiedź w formacie API.
  const data = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null;
  if (!Array.isArray(data?.data)) {
    throw new Error(t("badResponse", res.status));
  }
  return data.data.map((m) => m.id);
}

export async function resolveModel(): Promise<string> {
  const cfg = getConfig();
  if (cfg.model) {
    return cfg.model;
  }
  const models = await listModels();
  if (!models.length) {
    throw new Error(t("noModelLoaded"));
  }
  return models[0];
}

// Serwer działa, ale nie ma wybranego modelu: da się wybrać inny.
export class ModelMissingError extends Error {}

// Status „połączono” tylko po prawdziwej odpowiedzi serwera, nigdy z samych ustawień.
export async function checkServer(): Promise<string> {
  const models = await listModels();
  const { model } = getConfig();
  if (model && !models.includes(model)) {
    throw new ModelMissingError(t("modelMissing", model));
  }
  if (!models.length) {
    throw new Error(t("noModelLoaded"));
  }
  return model || models[0];
}

export async function streamChat(opts: {
  messages: ChatMessage[];
  tools: ToolDef[];
  signal: AbortSignal;
  onDelta: (ev: StreamEvent) => void;
}): Promise<{ message: ChatMessage; finishReason: string | null }> {
  const cfg = getConfig();
  const model = await resolveModel();
  const res = await request(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: opts.messages,
      tools: opts.tools,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`LM Studio ${res.status}: ${text || res.statusText}`);
  }

  const acc: StreamAcc = { content: "", reasoning: "", tools: new Map() };
  let finishReason: string | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0];
      if (!choice) {
        continue;
      }
      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
      if (typeof delta.content === "string" && delta.content) {
        acc.content += delta.content;
        opts.onDelta({ content: delta.content });
      }
      const reasoning =
        (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
        (typeof delta.reasoning === "string" && delta.reasoning) ||
        "";
      if (reasoning) {
        acc.reasoning += reasoning;
        opts.onDelta({ reasoning });
      }
      const tcs = delta.tool_calls as
        | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const idx = tc.index ?? 0;
          const prev = acc.tools.get(idx) ?? { id: "", name: "", arguments: "" };
          if (tc.id) {
            prev.id = tc.id;
          }
          if (tc.function?.name) {
            prev.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            prev.arguments += tc.function.arguments;
          }
          acc.tools.set(idx, prev);
        }
      }
    }
  }

  const toolCalls: ToolCall[] = [...acc.tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      // Część serwerów nie podaje id; unikalne id trzyma karty narzędzi w UI osobno.
      id: t.id || `call_${randomUUID()}`,
      type: "function" as const,
      function: { name: t.name, arguments: t.arguments || "{}" },
    }));

  const message: ChatMessage = {
    role: "assistant",
    content: acc.content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };

  return { message, finishReason };
}
