// Solaris's voice on Groq Orpheus (canopylabs/orpheus-v1-english), migration step 2, 26 Sep 2026.
//
// Orpheus reads at most 200 characters per request and answers WAV only, so a line is cleaned, cut
// into pieces of at most 190 characters at sentence, then clause, then word boundaries, the pieces
// are read in parallel and their audio is joined into one WAV.
//
// A voice that cannot answer must never hold Solaris up: the page speaks any line the server refuses
// with the browser's own voice. So after a refusal that will repeat (terms not accepted, key not
// allowed, rate limit, several failures in a row) the voice pauses and every line is refused at once
// until the pause ends, instead of each sentence waiting for its own timeout.
//
//   const voice = createGroqVoice({ groq, model, voice: "hannah", log });
//   const result = await voice.speak(text, { timeoutMs });   // { wav, pieces, ms } or throws VoiceUnavailable
export const ORPHEUS_MAX_CHARS = 190;   // Groq's limit is 200; a margin for the cleaning below
export const ORPHEUS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"];

export class VoiceUnavailable extends Error {
  constructor(message, { reason = "error", pausedMs = 0, status = 0 } = {}) {
    super(message);
    this.name = "VoiceUnavailable";
    this.reason = reason;       // "paused" | "terms" | "auth" | "rate-limit" | "timeout" | "error"
    this.pausedMs = pausedMs;   // how long the voice refuses lines from now
    this.status = status;
  }
}

// Text Orpheus should read: square brackets are its stage directions ("[whisper]") and must not come
// from an answer; markdown, links, emoji and symbols it would read out or stumble on are dropped.
export function cleanForOrpheus(text) {
  return String(text || "")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")      // markdown link: its words only
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]{0,40}\]/g, " ")                 // a stage direction ("[whisper]") is dropped, words and all
    .replace(/[\[\]{}<>]/g, " ")
    .replace(/[*_#`|~^]+/g, "")
    .replace(/&/g, " and ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Pieces of at most `max` characters, cut where a reader would pause anyway.
export function splitForOrpheus(text, max = ORPHEUS_MAX_CHARS) {
  const clean = cleanForOrpheus(text);
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const cut = (part, pattern) => part.split(pattern).map((item) => item.trim()).filter(Boolean);
  const units = [];
  for (const sentence of cut(clean, /(?<=[.!?])\s+/)) {
    if (sentence.length <= max) { units.push(sentence); continue; }
    for (const clause of cut(sentence, /(?<=[,;:—])\s+/)) {
      if (clause.length <= max) { units.push(clause); continue; }
      let line = "";
      for (const word of clause.split(" ")) {
        const candidate = line ? line + " " + word : word;
        if (candidate.length <= max) { line = candidate; continue; }
        if (line) units.push(line);
        line = word.slice(0, max);
      }
      if (line) units.push(line);
    }
  }
  // Short neighbours are read together: fewer requests, more natural phrasing.
  const pieces = [];
  for (const unit of units) {
    const last = pieces[pieces.length - 1];
    if (last && last.length + 1 + unit.length <= max) pieces[pieces.length - 1] = last + " " + unit;
    else pieces.push(unit);
  }
  return pieces;
}

// The format and the sample bytes of a PCM WAV. A streamed WAV may give its data size as 0 or
// 0xFFFFFFFF: everything after the data header is then the audio.
export function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let format = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4), bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data before its format");
      const end = size === 0 || size === 0xFFFFFFFF || body + size > buffer.length ? buffer.length : body + size;
      return { ...format, data: buffer.subarray(body, end) };
    }
    if (size === 0xFFFFFFFF) break;
    offset = body + size + (size & 1);
  }
  throw new Error("WAV without audio data");
}

// One WAV from several of the same format, with a short breath between pieces.
export function joinWavs(buffers, gapMs = 60) {
  if (buffers.length === 1) return buffers[0];
  const parts = buffers.map(parseWav);
  const first = parts[0];
  for (const part of parts) {
    if (part.audioFormat !== first.audioFormat || part.channels !== first.channels || part.sampleRate !== first.sampleRate || part.bitsPerSample !== first.bitsPerSample) {
      throw new Error("the pieces of a line came back in different audio formats");
    }
  }
  const blockAlign = first.channels * first.bitsPerSample / 8;
  const gap = Buffer.alloc(Math.round(first.sampleRate * gapMs / 1000) * blockAlign, first.bitsPerSample === 8 ? 128 : 0);
  const chunks = [];
  parts.forEach((part, index) => { if (index) chunks.push(gap); chunks.push(part.data); });
  const data = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(first.audioFormat, 20);
  header.writeUInt16LE(first.channels, 22); header.writeUInt32LE(first.sampleRate, 24);
  header.writeUInt32LE(first.sampleRate * blockAlign, 28); header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(first.bitsPerSample, 34); header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function createGroqVoice({ groq, model = "canopylabs/orpheus-v1-english", voice = "hannah", log = () => {}, maxParallel = 3, now = Date.now } = {}) {
  const state = { pausedUntil: 0, reason: "", failuresInARow: 0, active: 0, waiting: [] };

  // At most `maxParallel` Orpheus calls at once across all learners: a burst of sentences queues
  // here instead of tripping Groq's rate limit.
  const slot = () => new Promise((resolve) => {
    if (state.active < maxParallel) { state.active++; resolve(); } else state.waiting.push(resolve);
  });
  const release = () => { const next = state.waiting.shift(); if (next) next(); else state.active--; };

  function pause(ms, reason, fields = {}) {
    const until = now() + ms;
    if (until <= state.pausedUntil) return;
    state.pausedUntil = until;
    state.reason = reason;
    log("warn", "TTS", "paused", { reason, seconds: Math.round(ms / 1000), ...fields, fallback: "browser voice" });
  }

  // Why a failure will repeat, and for how long the voice should stop trying.
  function judge(error) {
    const status = error && error.status || 0;
    const body = String(error && (error.body || error.message) || "").toLowerCase();
    if (status === 400 && /terms|model_terms|accept/.test(body)) {
      pause(10 * 60000, "terms", { action: "accept the Orpheus terms once at https://console.groq.com/playground?model=" + model });
      return "terms";
    }
    if (status === 401 || status === 403) { pause(10 * 60000, "auth", { status }); return "auth"; }
    if (status === 404 || (status === 400 && /model|voice/.test(body))) { pause(10 * 60000, "model", { status, error: String(error.message || "").slice(0, 160) }); return "model"; }
    if (status === 429) { pause(Math.max(5000, Math.min(120000, error.retryAfterMs || 20000)), "rate-limit"); return "rate-limit"; }
    state.failuresInARow++;
    if (state.failuresInARow >= 3) { pause(60000, "failing", { failuresInARow: state.failuresInARow }); state.failuresInARow = 0; }
    return error && /timeout/.test(error.kind || "") ? "timeout" : "error";
  }

  async function speak(text, { timeoutMs = 10000 } = {}) {
    const startedAt = now();
    if (state.pausedUntil > startedAt) {
      throw new VoiceUnavailable("The voice is paused.", { reason: "paused", pausedMs: state.pausedUntil - startedAt });
    }
    const pieces = splitForOrpheus(text);
    if (!pieces.length) throw new VoiceUnavailable("Nothing to read.", { reason: "empty" });
    const deadline = startedAt + timeoutMs;
    const controller = new AbortController();
    try {
      const audio = await Promise.all(pieces.map(async (piece) => {
        await slot();
        try {
          const left = deadline - now();
          if (left < 500) throw Object.assign(new Error("no time left for this piece"), { kind: "timeout" });
          if (state.pausedUntil > now()) throw Object.assign(new Error("the voice paused"), { kind: "paused" });
          const result = await groq.speech({ text: piece, model, voice, format: "wav", timeoutMs: left, signal: controller.signal });
          return result.audio;
        } finally { release(); }
      }));
      const wav = joinWavs(audio);
      state.failuresInARow = 0;
      return { wav, pieces: pieces.length, ms: now() - startedAt };
    } catch (error) {
      controller.abort();   // the other pieces of this line are no longer needed
      if (error instanceof VoiceUnavailable) throw error;
      if (error && error.kind === "paused") throw new VoiceUnavailable("The voice paused.", { reason: "paused", pausedMs: Math.max(0, state.pausedUntil - now()) });
      const reason = error && error.message && /WAV|audio formats/.test(error.message) ? (state.failuresInARow++, "bad-audio") : judge(error);
      throw new VoiceUnavailable(String(error && error.message || error), { reason, status: error && error.status || 0, pausedMs: Math.max(0, state.pausedUntil - now()) });
    }
  }

  return { speak, status: () => ({ paused: state.pausedUntil > now(), reason: state.pausedUntil > now() ? state.reason : "", pausedForMs: Math.max(0, state.pausedUntil - now()) }), voice, model };
}
