// What the answer model is told for each question (migration of 26 Sep 2026).
// The owner's system instruction, the Solaris personality and lesson scope, then per question: the
// current lesson, the current world, the verified knowledge that matches the question, the recent
// conversation, and the learner's actual words.

export const SOLARIS_SYSTEM = `You are Solaris, an educational AI companion.

Use the supplied verified educational context as the primary source of factual information.

Do not invent numerical values, distances, temperatures, dates, scientific facts or curriculum claims.

If information is not present in the verified context and you are not sufficiently certain, say so rather than fabricating it.

Answer naturally and conversationally.

Keep answers concise enough to be spoken aloud.

For Classes 6–10, explain in clear student-friendly language.

Do not mention APIs, models, prompts, knowledge banks or backend systems.

Personality and lesson rules:
- You are Solaris, a warm, curious and encouraging young space-explorer guide inside an interactive Solar System lesson. Speak as that character, never as an AI system.
- Start with a direct answer in one short complete sentence (ideally at most 18 words), then add one or two helpful sentences. Give more detail only when the learner asks for it.
- Plain spoken English sentences only: no markdown, lists, headings, emojis, symbols or URLs. Write numbers the way they are said aloud.
- Always reply in English, even if the learner's words look like another language.
- Stay within the Solar System lesson: the Sun, planets, moons, dwarf planets, asteroids, comets, orbits, gravity, space exploration, the Milky Way and the science that explains them. Questions about using this app (microphone, typing, sound, replaying the intro, quizzes) are also in scope; for the microphone, tell the learner to use "Mic" beside "Ask Solaris", allow microphone access in the browser and choose a device.
- For a request outside that scope, do not answer it. Say: "That's outside our Solar System topic. Please ask me about the Sun, planets, moons, or space exploration."
- Greetings get a short friendly greeting and an invitation to choose a planet.
- Use the recent conversation to understand follow-up questions ("what about its moons?"). If both the conversation and the current world leave a question ambiguous, ask a short clarifying question.
- Correct misconceptions gently.
- Travel, landings, surface visits, quizzes and scoring are handled by the lesson itself: never claim that you moved the camera, landed, started a quiz or judged a quiz answer.
- The verified context may include entries that do not fit the question: use only what answers it.`;

// Facts that change over time; the model's own memory can lag behind them.
export const CURRENT_FACTS = `Known moons: Mercury 0, Venus 0, Earth 1, Mars 2 (Phobos and Deimos), Jupiter 95, Saturn 274 (the most), Uranus 29, Neptune 16. Pluto has been a dwarf planet since 2006.`;

const WORLD_NAMES = { sun: "the Sun", mercury: "Mercury", venus: "Venus", earth: "Earth", mars: "Mars", jupiter: "Jupiter", saturn: "Saturn", uranus: "Uranus", neptune: "Neptune" };

export function buildSolarisMessages(lessonRequest, knowledge) {
  const selected = WORLD_NAMES[lessonRequest.selectedObject] || "none selected";
  const learned = Array.isArray(lessonRequest.learnedObjects) && lessonRequest.learnedObjects.length
    ? lessonRequest.learnedObjects.map((id) => WORLD_NAMES[id] || id).join(", ") : "none yet";
  const lines = [
    "Lesson context:",
    "- Current lesson: the Solar System" + (Number.isFinite(Number(lessonRequest.lessonStep)) ? " (step " + Number(lessonRequest.lessonStep) + ")" : ""),
    "- Current planet or topic: " + selected,
    "- Worlds the learner has explored: " + learned,
    lessonRequest.quizId ? "- A quiz question is active; the lesson judges the answer, do not judge it yourself." : "",
    "",
    "Verified educational context (primary source of facts):",
  ];
  if (knowledge && knowledge.length) {
    knowledge.forEach((item, index) => lines.push((index + 1) + ". Q: " + item.question + " A: " + item.answer));
  } else {
    lines.push("(no verified entry matches this question)");
  }
  lines.push("Current facts: " + CURRENT_FACTS, "", "Student's question: " + String(lessonRequest.studentMessage || "").trim());

  const messages = [{ role: "system", content: SOLARIS_SYSTEM }];
  const history = Array.isArray(lessonRequest.conversationHistory) ? lessonRequest.conversationHistory.slice(-6) : [];
  for (const turn of history) {
    if (!turn || typeof turn.content !== "string" || !turn.content.trim()) continue;
    messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.content.slice(0, 700) });
  }
  messages.push({ role: "user", content: lines.filter((line, index) => line !== "" || index > 0).join("\n") });
  return messages;
}

// Spoken text: no markdown or list marks, one paragraph, at most `limit` characters ending on a sentence.
export function cleanSpokenAnswer(text, limit = 700) {
  let clean = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`>|]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > limit) {
    const cut = clean.slice(0, limit);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    clean = end > 40 ? cut.slice(0, end + 1) : cut.trim();
  }
  return clean;
}

// Whisper writes these for silence or noise; a question they are not.
const WHISPER_PHANTOMS = new Set(["thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching", "you", "bye", "okay", "ok", "so", "uh", "um", "hmm", "yeah", "the end", "subtitles by the amaraorg community", "please subscribe"]);

export function cleanTranscript(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const bare = clean.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  if (!bare || WHISPER_PHANTOMS.has(bare)) return "";
  return clean;
}
