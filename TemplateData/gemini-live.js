// Solaris on Gemini Live: instant voice conversation (owner, 24 Sep 2026: "our Solaris answers
// too late, I want instant"; later the same day: "make sure voice recognition works instant").
// One WebSocket carries the learner's microphone in and Solaris's voice out, with both transcripts;
// Gemini decides when the learner has finished speaking and answers about a second later (measured).
// Unity's actions (focus a planet, start the quiz...) arrive as tool calls. The Unity plug-in
// (VoiceRecognition.jslib, RealtimeVoice_*) drives this object; it keeps the old session's states and
// messages.
//
//   var live = new MetabookGeminiLive({ onState, onUserInterim, onUserFinal, onAssistantInterim,
//                                      onAssistantFinal, onToolCall, onError, fetchConfig });
//   await live.connect(config);   // from <api>/api/realtime/session
//   live.attachMicrophone(mediaStream); live.beginTurn(); ... live.endTurn();
//   live.sendText("Why is Mars red?"); live.sendContext("selected: mars; level: explorer");
//   live.sendToolResult(callId, resultObject); live.suppressResponse(); live.setVolume(0.8); live.close();
//
// The config comes from the backend with a short-lived token ({ model, voice, instructions, tools,
// realtimeInputConfig, token, tokenUses, expiresIn, words }): the page never sees the Gemini key, and
// the token only opens Solaris's own session. The owner's direct mode (service worker) hands over
// { ..., key } instead; both work. fetchConfig() is asked for fresh tokens when the current ones are
// spent (Live asks for a reconnect about every ten minutes).
//
// Words on screen while the learner speaks: the conversation model only sends its transcript after
// the turn, so the same microphone audio also goes to a transcription session (config.words) whose
// running transcript is shown until Live's own arrives.
//
// Everything browser-only (AudioContext, microphone) is optional, so the protocol half runs in
// Node for the QA harness (Tools/QA/gemini-live-test.cjs, Tools/QA/backend-test.cjs).
(function (root) {
  "use strict";
  var KEY_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  var TOKEN_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
  var INPUT_RATE = 16000;
  // A capture window with no speech closes on its own (onUserFinal("")): 5 s, so a learner whose
  // microphone gives nothing is told at once instead of watching a silent "listening" for nine seconds
  // (owner, 24 Sep 2026: "tap to speak and it took 8 s").
  var NO_SPEECH_MS = 7000;   // a child may think for a while after the tap (was 5 s)
  var MAX_TURN_MS = 20000;       // no capture window runs longer than this
  // The words session closes this long after a question (a follow-up reuses it): Live sessions are
  // counted against the key's concurrent-session allowance, so it is not kept open for the lesson.
  var WORDS_IDLE_MS = 30000;
  // Turn detection when the config does not bring its own (the backend's is the same): 350 ms of
  // silence with high end-of-speech sensitivity. The learner's words came back ~0.85 s after they
  // stopped, against ~1.2 s with the old 650 ms (measured 24 Sep 2026).
  var DEFAULT_ACTIVITY = { endOfSpeechSensitivity: "END_SENSITIVITY_HIGH", prefixPaddingMs: 80, silenceDurationMs: 600 };
  // Solaris's voice (owner, 25 Sep 2026: "still sounds glitchy, or as if from far away"). The first
  // chunk of an answer waits this long so the chunks behind it, which arrive with the network's
  // jitter, are queued before their time; the same lead starts again after a late chunk.
  var JITTER_LEAD_MS = 150;
  // Every chunk edge that is heard as an edge (start of an answer, a late chunk, a stop) ramps over
  // this long instead of cutting a wave mid-way (a click).
  var EDGE_RAMP_MS = 2.5;
  // The audio thread applies what the page schedules a few ms later (a render quantum is 5.3 ms at
  // 24 kHz, Windows pulls ~10 ms batches). A chunk due sooner than this would start late and overlap
  // the next one, so it counts as an underrun; a stop or ramp anchored sooner than this would already
  // be in the past when it is seen (an instant cut, the click again), so it starts this much later.
  var SCHEDULE_MARGIN_MS = 15;
  // The Live voice arrives at about -14.6 LUFS with peaks at full scale (measured 25 Sep 2026):
  // this much below the app's volume so the master gain and any resampling never clip.
  var HEADROOM = 0.85;

  function noop() {}
  // One turn's timings and playback health (the QA harnesses print them).
  function newStats(turnStartedAt) {
    return { turnStartedAt: turnStartedAt, firstAudioMs: -1, underruns: 0, scheduledSeconds: 0, receivedSeconds: 0 };
  }
  function base64FromBytes(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  }
  function bytesFromBase64(text) {
    if (typeof atob !== "function") return new Uint8Array(Buffer.from(text, "base64"));
    var binary = atob(text), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // The microphone's block, down to 16 kHz 16-bit. Each output sample averages the input samples it
  // covers (a simple low-pass), which the recogniser hears more cleanly than every third sample.
  function downsample(input, ratio) {
    if (ratio <= 1) ratio = 1;
    var length = Math.floor(input.length / ratio);
    var pcm = new Int16Array(length);
    for (var j = 0; j < length; j++) {
      var from = Math.floor(j * ratio), to = Math.min(input.length, Math.floor((j + 1) * ratio));
      var sum = 0;
      for (var k = from; k < to; k++) sum += input[k];
      var s = to > from ? sum / (to - from) : input[from];
      pcm[j] = s < 0 ? Math.max(-1, s) * 0x8000 : Math.min(1, s) * 0x7fff;
    }
    return pcm;
  }
  function socketUrl(credential) {
    return credential.token
      ? TOKEN_URL + "?access_token=" + encodeURIComponent(credential.token)
      : KEY_URL + "?key=" + encodeURIComponent(credential.key || "");
  }

  function GeminiLive(handlers) {
    this.h = handlers || {};
    this.ws = null;
    this.config = null;
    this.ready = false;
    this.capturing = false;
    this.userTranscript = "";
    this.userFinalSent = false;
    this.assistantTranscript = "";
    this.modelTurnActive = false;
    this.suppressed = false;
    this.volume = root.unityTutorOutputVolume == null ? 1 : root.unityTutorOutputVolume;
    this.resumeHandle = null;
    this.closedByUs = false;
    this.toolNames = {};
    this.playback = { context: null, gain: null, nextTime: 0, sources: [], last: null, chunks: 0 };
    this.audioBytesReceived = 0;
    this.timers = {};
    this.tokenUsesLeft = Infinity;
    this.tokenExpiresAt = Infinity;
    this.wordsCredential = null;
    this.words = null;
    this.wordsDone = "";
    this.wordsShown = "";
    this.wordsIgnoreUntil = 0;
    this.stats = newStats(0);
  }

  GeminiLive.prototype.emit = function (name, value) {
    var handler = this.h[name];
    if (typeof handler === "function") { try { handler(value); } catch (error) { if (root.console) console.warn("[gemini-live] " + name + " handler failed", error); } }
  };

  GeminiLive.prototype.setState = function (state) {
    if (this.state === state) return;
    this.state = state;
    this.emit("onState", state);
  };

  // ------------------------------------------------------------------ credentials
  GeminiLive.prototype.adoptConfig = function (config) {
    this.config = config || {};
    var c = this.config, now = Date.now();
    this.tokenUsesLeft = c.token ? Math.max(1, Number(c.tokenUses) || 1) : Infinity;
    this.tokenExpiresAt = c.token ? now + Math.max(30, Number(c.expiresIn) || 60) * 1000 : Infinity;
    this.adoptWords(c.words, c.key);
  };

  GeminiLive.prototype.adoptWords = function (words, key) {
    var now = Date.now();
    this.wordsCredential = words && words.model && (words.token || key) ? {
      model: words.model,
      token: words.token || "",
      key: words.token ? "" : key,
      usesLeft: words.token ? Math.max(1, Number(words.uses) || 1) : Infinity,
      expiresAt: words.token ? now + Math.max(30, Number(words.expiresIn) || 60) * 1000 : Infinity,
    } : null;
  };

  GeminiLive.prototype.tokenUsable = function () {
    return !!this.config && (!this.config.token || (this.tokenUsesLeft > 0 && Date.now() < this.tokenExpiresAt - 15000));
  };

  // New tokens from the backend when the current one is spent or about to expire.
  GeminiLive.prototype.ensureConfig = function () {
    var self = this;
    if (this.tokenUsable() || typeof this.h.fetchConfig !== "function") return Promise.resolve(this.config);
    return Promise.resolve(this.h.fetchConfig()).then(function (config) {
      if (!config || (!config.token && !config.key)) throw new Error("No voice token.");
      self.adoptConfig(config);
      return config;
    });
  };

  // ------------------------------------------------------------------ connection
  GeminiLive.prototype.connect = function (config) {
    var self = this;
    if (config) this.adoptConfig(config);
    this.closedByUs = false;
    this.setState("connecting");
    return new Promise(function (resolve, reject) {
      var c = self.config || {};
      var WS = self.h.WebSocketImpl || root.WebSocket;
      var ws;
      try { ws = new WS(socketUrl(c)); } catch (error) { reject(error); return; }
      if (c.token) self.tokenUsesLeft--;
      self.ws = ws;
      self.ready = false;
      var settled = false;
      var fail = function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (c.token) self.tokenUsesLeft = 0;   // the next attempt asks for a fresh token
        reject(error);
      };
      var timeout = setTimeout(function () { fail(new Error("Gemini Live did not answer the setup in time.")); try { ws.close(); } catch (e) {} }, 12000);
      ws.onopen = function () { ws.send(JSON.stringify(self.setupMessage())); };
      ws.onmessage = function (event) {
        self.decode(event.data, function (message) {
          if (self.ws !== ws) { if (self.closedByUs) { try { ws.close(); } catch (e) {} } return; }   // closed while it was connecting
          if (!message) return;
          if (message.setupComplete) {
            self.ready = true;
            if (!settled) { settled = true; clearTimeout(timeout); self.setState("ready"); resolve(); }
            return;
          }
          self.handleMessage(message);
        });
      };
      ws.onerror = function () { fail(new Error("Gemini Live connection failed.")); };
      ws.onclose = function (event) {
        if (self.ws !== ws) return;   // an old socket closing after a reconnect
        self.ready = false;
        self.capturing = false;
        if (!settled) { fail(new Error("Gemini Live closed: " + (event && event.reason ? event.reason : event && event.code))); return; }
        if (!self.closedByUs) self.reconnect(event && event.reason);
      };
    });
  };

  GeminiLive.prototype.setupMessage = function () {
    var c = this.config;
    // With a token, Google enforces the setup the backend put in it; this copy is the same.
    var setup = {
      model: "models/" + c.model,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice || "Leda" } } },
      },
      systemInstruction: { parts: [{ text: c.instructions || "" }] },
      tools: c.tools || [],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: c.realtimeInputConfig || { automaticActivityDetection: DEFAULT_ACTIVITY },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    };
    return { setup: setup };
  };

  // Messages come as text frames or as binary frames holding JSON.
  GeminiLive.prototype.decode = function (data, done) {
    try {
      if (typeof data === "string") return done(JSON.parse(data));
      if (data && typeof data.text === "function") return data.text().then(function (text) { done(JSON.parse(text)); }).catch(function () { done(null); });
      if (data instanceof ArrayBuffer) return done(JSON.parse(new TextDecoder().decode(new Uint8Array(data))));
      if (data && data.buffer) return done(JSON.parse(new TextDecoder().decode(data)));
    } catch (error) { done(null); }
  };

  GeminiLive.prototype.reconnect = function (reason) {
    var self = this;
    if (this.reconnecting || this.closedByUs) return;
    this.reconnecting = true;
    this.setState("connecting");
    var attempt = 0;
    var tryAgain = function () {
      if (self.closedByUs) { self.reconnecting = false; return; }
      attempt++;
      self.ensureConfig().then(function () { return self.connect(); }).then(function () {
        self.reconnecting = false;
        if (self.lastContext) self.sendContext(self.lastContext);
      }).catch(function () {
        if (attempt < 3 && !self.closedByUs) { setTimeout(tryAgain, 600 * attempt); return; }
        self.reconnecting = false;
        self.setState("idle");
        self.emit("onError", "Gemini Live voice connection was lost" + (reason ? " (" + reason + ")" : "") + ".");
      });
    };
    setTimeout(tryAgain, 250);
  };

  GeminiLive.prototype.close = function () {
    this.closedByUs = true;
    this.capturing = false;
    this.stopPlayback();
    this.detachMicrophone();
    this.closeWords();
    var ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch (e) {} }
    this.ready = false;
    this.setState("idle");
  };

  GeminiLive.prototype.send = function (message) {
    if (!this.ws || !this.ready || this.ws.readyState !== 1) return false;
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
    return true;
  };

  // ------------------------------------------------------------------ server messages
  GeminiLive.prototype.handleMessage = function (message) {
    var self = this;
    if (message.sessionResumptionUpdate && message.sessionResumptionUpdate.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumeHandle = message.sessionResumptionUpdate.newHandle;
    }
    if (message.goAway) {
      // The server will end this session soon: move to a fresh one between turns.
      this.pendingRenew = true;
      if (!this.modelTurnActive && !this.capturing) this.renew();
    }
    // Gemini's own voice detector: speech confirmed, and the moment it decided the learner has
    // finished. Solaris shows she is thinking at once, and Unity gets the learner's words then (about
    // half a second before the first word of the answer), so it can fly to a named planet, or take a
    // surface question for itself before any of Gemini's answer is heard.
    if (message.voiceActivity && message.voiceActivity.type) {
      if (message.voiceActivity.type === "ACTIVITY_START") {
        this.stats.speechStartAt = Date.now();
        // The learner is speaking a new question: an old answer still owed is no longer dropped
        // blindly (Gemini interrupts it itself if it had started; see resetTurn).
        this.dropPendingTurn = false;
        if (this.capturing) {
          // The learner goes on after a pause: that is a new piece of the question, told to Unity on its own.
          if (this.userFinalSent) { this.userTranscript = ""; this.userFinalSent = false; this.wordsDone = ""; this.wordsShown = ""; }
          this.activityEnded = false;
          this.setState("hearing");
        }
      } else if (message.voiceActivity.type === "ACTIVITY_END") {
        this.stats.speechEndAt = Date.now();
        this.activityEnded = true;
        if (this.capturing && !this.modelTurnActive) this.setState("thinking");
      }
    }
    if (message.toolCall && message.toolCall.functionCalls) {
      this.finishUserTurn();
      message.toolCall.functionCalls.forEach(function (call) {
        self.toolNames[call.id] = call.name;
        // Gemini waits for every tool result before it goes on speaking: if Unity never answers
        // (an exception there), answer for it so the conversation cannot freeze.
        self.timers["tool" + call.id] = setTimeout(function () {
          if (self.toolNames[call.id]) self.sendToolResult(call.id, { ok: false, message: "The app did not respond to this request." });
        }, 4000);
        self.emit("onToolCall", { callId: call.id, name: call.name, arguments: JSON.stringify(call.args || {}) });
      });
    }
    var content = message.serverContent;
    if (!content) return;
    if (content.inputTranscription && typeof content.inputTranscription.text === "string") {
      this.userTranscript += content.inputTranscription.text;
      if (!this.stats.finalAt) this.stats.finalAt = Date.now();
      if (!this.userFinalSent && this.userTranscript.trim()) this.emit("onUserInterim", this.userTranscript.trim());
    }
    if (this.activityEnded && !this.userFinalSent && this.userTranscript.trim()) {
      this.userFinalSent = true;
      this.emit("onUserFinal", this.userTranscript.trim());
    }
    if (content.interrupted) {
      this.stopPlayback();
      this.discardOld = false;
      this.dropPendingTurn = false;
    }
    if (this.discardOld || this.dropPendingTurn) {
      if (content.turnComplete) { this.discardOld = false; this.dropPendingTurn = false; this.modelTurnActive = false; this.assistantTranscript = ""; }
      return;
    }
    if (content.modelTurn || content.outputTranscription || content.turnComplete) this.lastContentAt = Date.now();
    if (content.modelTurn && content.modelTurn.parts) {
      this.modelTurnActive = true;
      this.finishUserTurn();
      content.modelTurn.parts.forEach(function (part) {
        if (part.inlineData && part.inlineData.data && !self.suppressed) {
          var rate = /rate=(\d+)/i.exec(part.inlineData.mimeType || "");
          self.play(bytesFromBase64(part.inlineData.data), rate ? Number(rate[1]) : 24000);
        }
      });
    }
    if (content.outputTranscription && typeof content.outputTranscription.text === "string" && !this.suppressed) {
      this.assistantTranscript += content.outputTranscription.text;
      this.emit("onAssistantInterim", this.assistantTranscript.trim());
    }
    if (content.turnComplete) this.finishModelTurn();
  };

  GeminiLive.prototype.finishModelTurn = function () {
    var self = this;
    clearTimeout(this.timers.afterTool);
    // The learner's words first: a transcript that only arrives with the end of the turn can still
    // have Unity take the answer for itself (suppressResponse) before any of it is reported.
    this.finishUserTurn();
    var said = this.suppressed ? "" : this.assistantTranscript.trim();
    this.assistantTranscript = "";
    this.modelTurnActive = false;
    this.playback.chunks = 0;   // the next answer's first chunk takes the jitter lead again
    // A suppressed turn stays suppressed while the model waits for a tool result (it goes on speaking
    // after it, in the same turn); it is heard again from the next turn.
    if (!Object.keys(this.toolNames).length) this.suppressed = false;
    if (said) this.emit("onAssistantFinal", said);
    this.whenPlaybackEnds(function () {
      if (!self.capturing && !self.modelTurnActive) self.setState(self.idleState || "ready");
      if (self.pendingRenew && !self.capturing && !self.modelTurnActive) self.renew();
    });
  };

  // Measured 24 Sep 2026: when Gemini speaks first and calls a tool at the end of its answer, it can
  // go quiet after the tool result without ever closing the turn, and Solaris stayed "speaking" until
  // the next question. If nothing more comes, the turn is closed here once the voice has played out:
  // 2.5 s after the result at the earliest when something was said, 6 s when nothing was.
  GeminiLive.prototype.watchTurnAfterTool = function () {
    var self = this;
    var sentAt = Date.now();
    clearTimeout(this.timers.afterTool);
    var look = function () {
      if (!self.ws || (self.lastContentAt || 0) > sentAt) return;   // Gemini went on: its own turnComplete ends the turn
      if ((!self.assistantTranscript.trim() && Date.now() - sentAt < 6000) || self.isSpeaking()) { self.timers.afterTool = setTimeout(look, 400); return; }
      self.finishModelTurn();
    };
    this.timers.afterTool = setTimeout(look, 2500);
  };

  GeminiLive.prototype.renew = function () {
    this.pendingRenew = false;
    if (this.ws) { try { this.ws.close(); } catch (e) {} }   // onclose reconnects with the resumption handle
  };

  // The learner's words are final once Gemini starts to answer (or calls a tool): tell Unity at once,
  // so it can fly to a named planet while Solaris starts to speak.
  GeminiLive.prototype.finishUserTurn = function () {
    if (this.capturing) this.stopCapture(false);
    if (this.userFinalSent) return;
    // Live's own transcript is the one Unity acts on; the words session's covers the rare turn
    // where Live answers (or calls a tool) without one.
    var heard = this.userTranscript.trim() || this.wordsShown.trim();
    if (heard) {
      this.userFinalSent = true;
      this.emit("onUserFinal", heard);
    }
  };

  // ------------------------------------------------------------------ the learner's words, live
  GeminiLive.prototype.openWords = function () {
    var self = this, credential = this.wordsCredential;
    clearTimeout(this.timers.wordsIdle);
    if (!credential || this.words || this.h.liveWords === false || root.metabookLiveWords === false) return;
    if (credential.token && (credential.usesLeft <= 0 || Date.now() > credential.expiresAt - 15000)) { this.refreshWords(); return; }
    var WS = this.h.WebSocketImpl || root.WebSocket;
    var ws;
    try { ws = new WS(socketUrl(credential)); } catch (error) { return; }
    if (credential.token) credential.usesLeft--;
    var words = { ws: ws, ready: false, queue: [] };
    this.words = words;
    ws.onopen = function () { ws.send(JSON.stringify({ setup: { model: "models/" + credential.model, inputAudioTranscription: {} } })); };
    ws.onmessage = function (event) {
      self.decode(event.data, function (message) {
        if (!message || self.words !== words) return;
        if (message.setupComplete) {
          words.ready = true;
          words.queue.forEach(function (queued) { ws.send(queued); });
          words.queue = [];
          return;
        }
        self.handleWords(message);
      });
    };
    ws.onerror = noop;
    ws.onclose = function () { if (self.words === words) self.words = null; };
  };

  // Spent or expired words token: ask the backend for a new one in the background (next question).
  GeminiLive.prototype.refreshWords = function () {
    var self = this;
    if (this.refreshingWords || typeof this.h.fetchConfig !== "function") return;
    this.refreshingWords = true;
    Promise.resolve(this.h.fetchConfig("words")).then(function (config) {
      if (config && config.words) self.adoptWords(config.words, self.config && self.config.key);
    }).catch(noop).then(function () { self.refreshingWords = false; });
  };

  GeminiLive.prototype.feedWords = function (json) {
    var words = this.words;
    if (!words) return;
    if (words.ready && words.ws.readyState === 1) words.ws.send(json);
    else if (words.queue.length < 400) words.queue.push(json);
  };

  GeminiLive.prototype.closeWords = function () {
    clearTimeout(this.timers.wordsIdle);
    var words = this.words;
    this.words = null;
    if (words) { try { words.ws.close(); } catch (e) {} }
  };

  GeminiLive.prototype.handleWords = function (message) {
    var content = message.serverContent;
    if (!content || Date.now() < this.wordsIgnoreUntil) return;
    var interim = content.interimInputTranscription, final = content.inputTranscription;
    var piece = final || interim;
    if (!piece || typeof piece.text !== "string" || !piece.text.trim()) return;
    if (this.userFinalSent || !this.stats.turnStartedAt) return;
    // A pause inside one question can close the transcriber's segment: keep the finished segments.
    var text = (this.wordsDone + " " + piece.text).replace(/\s+/g, " ").trim();
    if (final) this.wordsDone = text;
    this.wordsShown = text;
    if (!this.stats.firstWordsAt) this.stats.firstWordsAt = Date.now();
    if (!this.userTranscript.trim()) this.emit("onUserInterim", text);   // Live's own transcript wins once it is here
  };

  // ------------------------------------------------------------------ what the app sends
  GeminiLive.prototype.sendText = function (text) {
    this.resetTurn();
    this.stats = newStats(Date.now());
    this.warmPlayback();
    this.setState("thinking");
    return this.send({ realtimeInput: { text: String(text || "") } });
  };

  // Context the model should know but not answer: what is selected, the level, the active question.
  // The last one is repeated after a reconnect; a one-off note (an answer Unity gave from its own
  // knowledge bank) passes transient = true so it does not take that place.
  GeminiLive.prototype.sendContext = function (text, transient) {
    if (!transient) this.lastContext = text;
    return this.send({ clientContent: { turns: [{ role: "user", parts: [{ text: "[Context] " + text }] }], turnComplete: false } });
  };

  GeminiLive.prototype.sendToolResult = function (callId, result) {
    var name = this.toolNames[callId] || "";
    delete this.toolNames[callId];
    clearTimeout(this.timers["tool" + callId]);
    delete this.timers["tool" + callId];
    var response = typeof result === "string" ? (function () { try { return JSON.parse(result); } catch (e) { return { output: result }; } })() : (result || {});
    var sent = this.send({ toolResponse: { functionResponses: [{ id: callId, name: name, response: response }] } });
    if (sent) this.watchTurnAfterTool();
    return sent;
  };

  // Unity answers this turn itself (a surface conversation, or its knowledge bank): drop Gemini's
  // answer to it. Audio already playing stops now; the rest of the turn's audio and transcript are
  // dropped as they arrive (handleMessage), and no onAssistantFinal is given for it. The flag
  // clears when the turn completes (finishModelTurn) or a new turn starts (resetTurn).
  GeminiLive.prototype.suppressResponse = function () {
    // Nothing owed for this turn (a typed request Unity took before any text went out, or an answer
    // already complete and only draining): only a model turn clears the flag, so set now it would stay,
    // and the next typed question's whole answer would be dropped (resetTurn). Stop what plays, no flag.
    if (!this.capturing && !this.modelTurnActive && this.state !== "thinking") { this.stopPlayback(); return; }
    this.suppressed = true;
    this.assistantTranscript = "";
    // Unity has the turn: the microphone stops streaming now, so Solaris's own voice (the recorded
    // answer starts within milliseconds) is not fed to Gemini as more of the question, and no later
    // piece of transcript can make a second question of it.
    if (this.capturing) this.stopCapture(false);
    this.userFinalSent = true;
    this.stopPlayback();
    if (this.state === "speaking") this.setState("thinking");
  };

  // Unity is about to speak an answer of its own (a typed question): what Gemini is still saying about
  // the previous question stops now, and the rest of that answer is dropped as it arrives. A turn
  // that was sent but not yet answered is dropped too (suppressed), like a spoken bank answer.
  GeminiLive.prototype.interruptAnswer = function () {
    if (this.suppressed) { this.stopPlayback(); return; }   // already being dropped, ends on its own
    if (this.modelTurnActive) { this.discardOld = true; this.modelTurnActive = false; }
    else if (this.state === "thinking") this.suppressed = true;
    this.assistantTranscript = "";
    this.stopPlayback();
    if (!this.capturing && this.state === "speaking") this.setState(this.idleState || "ready");
  };

  GeminiLive.prototype.resetTurn = function () {
    // Still answering the last turn: drop the rest of that answer (until its end or an interruption).
    if (this.modelTurnActive) { this.discardOld = true; this.modelTurnActive = false; this.stopPlayback(); }
    // The last turn was taken by Unity but its answer has not started (a second tap 0.5 s after the
    // question): that answer is still dropped when it comes, up to its end, an interruption, or the
    // learner's next words (Gemini interrupts a started answer itself then).
    this.dropPendingTurn = this.suppressed && !this.modelTurnActive && !this.discardOld;
    this.userTranscript = "";
    this.userFinalSent = false;
    this.assistantTranscript = "";
    this.suppressed = false;
    this.wordsDone = "";
    this.wordsShown = "";
    this.activityEnded = false;
  };

  // ------------------------------------------------------------------ microphone
  // The stream stays attached for the session and the processor keeps running between turns, so a
  // tap starts streaming with the next audio block (about 40 ms) instead of opening the microphone.
  GeminiLive.prototype.attachMicrophone = function (stream) {
    var self = this;
    if (!stream || !root.AudioContext && !root.webkitAudioContext) return;
    this.detachMicrophone();
    var Context = root.AudioContext || root.webkitAudioContext;
    // With options, never plain: the page hands its tap-made context to the first plain
    // `new AudioContext()`, which is meant for Unity (index.html).
    var context;
    try { context = new Context({ latencyHint: "interactive" }); } catch (e) { return; }
    var source = context.createMediaStreamSource(stream);
    // 2048 samples (~43 ms at 48 kHz): half the old block, so the end of a question reaches Gemini sooner.
    var processor = context.createScriptProcessor(2048, 1, 1);
    var ratio = context.sampleRate / INPUT_RATE;
    processor.onaudioprocess = function (event) {
      if (!self.capturing) return;
      self.sendAudio(downsample(event.inputBuffer.getChannelData(0), ratio));
    };
    source.connect(processor);
    // A silent sink keeps the processor running without playing the microphone back.
    var sink = context.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(context.destination);
    this.mic = { context: context, source: source, processor: processor, sink: sink, stream: stream };
  };

  // One block of 16 kHz 16-bit samples from the microphone (or the QA harness, which plays recorded
  // questions in here). Its loudness gives the "voice detected" state and feeds the no-speech timeout.
  GeminiLive.prototype.sendAudio = function (pcm) {
    if (this.capturing) {
      var energy = 0;
      for (var i = 0; i < pcm.length; i += 4) { var s = pcm[i] / 32768; energy += s * s; }
      var rms = Math.sqrt(energy / Math.max(1, Math.ceil(pcm.length / 4)));
      if (rms > 0.02) { this.lastSoundAt = Date.now(); if (!this.heardSound) { this.heardSound = true; this.setState("hearing"); } }
    }
    var json = JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=" + INPUT_RATE, data: base64FromBytes(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) } } });
    this.send(json);
    this.feedWords(json);
  };

  GeminiLive.prototype.detachMicrophone = function () {
    if (!this.mic) return;
    try { this.mic.processor.disconnect(); this.mic.source.disconnect(); this.mic.sink.disconnect(); } catch (e) {}
    try { this.mic.context.close(); } catch (e) {}
    this.mic = null;
  };

  // One learner turn: the microphone streams until Gemini hears the end of the question.
  GeminiLive.prototype.beginTurn = function () {
    var self = this;
    if (!this.ready) return false;
    this.stopPlayback();
    this.resetTurn();
    this.capturing = true;
    this.heardSound = false;
    this.lastSoundAt = Date.now();
    this.stats = newStats(Date.now());
    this.wordsIgnoreUntil = Date.now() + 250;   // a late line from the previous question is not this one
    this.openWords();
    this.warmPlayback();
    if (this.mic && this.mic.context.state === "suspended") this.mic.context.resume().catch(noop);
    this.setState("listening");
    clearInterval(this.timers.capture);
    var startedAt = Date.now();
    this.timers.capture = setInterval(function () {
      if (!self.capturing) { clearInterval(self.timers.capture); return; }
      var now = Date.now();
      // Nothing heard: no loud block, no words from either session, and Gemini saw no speech.
      if (!self.heardSound && !self.userTranscript && !self.wordsShown && !self.stats.speechStartAt && now - startedAt > NO_SPEECH_MS) { self.stopCapture(true); self.setState(self.idleState || "ready"); self.emit("onUserFinal", ""); }
      else if (now - startedAt > MAX_TURN_MS) self.endTurn();
    }, 250);
    return true;
  };

  // The learner (or the app) ends the turn now: Gemini answers what it has heard.
  GeminiLive.prototype.endTurn = function () {
    if (!this.capturing) return;
    this.stopCapture(true);
    this.setState("thinking");
  };

  GeminiLive.prototype.stopCapture = function (flush) {
    var wasCapturing = this.capturing;
    this.capturing = false;
    clearInterval(this.timers.capture);
    if (flush) this.send({ realtimeInput: { audioStreamEnd: true } });
    if (wasCapturing) {
      // The transcriber must see the end of this question, or it would join it to the next one.
      this.feedWords(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      var self = this;
      clearTimeout(this.timers.wordsIdle);
      this.timers.wordsIdle = setTimeout(function () { if (!self.capturing) self.closeWords(); }, WORDS_IDLE_MS);
    }
  };

  // ------------------------------------------------------------------ Solaris's voice
  // Measured 25 Sep 2026 behind the owner's "glitchy, far away": each 24 kHz chunk was resampled on
  // its own into a 48 kHz context (a click at every chunk boundary), a chunk arriving after its time
  // left a gap (crackle), and full-scale peaks clipped. Now: a context at the stream's rate, a jitter
  // lead, ramped edges and headroom.
  GeminiLive.prototype.ensurePlayback = function (rate) {
    if (this.playback.context) return this.playback.context;
    var Context = root.AudioContext || root.webkitAudioContext;
    if (!Context) return null;
    // Always a constructor with options: the page hands its tap-made context to the first plain
    // `new AudioContext()`, which is meant for Unity (index.html). At the stream's rate the chunks
    // play as they came; a browser that refuses the rate gets its default one (chunks resampled then).
    var context = null;
    try { context = new Context({ sampleRate: rate || 24000 }); } catch (e) { context = null; }
    if (!context) { try { context = new Context({ latencyHint: "interactive" }); } catch (e) { return null; } }
    var gain = context.createGain();
    gain.gain.value = this.volume * HEADROOM;
    gain.connect(context.destination);
    this.playback.context = context;
    this.playback.gain = gain;
    this.playback.nextTime = 0;
    return context;
  };

  // Ready before the answer arrives (the tap is the gesture that lets it run), so the first chunk
  // plays the moment it lands.
  GeminiLive.prototype.warmPlayback = function () {
    var context = this.ensurePlayback(24000);
    if (context && context.state === "suspended") context.resume().catch(noop);
  };

  // When a chunk starts. The first chunk of an answer waits the jitter lead (or joins the tail of the
  // previous answer if that is still playing); the rest follow back to back. A chunk that arrives
  // after its time (an underrun) is a fresh start with the full lead: one clean pause instead of a
  // stutter, and never a gap shorter than the lead.
  GeminiLive.prototype.scheduleChunk = function (now, duration) {
    var p = this.playback, lead = JITTER_LEAD_MS / 1000, at;
    if (p.chunks === 0) at = Math.max(p.nextTime, now + lead);
    else if (p.nextTime >= now + SCHEDULE_MARGIN_MS / 1000) at = p.nextTime;
    else { this.stats.underruns++; at = now + lead; }
    var continuous = !!p.last && at === p.nextTime;
    p.nextTime = at + duration;
    p.chunks++;
    this.stats.scheduledSeconds += duration;
    return { at: at, continuous: continuous };
  };

  GeminiLive.prototype.play = function (bytes, rate) {
    rate = rate || 24000;
    var count = Math.floor(bytes.byteLength / 2);
    this.audioBytesReceived += bytes.length;
    this.stats.receivedSeconds += count / rate;
    if (this.stats.firstAudioMs < 0 && this.stats.turnStartedAt) { this.stats.firstAudioAt = Date.now(); this.stats.firstAudioMs = this.stats.firstAudioAt - this.stats.turnStartedAt; }
    this.setState("speaking");
    var context = this.ensurePlayback(rate);
    if (!context) return;   // Node harness: count only
    if (context.state === "suspended") context.resume().catch(noop);
    var samples = new Int16Array(bytes.buffer, bytes.byteOffset, count);
    var buffer = context.createBuffer(1, count, rate);
    var channel = buffer.getChannelData(0);
    for (var i = 0; i < count; i++) channel[i] = samples[i] / 32768;
    // Each chunk has its own gain for its edges; the master gain holds the volume.
    var edge = context.createGain();
    edge.connect(this.playback.gain);
    var source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(edge);
    source.edge = edge.gain;
    var now = context.currentTime, ramp = Math.min(EDGE_RAMP_MS / 1000, buffer.duration / 2);
    var slot = this.scheduleChunk(now, buffer.duration), at = slot.at, end = at + buffer.duration;
    var last = this.playback.last;
    // Straight after the previous chunk, and before its fade-out has begun: that fade-out is
    // dropped and the samples run on as they came (a ramp on every chunk would dent continuous
    // speech). After a gap, or inside the previous chunk's last milliseconds, this chunk fades in.
    if (slot.continuous && now < last.rampAt) { last.gain.cancelScheduledValues(last.rampAt); edge.gain.setValueAtTime(1, at); }
    else { edge.gain.setValueAtTime(0, at); edge.gain.linearRampToValueAtTime(1, at + ramp); }
    // The fade-out stays unless the next chunk arrives in time: the answer's last chunk, and a
    // chunk before a late one, end clean.
    edge.gain.setValueAtTime(1, end - ramp);
    edge.gain.linearRampToValueAtTime(0, end);
    source.start(at);
    this.playback.last = { gain: edge.gain, rampAt: end - ramp };
    var list = this.playback.sources;
    list.push(source);
    var self = this;
    source.onended = function () {
      var index = list.indexOf(source);
      if (index >= 0) list.splice(index, 1);
      if (!list.length && self.playbackDrained) { var done = self.playbackDrained; self.playbackDrained = null; done(); }
    };
  };

  GeminiLive.prototype.whenPlaybackEnds = function (done) {
    if (!this.playback.sources.length) { done(); return; }
    this.playbackDrained = done;
  };

  // Whatever is queued fades out over the edge ramp and stops, instead of being cut mid-wave. The
  // fade is anchored past the scheduling margin (and the context's own latency), where the audio
  // thread can still honour it; 15-20 ms more of the old answer is not heard on a barge-in.
  GeminiLive.prototype.stopPlayback = function () {
    var p = this.playback, list = p.sources.slice(), context = p.context;
    p.sources.length = 0;
    var now = context ? context.currentTime : 0, ramp = EDGE_RAMP_MS / 1000;
    var at = now + Math.max(SCHEDULE_MARGIN_MS / 1000, (context && context.baseLatency) || 0);
    list.forEach(function (source) {
      try {
        source.onended = null;
        var edge = source.edge;
        if (edge) { edge.cancelScheduledValues(at); edge.setValueAtTime(edge.value, at); edge.linearRampToValueAtTime(0, at + ramp); }
        source.stop(at + ramp);
      } catch (e) {}
    });
    if (context) p.nextTime = at + ramp;
    p.last = null;
    p.chunks = 0;
    if (this.playbackDrained) { var done = this.playbackDrained; this.playbackDrained = null; done(); }
  };

  GeminiLive.prototype.isSpeaking = function () { return this.playback.sources.length > 0; };

  // The app's volume (Unity's master, mirrored by the plug-in); the headroom stays under it.
  GeminiLive.prototype.setVolume = function (value) {
    this.volume = value;
    if (this.playback.gain) this.playback.gain.gain.value = value * HEADROOM;
  };

  root.MetabookGeminiLive = GeminiLive;
  if (typeof module !== "undefined" && module.exports) module.exports = GeminiLive;
})(typeof window !== "undefined" ? window : globalThis);
