// The Unity data file can be published as parts (GitHub Pages refuses any file
// over 100 MB, and the player's data passed that on 21 Sep 2026). When the
// publisher has split it, Build/data-parts.json lists the pieces; this fetches
// them in order and hands the loader a blob: URL in place of the missing file.
// With no manifest the page loads exactly as before. The loader still
// decompresses the .unityweb content itself (decompression fallback), just as
// it does when the server sends no Content-Encoding.
//
// Saved on the device (24 Sep 2026; owner: "optimize the project and then
// deploy"). The loader's own IndexedDB cache only keeps http(s) URLs, and the
// page hands it a blob: URL, so every visit used to download all 177 MB again.
// Now the joined file is kept in Cache Storage under the manifest's sha256:
// - a returning learner opens the Solar System from the device, no download;
// - a new build has a new sha256, so it is downloaded once and the old copy
//   is deleted first (two copies would not fit on a small tablet);
// - the parts stream straight into the saved copy, so the page never holds
//   the whole file in memory while it downloads (tablets ran short at the
//   loader's 90% step), and the file is only kept when its sha256 matches
//   (a half-published deploy must never be remembered);
// - storage refused (private windows, http, a full disk) loads it as before;
// - a saved copy that fails to start the player is dropped, so a reload
//   downloads it afresh. ?freshdata=1 in the page address does that on purpose.
// If the publisher ever switches the build to gzip, the browser unpacks the
// data natively here (Unity's own JavaScript decoder takes 7 s on a desktop
// and several times that on a tablet for this file).
(function () {
  var CACHE_NAME = "metabook-player-data-v1";
  var DOWNLOAD_SHARE = 0.9;   // the downloading part of the bar; the loader's own work fills the rest
  var noop = function () {};

  window.metabookLoadDataParts = function (config, buildUrl, assetVersion, loadingStatus, progressBarFull) {
    var noManifest = {};
    var ui = loadingUi(loadingStatus, progressBarFull);
    return fetch(buildUrl + "/data-parts.json" + assetVersion, { cache: "no-cache" })
      .then(function (response) { if (!response.ok) throw noManifest; return response.json(); })
      .then(function (manifest) {
        if (!manifest || !manifest.parts || !manifest.parts.length) return;
        return loadData(manifest, buildUrl, assetVersion, ui)
          .then(function (data) {
            return unpackIfGzip(data.blob, ui).then(function (blob) {
              config.dataUrl = URL.createObjectURL(blob);
              watchPlayerStart(ui, data, config.dataUrl, manifest.bytes || blob.size);
              ui.status("Starting Solar System…");
            });
          });
      })
      .catch(function (error) { if (error !== noManifest) throw error; });
  };

  // ------------------------------------------------------------------ the file
  function loadData(manifest, buildUrl, assetVersion, ui) {
    var sha = typeof manifest.sha256 === "string" && /^[0-9a-f]{64}$/i.test(manifest.sha256) ? manifest.sha256.toLowerCase() : "";
    if (!sha || !manifest.file) return downloadToMemory(manifest, buildUrl, assetVersion, ui, null, false);
    var folder = absolute(buildUrl + "/");
    var key = absolute(buildUrl + "/" + manifest.file + "?sha256=" + sha);
    return openCache().then(function (cache) {
      if (!cache) return downloadToMemory(manifest, buildUrl, assetVersion, ui, null, false);
      var store = { cache: cache, key: key, sha: sha };
      var fresh = /[?&]freshdata=1\b/.test(window.location.search);
      return (fresh ? cache.delete(key).catch(noop).then(function () { return null; }) : findSaved(cache, key, manifest, ui))
        .then(function (saved) {
          if (saved) { removeOtherBuilds(cache, folder, key); return saved; }
          return removeOtherBuilds(cache, folder, key)
            .then(function () { return hasRoomFor(manifest.bytes || 0); })
            .then(function (room) {
              if (!room) {
                console.warn("[data] not enough storage to keep the Solar System on this device; loading it without saving.");
                return downloadToMemory(manifest, buildUrl, assetVersion, ui, null, false);
              }
              return downloadIntoCache(store, manifest, buildUrl, assetVersion, ui).catch(function (error) {
                console.warn("[data] could not save the Solar System on this device (" + describe(error) + "); loading it without saving.");
                var checksum = !!(error && error.metabookChecksum);
                return cache.delete(key).catch(noop).then(function () {
                  return downloadToMemory(manifest, buildUrl, assetVersion, ui, store, checksum);
                });
              });
            });
        });
    });
  }

  function openCache() {
    try {
      if (typeof caches === "undefined" || !caches || typeof ReadableStream === "undefined") return Promise.resolve(null);
      return caches.open(CACHE_NAME).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function findSaved(cache, key, manifest, ui) {
    return cache.match(key).then(function (response) {
      if (!response) return null;
      return response.blob().then(function (blob) {
        if (manifest.bytes > 0 && blob.size !== manifest.bytes) {
          return cache.delete(key).catch(noop).then(function () { return null; });
        }
        ui.bar(0.1);
        ui.status("Opening Solar System saved on this device…");
        return { blob: blob, fromCache: true, cache: cache, key: key };
      });
    }).catch(function () { return null; });
  }

  // Older builds of this player saved in the same folder: only one is ever kept.
  function removeOtherBuilds(cache, folder, key) {
    return cache.keys().then(function (requests) {
      return Promise.all(requests.map(function (request) {
        if (request.url !== key && request.url.indexOf(folder) === 0) return cache.delete(request).catch(noop);
      }));
    }).catch(noop);
  }

  function hasRoomFor(bytes) {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(true);
      return navigator.storage.estimate().then(function (estimate) {
        if (!estimate || !estimate.quota) return true;
        return estimate.quota - (estimate.usage || 0) > bytes * 1.2 + 32 * 1024 * 1024;
      }, function () { return true; });
    } catch (e) {
      return Promise.resolve(true);
    }
  }

  // The parts flow into the saved copy as they arrive (the cache pulls, so a
  // slow disk slows the download instead of piling pieces up in memory).
  function downloadIntoCache(store, manifest, buildUrl, assetVersion, ui) {
    var source = partReader(manifest, buildUrl, assetVersion, false);
    var meter = downloadMeter(manifest.bytes || 0, ui);
    var hash = new Sha256();
    var body = new ReadableStream({
      pull: function (controller) {
        return source.read().then(function (result) {
          if (result.done) { controller.close(); return; }
          hash.update(result.value);
          meter.add(result.value.byteLength);
          controller.enqueue(result.value);
        });
      },
      cancel: function () { source.cancel(); }
    });
    return store.cache.put(store.key, new Response(body, { headers: { "Content-Type": "application/octet-stream" } }))
      .then(function () {
        checkLength(manifest, meter.received());
        if (hash.hex() !== store.sha) {
          var mismatch = new Error("the downloaded data does not match its sha256");
          mismatch.metabookChecksum = true;
          throw mismatch;
        }
        return store.cache.match(store.key);
      })
      .then(function (saved) {
        if (!saved) throw new Error("the saved copy could not be read back");
        return saved.blob();
      })
      .then(function (blob) {
        if (manifest.bytes > 0 && blob.size !== manifest.bytes) throw new Error("the saved copy has the wrong size");
        return { blob: blob, fromCache: false, cache: store.cache, key: store.key };
      });
  }

  // The way it always worked: the pieces are joined in memory. With a store
  // (saving by stream failed) the joined file is still saved when it checks out.
  function downloadToMemory(manifest, buildUrl, assetVersion, ui, store, reload) {
    var source = partReader(manifest, buildUrl, assetVersion, reload);
    var meter = downloadMeter(manifest.bytes || 0, ui);
    var hash = store ? new Sha256() : null;
    var chunks = [];
    return (function next() {
      return source.read().then(function (result) {
        if (result.done) return;
        chunks.push(result.value);
        if (hash) hash.update(result.value);
        meter.add(result.value.byteLength);
        return next();
      });
    })().then(function () {
      checkLength(manifest, meter.received());
      var blob = new Blob(chunks, { type: "application/octet-stream" });
      chunks.length = 0;
      if (hash) {
        if (hash.hex() === store.sha) {
          store.cache.put(store.key, new Response(blob, { headers: { "Content-Type": "application/octet-stream" } }))
            .catch(function (error) { console.warn("[data] not saved on this device: " + describe(error)); });
        } else {
          console.warn("[data] the downloaded data does not match its sha256; not saved on this device.");
        }
      }
      return { blob: blob, fromCache: false, cache: null, key: null };
    });
  }

  // Reads the parts in order as one stream of pieces. Before each piece the page
  // is asked whether the download may go on (window.metabookDownloadHold gives a
  // promise while the opening film is short of data, and the film comes first).
  function partReader(manifest, buildUrl, assetVersion, reload) {
    var index = 0, reader = null;
    function read() {
      var hold = typeof window.metabookDownloadHold === "function" ? window.metabookDownloadHold() : null;
      if (hold && typeof hold.then === "function") return hold.then(read);
      if (reader) {
        return reader.read().then(function (result) {
          if (!result.done) return result;
          reader = null;
          return read();
        });
      }
      if (index >= manifest.parts.length) return Promise.resolve({ done: true });
      return openPart(buildUrl, manifest.parts[index++], assetVersion, reload).then(function (opened) { reader = opened; return read(); });
    }
    return {
      read: read,
      cancel: function () { try { if (reader && reader.cancel) reader.cancel(); } catch (e) {} }
    };
  }

  function openPart(buildUrl, name, assetVersion, reload) {
    return fetch(buildUrl + "/" + name + assetVersion, reload ? { cache: "reload" } : undefined).then(function (response) {
      if (!response.ok) throw new Error("Data part " + name + " failed: HTTP " + response.status);
      if (response.body && response.body.getReader) return response.body.getReader();
      return response.arrayBuffer().then(function (buffer) {   // browsers without response streams
        var given = false;
        return {
          read: function () {
            if (given) return Promise.resolve({ done: true, value: undefined });
            given = true;
            return Promise.resolve({ done: false, value: new Uint8Array(buffer) });
          },
          cancel: noop
        };
      });
    });
  }

  function checkLength(manifest, received) {
    var total = manifest.bytes || 0;
    if (total > 0 && received !== total) throw new Error("Data parts incomplete: " + received + " of " + total + " bytes.");
  }

  // A gzip build is unpacked by the browser itself; the loader then finds
  // plain data (no Unity compression marker) and uses it as it is. The
  // current Brotli build starts with Unity's own header and passes through.
  function unpackIfGzip(blob, ui) {
    try {
      if (typeof DecompressionStream !== "function" || typeof blob.stream !== "function" || typeof blob.arrayBuffer !== "function") return Promise.resolve(blob);
      return blob.slice(0, 2).arrayBuffer().then(function (head) {
        var bytes = new Uint8Array(head);
        if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return blob;
        ui.status("Unpacking Solar System…");
        var started = Date.now();
        return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob().then(function (plain) {
          console.log("[data] unpacked " + blob.size + " -> " + plain.size + " bytes in the browser in " + (Date.now() - started) + " ms");
          return plain;
        });
      }).catch(function (error) {
        console.warn("[data] the browser could not unpack the data (" + describe(error) + "); the loader will.");
        return blob;
      });
    } catch (e) {
      return Promise.resolve(blob);
    }
  }

  // ------------------------------------------------------------ the loader
  // The page's progress callback fills the whole bar from 0 again, so after a
  // download the bar used to jump back from 90%; the loader's share is mapped
  // onto what is left. Its last step (Unity unpacking and starting the data)
  // reports nothing for several seconds, so the bar eases on there. Once the
  // player has the data the blob: URL is released (a joined copy would
  // otherwise sit in memory for the whole lesson), and a saved copy that does
  // not start the player is dropped.
  function watchPlayerStart(ui, data, dataUrl, dataBytes) {
    var original = window.createUnityInstance;
    if (typeof original !== "function" || original.metabookWrapped) return;
    var wrapper = function (canvas, config, onProgress) {
      try { window.createUnityInstance = original; } catch (e) {}
      var from = Math.min(ui.fraction(), DOWNLOAD_SHARE);
      var creepTimer = null, released = false;
      var release = function () {
        if (released) return;
        released = true;
        try { URL.revokeObjectURL(dataUrl); } catch (e) {}
      };
      var stopCreep = function () { if (creepTimer) { clearInterval(creepTimer); creepTimer = null; } };
      var startCreep = function () {
        if (creepTimer) return;
        var started = Date.now();
        var base = from + (1 - from) * 0.9;
        var expect = Math.max(4, (dataBytes || 0) / 25e6);   // Unity's JavaScript Brotli decoder: ~30 MB/s on a desktop
        ui.status("Unpacking Solar System…");
        creepTimer = setInterval(function () {
          var t = (Date.now() - started) / 1000;
          ui.bar(base + (0.99 - base) * (1 - Math.exp(-t / expect)));
          if (t > expect * 1.5) ui.status("Starting Solar System…");
        }, 250);
      };
      var report = function (progress) {
        if (progress >= 0.9) release();   // every download the loader makes has finished
        if (progress >= 0.9 && progress < 1) { startCreep(); return; }
        if (progress >= 1) stopCreep();
        if (onProgress) onProgress(from + (1 - from) * progress);
      };
      var started;
      try {
        started = original.call(this, canvas, config, report);
      } catch (error) {
        stopCreep();
        throw error;
      }
      if (!started || typeof started.then !== "function") return started;
      return started.then(function (instance) {
        stopCreep();
        release();
        return instance;
      }, function (error) {
        stopCreep();
        release();
        if (data.fromCache && data.cache && data.key) {
          console.warn("[data] the saved Solar System did not start; it will be downloaded again on the next visit.");
          data.cache.delete(data.key).catch(noop);
        }
        throw error;
      });
    };
    wrapper.metabookWrapped = true;
    try { window.createUnityInstance = wrapper; } catch (e) {}
  }

  // ------------------------------------------------------------ the bar
  function loadingUi(loadingStatus, progressBarFull) {
    var shown = 0;
    return {
      bar: function (fraction) {
        shown = Math.max(0, Math.min(1, fraction));
        if (progressBarFull) progressBarFull.style.width = (shown * 100) + "%";
      },
      fraction: function () { return shown; },
      status: function (text) { if (loadingStatus) loadingStatus.textContent = text; }
    };
  }

  function downloadMeter(total, ui) {
    var received = 0, started = Date.now(), painted = 0;
    return {
      add: function (bytes) {
        received += bytes;
        var now = Date.now();
        if (now - painted < 100 && (total <= 0 || received < total)) return;   // painting every 64 KB piece costs more than it shows
        painted = now;
        if (total <= 0) { ui.status("Downloading Solar System · " + megabytes(received) + " MB"); return; }
        var fraction = Math.min(1, received / total);
        ui.bar(fraction * DOWNLOAD_SHARE);
        var text = "Downloading Solar System · " + Math.round(fraction * 100) + "% · " + megabytes(received) + " of " + megabytes(total) + " MB";
        var seconds = (now - started) / 1000;
        if (seconds > 3 && fraction < 1) {
          var left = (total - received) / (received / seconds);
          if (left >= 5) text += " · " + (left < 90 ? "about " + Math.ceil(left / 5) * 5 + " s left" : "about " + Math.round(left / 60) + " min left");
        }
        ui.status(text);
      },
      received: function () { return received; }
    };
  }

  function megabytes(bytes) { return Math.round(bytes / 1e6); }

  function absolute(url) {
    try { return new URL(url, document.baseURI).href; } catch (e) { return url; }
  }

  function describe(error) { return error && error.message ? error.message : String(error); }

  // ------------------------------------------------------------ sha256
  // A streaming SHA-256: each piece is hashed as it arrives, so checking the
  // file needs no second copy of it (crypto.subtle.digest takes the whole
  // buffer at once, which a tablet cannot spare). ~250 MB/s on a desktop.
  var SHA256_K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function Sha256() {
    this.state = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.words = new Int32Array(64);
    this.tail = new Uint8Array(64);
    this.tailLength = 0;
    this.length = 0;
  }

  Sha256.prototype.blocks = function (bytes, offset, end) {
    var w = this.words, s = this.state, k = SHA256_K;
    var h0 = s[0], h1 = s[1], h2 = s[2], h3 = s[3], h4 = s[4], h5 = s[5], h6 = s[6], h7 = s[7];
    var p;
    for (p = offset; p + 64 <= end; p += 64) {
      var i, t1, t2, x, y;
      for (i = 0; i < 16; i++) {
        var q = p + i * 4;
        w[i] = (bytes[q] << 24) | (bytes[q + 1] << 16) | (bytes[q + 2] << 8) | bytes[q + 3];
      }
      for (i = 16; i < 64; i++) {
        x = w[i - 15]; y = w[i - 2];
        w[i] = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3))
          + w[i - 7]
          + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))
          + w[i - 16] | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        t1 = h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)))
          + ((e & f) ^ (~e & g)) + k[i] + w[i] | 0;
        t2 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)))
          + ((a & b) ^ (a & c) ^ (b & c)) | 0;
        h = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
      }
      h0 = h0 + a | 0; h1 = h1 + b | 0; h2 = h2 + c | 0; h3 = h3 + d | 0;
      h4 = h4 + e | 0; h5 = h5 + f | 0; h6 = h6 + g | 0; h7 = h7 + h | 0;
    }
    s[0] = h0; s[1] = h1; s[2] = h2; s[3] = h3; s[4] = h4; s[5] = h5; s[6] = h6; s[7] = h7;
    return p;
  };

  Sha256.prototype.update = function (bytes) {
    var offset = 0, end = bytes.length;
    this.length += end;
    if (this.tailLength > 0) {
      var take = Math.min(64 - this.tailLength, end);
      this.tail.set(bytes.subarray(0, take), this.tailLength);
      this.tailLength += take;
      offset = take;
      if (this.tailLength < 64) return;
      this.blocks(this.tail, 0, 64);
      this.tailLength = 0;
    }
    offset = this.blocks(bytes, offset, end);
    if (offset < end) {
      this.tail.set(bytes.subarray(offset, end), 0);
      this.tailLength = end - offset;
    }
  };

  Sha256.prototype.hex = function () {
    var bits = this.length * 8;
    var pad = new Uint8Array((this.tailLength < 56 ? 64 : 128) - this.tailLength);
    pad[0] = 0x80;
    var high = Math.floor(bits / 4294967296), low = bits >>> 0, n = pad.length;
    pad[n - 8] = high >>> 24; pad[n - 7] = high >>> 16; pad[n - 6] = high >>> 8; pad[n - 5] = high;
    pad[n - 4] = low >>> 24; pad[n - 3] = low >>> 16; pad[n - 2] = low >>> 8; pad[n - 1] = low;
    var length = this.length;
    this.update(pad);
    this.length = length;
    var out = "";
    for (var i = 0; i < 8; i++) out += ("00000000" + (this.state[i] >>> 0).toString(16)).slice(-8);
    return out;
  };

  window.metabookSha256 = Sha256;   // for checks from the console (new metabookSha256(), .update(bytes), .hex())
})();
