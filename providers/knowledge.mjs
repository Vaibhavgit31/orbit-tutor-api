// Verified Solaris knowledge for the answer model (migration of 26 Sep 2026).
//
// The same bank the Unity player ships (Assets/AIAdaptiveLearning/Resources/Solaris/knowledge-bank.json,
// built by Tools/Knowledge/build-bank.py and checked by the edit-mode tests) is read here, and the few
// entries closest to the learner's question are handed to the model as its primary source of facts.
// Matching follows SolarisKnowledgeBank.cs in spirit: lower-cased words, a light stem, a few synonyms,
// stop words dropped, rare words weighted up (BM25), and the world named in the question (or the one
// selected, for "it" / "this planet") favoured.
import { readFileSync, existsSync } from "node:fs";

const STOP = new Set(("a an the is are was were be been do does did can could would should will i you we me my your our us it its this that these those there here " +
  "of in on at to for from by with about into than as and or but so what whats which who whom how why when where please tell know explain describe " +
  "hey hi hello solaris orbit ok okay um uh like really just also very much some any all one thing things something anything way kind sort actually exactly " +
  "give get got have has had want wanted need let lets s t re ve ll d m again more info information fact facts question answer learn teach say said mean means am off another").split(/\s+/));

const SYNONYMS = {
  big: "large", huge: "large", giant: "large", bigger: "large", size: "large", massive: "large", biggest: "largest",
  tiny: "small", smaller: "small", little: "small",
  hot: "temperature", warm: "temperature", cold: "temperature", freezing: "temperature", temperatures: "temperature", heat: "temperature",
  far: "distance", distant: "distance", away: "distance", near: "distance", close: "distance",
  red: "red", reddish: "red", rusty: "rust", rust: "rust",
  moons: "moon", planets: "planet", stars: "star", rings: "ring", storms: "storm", days: "day", years: "year",
};

export const WORLDS = ["sun", "mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune", "moon", "pluto"];

function stem(word) {
  if (SYNONYMS[word]) return SYNONYMS[word];
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

export function tokens(text) {
  return String(text || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((word) => word && !STOP.has(word)).map(stem);
}

export function loadKnowledge(path) {
  if (!path || !existsSync(path)) return { size: 0, retrieve: () => [], version: "" };
  const file = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  const entries = Array.isArray(file.entries) ? file.entries.filter((entry) => entry && typeof entry.a === "string" && entry.a.trim()) : [];
  // One document per entry: its wordings and keywords (answers weigh less: they mention side topics).
  const docs = entries.map((entry) => {
    const counts = new Map();
    const add = (text, weight) => { for (const token of tokens(text)) counts.set(token, (counts.get(token) || 0) + weight); };
    (entry.q || []).forEach((wording) => add(wording, 1));
    (entry.kw || []).forEach((keyword) => add(keyword, 1.5));
    add(entry.a, 0.35);
    let length = 0;
    counts.forEach((value) => { length += value; });
    return { entry, counts, length };
  });
  const documentFrequency = new Map();
  docs.forEach((doc) => doc.counts.forEach((_, token) => documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1)));
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const idf = (token) => {
    const n = documentFrequency.get(token) || 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };

  // The k entries that best cover the question. selectedObject favours that world's entries when the
  // question names no world of its own ("how hot is it there?").
  function retrieve(question, { selectedObject = "", k = 4, minimumShare = 0.35 } = {}) {
    const query = [...new Set(tokens(question))];
    if (!query.length) return [];
    const named = WORLDS.filter((world) => query.includes(world));
    const focus = named.length ? named : (selectedObject && WORLDS.includes(selectedObject) ? [selectedObject] : []);
    const k1 = 1.2, b = 0.75;
    const scored = [];
    for (const doc of docs) {
      let score = 0;
      for (const token of query) {
        const tf = doc.counts.get(token);
        if (!tf) continue;
        score += idf(token) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / averageLength));
      }
      if (!score) continue;
      if (focus.length) score *= focus.includes(doc.entry.body) ? 1.35 : (named.length ? 0.6 : 0.9);
      scored.push({ doc, score });
    }
    scored.sort((left, right) => right.score - left.score);
    if (!scored.length) return [];
    const best = scored[0].score;
    const seen = new Set();
    const picked = [];
    for (const item of scored) {
      if (picked.length >= k || item.score < best * minimumShare) break;
      const answer = item.doc.entry.a.trim();
      if (seen.has(answer)) continue;
      seen.add(answer);
      picked.push({ id: item.doc.entry.id, body: item.doc.entry.body, question: (item.doc.entry.q || [""])[0], answer, score: Math.round(item.score * 100) / 100 });
    }
    return picked;
  }

  return { size: entries.length, retrieve, version: String(file.version || "") };
}
