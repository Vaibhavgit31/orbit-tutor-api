// Which Solaris the page talks to (owner, 24 Sep 2026: "user don't need to put api in start, the
// api should be written in backend"). window.metabookSolarisSetup(loadingStatus) settles it before
// the player starts:
//  - normally the tutor API at window.metabookApiBase (the Render service that holds the Gemini key):
//    learners are never asked for anything;
//  - ?setkey (or the older ?resetkey) is the owner's switch: he enters a Gemini key for this browser
//    and solaris-worker.js answers the tutor API from inside the browser instead (direct mode);
//  - a key already stored in this browser is used only when the API does not answer (or with ?direct);
//  - no API and no key: nothing is asked; Solaris uses her offline knowledge and the browser's voice.
//
// Direct mode: the page registers solaris-worker.js, which answers the tutor API with the key kept in
// this browser's IndexedDB; it is never published or sent anywhere but Google's Gemini API
// (generativelanguage.googleapis.com). window.metabookDirectSetup(loadingStatus, options) resolves once
// the worker controls the page and window.metabookApiBase points at "<site>/solaris"; without a key
// (or a service worker) it leaves the page on the API, or on the offline tutor when there is none.
(function () {
  var DB = "solaris-direct", STORE = "config", KEY = "geminiKey";   // an old OpenAI key ("openaiKey") is simply no longer read

  function openStore() {
    return new Promise(function (resolve, reject) {
      var open = indexedDB.open(DB, 1);
      open.onupgradeneeded = function () { open.result.createObjectStore(STORE); };
      open.onsuccess = function () { resolve(open.result); };
      open.onerror = function () { reject(open.error); };
    });
  }
  function readKey() {
    return openStore().then(function (db) {
      return new Promise(function (resolve, reject) {
        var get = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        get.onsuccess = function () { resolve(String(get.result || "")); db.close(); };
        get.onerror = function () { reject(get.error); db.close(); };
      });
    }).catch(function () { return ""; });
  }
  function writeKey(value) {
    return openStore().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = function () { resolve(); db.close(); };
        tx.onerror = function () { reject(tx.error); db.close(); };
      });
    }).catch(function () {});
  }
  function tellWorker(key) {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller)
        navigator.serviceWorker.controller.postMessage({ type: "solaris-key", key: key });
    } catch (e) {}
  }

  // The site directory ("/orbit-tutor-api/") is the worker's scope and the API's home.
  function siteBase() {
    var path = window.location.pathname;
    return path.slice(0, path.lastIndexOf("/") + 1);
  }

  function registerWorker() {
    if (!("serviceWorker" in navigator)) return Promise.reject(new Error("no service worker"));
    var base = siteBase();
    return navigator.serviceWorker.register(base + "solaris-worker.js", { scope: base }).then(function (registration) {
      if (navigator.serviceWorker.controller) return;
      if (registration.active) registration.active.postMessage({ type: "solaris-claim" });
      // First visit: the fresh worker claims the page; wait until it has.
      return new Promise(function (resolve) {
        var done = false;
        navigator.serviceWorker.addEventListener("controllerchange", function () { if (!done) { done = true; resolve(); } });
        setTimeout(function () { if (!done) { done = true; resolve(); } }, 4000);
      });
    });
  }

  // The whole path the player will use: the service worker, the key it holds,
  // and Gemini's answer, timed, so a slow or broken link is seen here first.
  function selfCheck() {
    var startedAt = Date.now();
    var base = window.location.origin + siteBase() + "solaris";
    return fetch(base + "/api/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "solar_system", studentMessage: "Hello Solaris, are you there?", selectedObject: "" })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (response.ok && body && body.message) return { ok: true, ms: Date.now() - startedAt };
        return { ok: false, error: (body && body.error) || ("HTTP " + response.status) };
      });
    }).catch(function (error) { return { ok: false, error: error && error.message ? error.message : String(error) }; });
  }

  // A test call: the key is only kept once Gemini accepts it.
  function checkKey(key) {
    return fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key } })
      .then(function (response) { return response.ok; })
      .catch(function () { return true; });   // offline right now: keep it, the tutor will report later
  }

  function askForKey() {
    return new Promise(function (resolve) {
      var gate = document.createElement("div");
      gate.id = "key-gate";
      gate.style.cssText = "position:fixed;inset:0;background:rgba(2,7,18,0.92);display:flex;align-items:center;justify-content:center;z-index:1000;";
      gate.innerHTML = '<form style="background:#101B26;border:1px solid rgba(180,228,218,0.25);border-radius:16px;padding:28px;width:min(92vw,420px);text-align:center;color:#EDF3F7;font:16px/1.6 system-ui,sans-serif">' +
        '<div style="font-size:18px;font-weight:600;margin-bottom:6px">Solaris needs a Gemini key</div>' +
        '<div style="color:#95A8B9;font-size:14px;margin-bottom:18px">Paste your Google Gemini API key to switch Solaris on. It stays in this browser only and is sent only to the Google Gemini API.</div>' +
        '<input name="key" type="password" autocomplete="off" placeholder="Gemini API key" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(180,228,218,0.3);background:#020712;color:#EDF3F7;font:inherit">' +
        '<button type="submit" style="width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#B4E4DA;color:#071A1E;font:inherit;font-weight:600">Switch Solaris on</button>' +
        '<button type="button" class="skip" style="width:100%;margin-top:8px;padding:10px;border:1px solid rgba(180,228,218,0.3);border-radius:10px;background:transparent;color:#95A8B9;font:inherit">Continue without Solaris</button>' +
        '<div class="bad" style="color:#f87171;font-size:13px;margin-top:10px;min-height:1.4em"></div></form>';
      var form = gate.querySelector("form"), input = gate.querySelector("input"), note = gate.querySelector(".bad");
      gate.querySelector(".skip").addEventListener("click", function () { gate.remove(); resolve(""); });
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var key = (input.value || "").trim();
        if (key.length < 30 || /\s/.test(key) || /^sk-/.test(key)) { note.textContent = /^sk-/.test(key) ? "That is an OpenAI key; Solaris now uses a Google Gemini key." : "That does not look like a Gemini API key."; return; }
        note.textContent = "Checking with Gemini...";
        checkKey(key).then(function (ok) {
          if (!ok) { note.textContent = "Gemini did not accept that key."; return; }
          return writeKey(key).then(function () {
            tellWorker(key);
            note.style.color = "#95A8B9";
            note.textContent = "Key accepted. Asking Solaris a test question...";
            return selfCheck().then(function (result) {
              if (result.ok) {
                note.style.color = "#34D399";
                note.textContent = "Solaris is connected · answered in " + (result.ms / 1000).toFixed(1) + " s";
                setTimeout(function () { gate.remove(); resolve(key); }, 1200);
              } else {
                note.style.color = "#f87171";
                note.textContent = "Solaris could not answer: " + result.error + " You can try again or continue without Solaris.";
              }
            });
          });
        });
      });
      document.body.appendChild(gate);
      try { input.focus(); } catch (e) {}
    });
  }

  function keySwitch() {
    var params = new URLSearchParams(window.location.search);
    return params.has("setkey") || params.has("resetkey");
  }

  // options.ask: show the key card (the owner's ?setkey); options.fallbackBase: the tutor API to stay on
  // when this browser has no key after all ("" = the offline tutor).
  window.metabookDirectSetup = function (loadingStatus, options) {
    options = options || {};
    var setStatus = function (text) { if (loadingStatus) loadingStatus.textContent = text; };
    var ask = options.ask !== undefined ? options.ask : keySwitch();
    var keptCode = window.metabookAccessCode;
    var stayOffDirect = function () {
      window.metabookApiBase = options.fallbackBase || "";
      window.metabookAccessCode = options.fallbackBase ? keptCode : "";
    };
    return (ask ? Promise.resolve("") : readKey()).then(function (key) {
      if (!key && !ask) { stayOffDirect(); return; }   // nothing to ask a learner: the API if there is one
      return registerWorker().then(function () {
        window.metabookApiBase = window.location.origin + siteBase() + "solaris";
        window.metabookAccessCode = "direct";   // the access gate belongs to the server this replaces
        if (key) { tellWorker(key); return; }
        setStatus("Solaris is ready when you are.");
        return askForKey().then(function (entered) { if (entered) tellWorker(entered); else stayOffDirect(); });
      });
    }).catch(function (error) {
      console.warn("Solaris direct mode is unavailable:", error && error.message ? error.message : error);
      stayOffDirect();
    });
  };

  // The page's wake-up ping (index.html) as a promise that gives up after ms: the health report or null.
  function backendHealth(ms) {
    return Promise.race([
      Promise.resolve(window.metabookBackendHealth).catch(function () { return null; }),
      new Promise(function (resolve) { setTimeout(function () { resolve(null); }, ms); })
    ]);
  }

  window.metabookSolarisSetup = function (loadingStatus) {
    var api = window.metabookDirectMode ? "" : (window.metabookApiBase || "");
    if (keySwitch()) return window.metabookDirectSetup(loadingStatus, { ask: true, fallbackBase: api });
    // The serverless site (DIRECT=1 publish): the key stored in this browser, or the offline tutor.
    if (window.metabookDirectMode) return window.metabookDirectSetup(loadingStatus, { ask: false, fallbackBase: "" });
    // No API address: the page and the API share one origin (a local server); nothing to decide.
    if (!api) return Promise.resolve();
    return readKey().then(function (key) {
      if (!key) return;   // every learner: the tutor API, nothing asked
      if (new URLSearchParams(window.location.search).has("direct")) return window.metabookDirectSetup(loadingStatus, { ask: false, fallbackBase: api });
      // The owner's browser holds a key: the API when it is awake, his key when it is not.
      return backendHealth(2500).then(function (health) {
        if (health && health.aiConfigured) return;
        return window.metabookDirectSetup(loadingStatus, { ask: false, fallbackBase: api });
      });
    });
  };
})();
