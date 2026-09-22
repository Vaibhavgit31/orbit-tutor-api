// Direct mode: Solaris without a server (GitHub Pages only). The page registers
// solaris-worker.js, which answers the tutor API from inside the browser using
// an OpenAI key the visitor enters once. The key lives in this browser's
// IndexedDB and is never published or sent anywhere but api.openai.com.
//
// window.metabookDirectSetup(loadingStatus) resolves once the worker controls
// the page and window.metabookApiBase points at "<site>/solaris". Without a
// service worker (very old browsers) it resolves with the API base left empty,
// and the player falls back to its offline tutor.
(function () {
  var DB = "solaris-direct", STORE = "config", KEY = "openaiKey";

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
    return navigator.serviceWorker.register(base + "solaris-worker.js", { scope: base }).then(function () {
      if (navigator.serviceWorker.controller) return;
      // First visit: the fresh worker claims the page; wait until it has.
      return new Promise(function (resolve) {
        var done = false;
        navigator.serviceWorker.addEventListener("controllerchange", function () { if (!done) { done = true; resolve(); } });
        setTimeout(function () { if (!done) { done = true; resolve(); } }, 4000);
      });
    });
  }

  // The whole path the player will use: the service worker, the key it holds,
  // and OpenAI's answer, timed, so a slow or broken link is seen here first.
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

  // A test call: the key is only kept once OpenAI accepts it.
  function checkKey(key) {
    return fetch("https://api.openai.com/v1/models/gpt-4o-mini", { headers: { Authorization: "Bearer " + key } })
      .then(function (response) { return response.ok; })
      .catch(function () { return true; });   // offline right now: keep it, the tutor will report later
  }

  function askForKey() {
    return new Promise(function (resolve) {
      var gate = document.createElement("div");
      gate.id = "key-gate";
      gate.style.cssText = "position:fixed;inset:0;background:rgba(2,7,18,0.92);display:flex;align-items:center;justify-content:center;z-index:1000;";
      gate.innerHTML = '<form style="background:#101B26;border:1px solid rgba(180,228,218,0.25);border-radius:16px;padding:28px;width:min(92vw,420px);text-align:center;color:#EDF3F7;font:16px/1.6 system-ui,sans-serif">' +
        '<div style="font-size:18px;font-weight:600;margin-bottom:6px">Solaris needs an OpenAI key</div>' +
        '<div style="color:#95A8B9;font-size:14px;margin-bottom:18px">Paste your OpenAI API key to switch Solaris on. It stays in this browser only and is sent to nowhere but OpenAI.</div>' +
        '<input name="key" type="password" autocomplete="off" placeholder="sk-..." style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(180,228,218,0.3);background:#020712;color:#EDF3F7;font:inherit">' +
        '<button type="submit" style="width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#B4E4DA;color:#071A1E;font:inherit;font-weight:600">Switch Solaris on</button>' +
        '<button type="button" class="skip" style="width:100%;margin-top:8px;padding:10px;border:1px solid rgba(180,228,218,0.3);border-radius:10px;background:transparent;color:#95A8B9;font:inherit">Continue without Solaris</button>' +
        '<div class="bad" style="color:#f87171;font-size:13px;margin-top:10px;min-height:1.4em"></div></form>';
      var form = gate.querySelector("form"), input = gate.querySelector("input"), note = gate.querySelector(".bad");
      gate.querySelector(".skip").addEventListener("click", function () { gate.remove(); resolve(""); });
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var key = (input.value || "").trim();
        if (!/^sk-/.test(key)) { note.textContent = "That does not look like an OpenAI key (it starts with sk-)."; return; }
        note.textContent = "Checking with OpenAI...";
        checkKey(key).then(function (ok) {
          if (!ok) { note.textContent = "OpenAI did not accept that key."; return; }
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

  window.metabookDirectSetup = function (loadingStatus) {
    var setStatus = function (text) { if (loadingStatus) loadingStatus.textContent = text; };
    var params = new URLSearchParams(window.location.search);
    var reset = params.has("resetkey");
    return registerWorker().then(function () {
      window.metabookApiBase = window.location.origin + siteBase() + "solaris";
      window.metabookAccessCode = "direct";   // the access gate belongs to the server this replaces
      return reset ? "" : readKey();
    }).then(function (key) {
      if (key) { tellWorker(key); return; }
      setStatus("Solaris is ready when you are.");
      return askForKey().then(function (entered) { if (entered) tellWorker(entered); });
    }).catch(function (error) {
      console.warn("Solaris direct mode is unavailable:", error && error.message ? error.message : error);
      window.metabookApiBase = "";
    });
  };
})();
