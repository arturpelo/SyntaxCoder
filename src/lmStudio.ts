import { randomUUID } from "crypto";
import * as http from "http";
import * as https from "https";
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

// Tokeny jednego zapytania: prompt = cała wysłana rozmowa, completion = odpowiedź modelu.
export interface Usage {
  prompt: number;
  completion: number;
}

interface StreamAcc {
  content: string;
  reasoning: string;
  tools: Map<number, { id: string; name: string; arguments: string }>;
}

// fetch w Node chowa prawdziwy powód (np. certyfikat, ECONNREFUSED, zamknięte gniazdo) w err.cause.
function reason(err: unknown): string {
  const cause = (err as { cause?: { message?: string } }).cause?.message;
  return cause || (err instanceof Error ? err.message : String(err));
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
    throw new Error(t("netError", url, reason(err)));
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(t("authFailed", res.status));
  }
  return res;
}

// POST ze strumieniem przez http/https, nie fetch: fetch w Node zrywa odpowiedź po 5 minutach bez danych
// („terminated”), a LM Studio nic nie wysyła, dopóki nie przetworzy całego promptu. Przy długiej rozmowie
// trwa to dłużej, więc limitu ciszy tu nie ma; przerwać może tylko Stop.
function postStream(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).request(
      url,
      { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, signal },
      resolve
    );
    req.on("error", (err) => reject(signal.aborted ? err : new Error(t("netError", url, reason(err)))));
    req.end(body);
  });
}

async function readText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
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

// Pusty syntaxcoder.model = pierwszy model z serwera. Pamiętamy go chwilę, żeby podpowiedzi
// nie pytały serwera o listę modeli przy każdej przerwie w pisaniu.
const FIRST_MODEL_TTL_MS = 60_000;
let firstModel: { id: string; baseUrl: string; at: number } | undefined;

export async function resolveModel(): Promise<string> {
  const cfg = getConfig();
  if (cfg.model) {
    return cfg.model;
  }
  if (firstModel && firstModel.baseUrl === cfg.baseUrl && Date.now() - firstModel.at < FIRST_MODEL_TTL_MS) {
    return firstModel.id;
  }
  const models = await listModels();
  if (!models.length) {
    throw new Error(t("noModelLoaded"));
  }
  firstModel = { id: models[0], baseUrl: cfg.baseUrl, at: Date.now() };
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

// Rozmiar kontekstu załadowanego modelu z natywnego API LM Studio (/api/v0); inny serwer = brak danych.
export async function contextLength(model: string): Promise<number | undefined> {
  const { baseUrl, apiKey } = getConfig();
  try {
    const res = await fetch(baseUrl.replace(/\/v1$/, "/api/v0/models"), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { data?: { id: string; loaded_context_length?: number; max_context_length?: number }[] };
    const m = data.data?.find((d) => d.id === model);
    return m?.loaded_context_length ?? m?.max_context_length;
  } catch {
    return undefined;
  }
}

// Strumień SSE z LM Studio: każde zdarzenie danych jako obiekt JSON.
// break u wywołującego zamyka strumień, a z nim połączenie, więc serwer przestaje generować.
async function* sseEvents(body: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  try {
    yield* parseSse(body);
  } catch (err) {
    if (signal.aborted) {
      throw err;
    }
    // Zerwanie w połowie odpowiedzi z powodem zamiast samego „terminated”.
    throw new Error(t("streamBroken", reason(err)));
  }
}

async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
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
      yield json;
    }
  }
}

const firstChoice = (ev: Record<string, unknown>) => (ev.choices as Record<string, unknown>[] | undefined)?.[0];

// Surowe dokończenie tekstu (/v1/completions), bez szablonu czatu; dla podpowiedzi w edytorze.
// Strumień kończy się wcześniej, gdy done(tekst) zwróci true. truncated: model doszedł do limitu tokenów.
export async function complete(opts: {
  model: string;
  prompt: string;
  stop: string[];
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
  done: (text: string) => boolean;
}): Promise<{ text: string; truncated: boolean }> {
  const cfg = getConfig();
  const res = await request(`${cfg.baseUrl}/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      prompt: opts.prompt,
      stop: opts.stop,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`LM Studio ${res.status}: ${text || res.statusText}`);
  }
  let text = "";
  let truncated = false;
  for await (const ev of sseEvents(res.body, opts.signal)) {
    const choice = firstChoice(ev);
    if (!choice) {
      continue;
    }
    if (typeof choice.text === "string") {
      text += choice.text;
    }
    truncated = choice.finish_reason === "length";
    if (opts.done(text)) {
      break;
    }
  }
  return { text, truncated };
}

export async function streamChat(opts: {
  messages: ChatMessage[];
  tools: ToolDef[];
  signal: AbortSignal;
  onDelta: (ev: StreamEvent) => void;
}): Promise<{ message: ChatMessage; finishReason: string | null; usage?: Usage }> {
  const cfg = getConfig();
  const model = await resolveModel();
  const res = await postStream(
    `${cfg.baseUrl}/chat/completions`,
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    JSON.stringify({
      model,
      messages: opts.messages,
      // Tura bez narzędzi (np. namysł agenta): pusta lista potrafi zmylić serwer, więc jej nie wysyłamy.
      ...(opts.tools.length ? { tools: opts.tools } : {}),
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: true,
      // Ostatnie zdarzenie niesie liczbę tokenów (licznik kontekstu w czacie).
      stream_options: { include_usage: true },
    }),
    opts.signal
  );

  const status = res.statusCode ?? 0;
  if (status === 401 || status === 403) {
    res.resume();
    throw new Error(t("authFailed", status));
  }
  if (status < 200 || status >= 300) {
    const text = await readText(res).catch(() => "");
    throw new Error(`LM Studio ${status}: ${text || res.statusMessage}`);
  }

  const acc: StreamAcc = { content: "", reasoning: "", tools: new Map() };
  let finishReason: string | null = null;
  let usage: Usage | undefined;

  for await (const ev of sseEvents(res, opts.signal)) {
    const u = ev.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (typeof u?.prompt_tokens === "number") {
      usage = { prompt: u.prompt_tokens, completion: u.completion_tokens ?? 0 };
    }
    const choice = firstChoice(ev);
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

  return { message, finishReason, usage };
}
