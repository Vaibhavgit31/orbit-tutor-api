// Groq API client for Solaris (migration of 26 Sep 2026, Docs/GROQ_MIGRATION.md).
//
// The key lives only here, on the server (GROQ_API_KEY). Every call has a hard timeout, retries only
// what can pass (408, 429, 5xx, network, timeout), at most `maxRetries` times with a short backoff,
// honours Groq's retry-after on 429, and never retries once any answer text has been streamed.
//
//   const groq = createGroqClient({ apiKey, log });
//   await groq.transcribe({ audio, mimeType, prompt })                    -> { text, ms, attempts }
//   await groq.chatStream({ messages, onDelta, firstTokenMs, totalMs })   -> { text, firstTokenMs, totalMs, attempts, truncated }
//   await groq.chat({ messages, json })                                   -> { text, ms, attempts }
//   await groq.speech({ text, voice })                                    -> { audio: Buffer, contentType }

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export class GroqError extends Error {
  constructor(message, { status = 0, kind = "error", retryable = false, retryAfterMs = 0, body = "" } = {}) {
    super(message);
    this.name = "GroqError";
    this.status = status;          // HTTP status, 0 for network / timeout
    this.kind = kind;              // "http" | "network" | "timeout" | "first-token-timeout" | "aborted"
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterFrom(response) {
  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGroqClient({
  apiKey,
  baseUrl = GROQ_BASE_URL,
  log = () => {},
  fetchImpl = globalThis.fetch,
  maxRetries = 1,
  backoffMs = 400,
} = {}) {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");
  const authHeaders = () => ({ Authorization: "Bearer " + apiKey });

  // One HTTP attempt with its own timer. Resolves with the Response (status not checked here).
  async function attempt(path, init, timeoutMs, parentSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onParentAbort = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    try {
      const response = await fetchImpl(baseUrl + path, { ...init, signal: controller.signal });
      return { response, controller, timer, cleanup: () => { clearTimeout(timer); if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort); } };
    } catch (error) {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
      if (parentSignal && parentSignal.aborted) throw new GroqError("Request cancelled.", { kind: "aborted" });
      if (timedOut) throw new GroqError("Groq did not answer within " + timeoutMs + " ms.", { kind: "timeout", retryable: true });
      throw new GroqError("Network error: " + (error && error.message ? error.message : error), { kind: "network", retryable: true });
    }
  }

  async function httpError(response) {
    const body = await response.text().catch(() => "");
    let message = "HTTP " + response.status;
    try { const parsed = JSON.parse(body); if (parsed && parsed.error && parsed.error.message) message += ": " + parsed.error.message; } catch (e) {}
    return new GroqError(message, { status: response.status, kind: "http", retryable: isRetryableStatus(response.status), retryAfterMs: response.status === 429 ? retryAfterFrom(response) : 0, body: body.slice(0, 500) });
  }

  // Runs `once(attemptNumber, remainingMs)` with the retry policy, inside an overall deadline.
  async function withRetries(label, deadlineAt, once) {
    let lastError = null;
    for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber++) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 250) break;
      try {
        return await once(attemptNumber, remaining);
      } catch (error) {
        lastError = error instanceof GroqError ? error : new GroqError(String(error && error.message || error));
        if (lastError.kind === "aborted" || lastError.noRetry) throw lastError;
        const canRetry = lastError.retryable && attemptNumber <= maxRetries;
        let wait = Math.round(backoffMs * Math.pow(2, attemptNumber - 1) * (0.8 + Math.random() * 0.4));
        if (lastError.status === 429 && lastError.retryAfterMs) wait = Math.max(wait, lastError.retryAfterMs);
        const left = deadlineAt - Date.now();
        log("warn", label, { event: "attempt-failed", attempt: attemptNumber, status: lastError.status, kind: lastError.kind, error: lastError.message, retry: canRetry && wait < left - 500 ? wait : false });
        if (!canRetry || wait >= left - 500) break;   // a retry that cannot finish in time is not made
        await sleep(wait);
      }
    }
    throw lastError || new GroqError(label + " ran out of time.", { kind: "timeout" });
  }

  // ------------------------------------------------------------------ speech to text
  async function transcribe({ audio, mimeType = "audio/webm", model = "whisper-large-v3", prompt = "", language = "en", timeoutMs = 8000, budgetMs = 10000, signal } = {}) {
    const startedAt = Date.now();
    const deadlineAt = startedAt + budgetMs;
    const extension = /mp4|m4a|aac/.test(mimeType) ? "m4a" : /mpeg|mp3/.test(mimeType) ? "mp3" : /ogg/.test(mimeType) ? "ogg" : /wav/.test(mimeType) ? "wav" : /flac/.test(mimeType) ? "flac" : "webm";
    let attempts = 0;
    const text = await withRetries("STT", deadlineAt, async (attemptNumber, remaining) => {
      attempts = attemptNumber;
      const form = new FormData();
      form.append("file", new Blob([audio], { type: mimeType }), "question." + extension);
      form.append("model", model);
      form.append("language", language);
      form.append("temperature", "0");
      form.append("response_format", "json");
      if (prompt) form.append("prompt", prompt);
      const { response, cleanup } = await attempt("/audio/transcriptions", { method: "POST", headers: authHeaders(), body: form }, Math.min(timeoutMs, remaining), signal);
      try {
        if (!response.ok) throw await httpError(response);
        const body = await response.json();
        return typeof body.text === "string" ? body.text : "";
      } finally { cleanup(); }
    });
    return { text, ms: Date.now() - startedAt, attempts };
  }

  // ------------------------------------------------------------------ chat, streamed
  // onDelta(text) receives answer text as it arrives. A first-token timeout ends the attempt (and is
  // retried if time allows); the total timeout ends the answer where it is (truncated: true) once some
  // text has been given, or fails when none was.
  async function chatStream({
    messages, model = "openai/gpt-oss-120b", reasoningEffort = "low", temperature = 0.5, maxTokens = 700,
    firstTokenMs = 8000, totalMs = 15000, onDelta = () => {}, signal,
  } = {}) {
    const startedAt = Date.now();
    const deadlineAt = startedAt + totalMs;
    let text = "";
    let firstTokenAt = 0;
    let attempts = 0;
    let truncated = false;
    let finishReason = "";
    await withRetries("LLM", deadlineAt, async (attemptNumber, remaining) => {
      attempts = attemptNumber;
      const body = {
        model, messages, stream: true, temperature, max_completion_tokens: maxTokens,
        reasoning_effort: reasoningEffort, include_reasoning: false,
      };
      const attemptStartedAt = Date.now();
      const { response, controller, cleanup } = await attempt("/chat/completions", {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body),
      }, remaining, signal);
      let firstTimer = null;
      let firstTimedOut = false;
      try {
        if (!response.ok) throw await httpError(response);
        if (!response.body) throw new GroqError("Groq sent no stream.", { kind: "http", retryable: true });
        const firstBudget = Math.min(firstTokenMs, remaining);
        firstTimer = setTimeout(() => { if (!firstTokenAt) { firstTimedOut = true; controller.abort(); } }, Math.max(0, firstBudget - (Date.now() - attemptStartedAt)));
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let done = false;
        while (!done) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (firstTimedOut) throw new GroqError("No answer text within " + firstTokenMs + " ms.", { kind: "first-token-timeout", retryable: true });
            if (signal && signal.aborted) throw new GroqError("Request cancelled.", { kind: "aborted" });
            if (text) { truncated = true; done = true; break; }   // the total timeout (or a cut) after some text: keep it
            throw new GroqError("Groq stream ended: " + (error && error.message ? error.message : error), { kind: Date.now() >= deadlineAt - 50 ? "timeout" : "network", retryable: true });
          }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") { done = true; break; }
            let event;
            try { event = JSON.parse(data); } catch (e) { continue; }
            if (event.error) throw new GroqError("Groq stream error: " + (event.error.message || "unknown"), { kind: "http", status: 500, retryable: !text });
            const choice = event.choices && event.choices[0];
            const piece = choice && choice.delta && typeof choice.delta.content === "string" ? choice.delta.content : "";
            if (choice && choice.finish_reason) finishReason = choice.finish_reason;
            if (piece) {
              if (!firstTokenAt) firstTokenAt = Date.now();
              text += piece;
              onDelta(piece);
            }
          }
        }
        if (!text) throw new GroqError("Groq answered with no text (" + (finishReason || "empty") + ").", { kind: "http", status: 502, retryable: true });
      } catch (error) {
        // Once any text reached the learner, a retry would repeat it: the error ends the answer instead.
        if (text) { truncated = true; return; }
        throw error;
      } finally {
        clearTimeout(firstTimer);
        cleanup();
      }
    });
    if (finishReason === "length") truncated = true;
    return { text, firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : -1, totalMs: Date.now() - startedAt, attempts, truncated, model };
  }

  // ------------------------------------------------------------------ chat, whole answer
  async function chat({ messages, model = "openai/gpt-oss-120b", reasoningEffort = "low", temperature = 0.4, maxTokens = 900, json = false, timeoutMs = 15000, signal } = {}) {
    const startedAt = Date.now();
    let attempts = 0;
    const text = await withRetries("LLM", startedAt + timeoutMs, async (attemptNumber, remaining) => {
      attempts = attemptNumber;
      const body = { model, messages, temperature, max_completion_tokens: maxTokens, reasoning_effort: reasoningEffort, include_reasoning: false };
      if (json) body.response_format = { type: "json_object" };
      const { response, cleanup } = await attempt("/chat/completions", { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) }, remaining, signal);
      try {
        if (!response.ok) throw await httpError(response);
        const payload = await response.json();
        const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message ? payload.choices[0].message.content : "";
        if (!content) throw new GroqError("Groq answered with no text.", { kind: "http", status: 502, retryable: true });
        return content;
      } finally { cleanup(); }
    });
    return { text, ms: Date.now() - startedAt, attempts, model };
  }

  // ------------------------------------------------------------------ text to speech (optional, Orpheus)
  async function speech({ text, model = "canopylabs/orpheus-v1-english", voice = "hannah", format = "wav", timeoutMs = 10000, signal } = {}) {
    const startedAt = Date.now();
    let attempts = 0;
    const audio = await withRetries("TTS", startedAt + timeoutMs, async (attemptNumber, remaining) => {
      attempts = attemptNumber;
      const { response, cleanup } = await attempt("/audio/speech", {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text, voice, response_format: format }),
      }, remaining, signal);
      try {
        if (!response.ok) throw await httpError(response);
        return Buffer.from(await response.arrayBuffer());
      } finally { cleanup(); }
    });
    return { audio, contentType: format === "mp3" ? "audio/mpeg" : "audio/wav", ms: Date.now() - startedAt, attempts };
  }

  return { transcribe, chatStream, chat, speech };
}
