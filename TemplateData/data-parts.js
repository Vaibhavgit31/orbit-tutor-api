// The Unity data file can be published as parts (GitHub Pages refuses any file
// over 100 MB, and the player's data passed that on 21 Sep 2026). When the
// publisher has split it, Build/data-parts.json lists the pieces; this fetches
// them in order, joins them into one Blob and hands the loader a blob: URL in
// place of the missing file. With no manifest the page loads exactly as before.
// The loader still decompresses the .unityweb content itself (decompression
// fallback), just as it does when the server sends no Content-Encoding.
window.metabookLoadDataParts = function (config, buildUrl, assetVersion, loadingStatus, progressBarFull) {
  var noManifest = {};
  var setStatus = function (text) { if (loadingStatus) loadingStatus.textContent = text; };
  return fetch(buildUrl + "/data-parts.json" + assetVersion, { cache: "no-cache" })
    .then(function (response) { if (!response.ok) throw noManifest; return response.json(); })
    .then(function (manifest) {
      if (!manifest || !manifest.parts || !manifest.parts.length) return;
      var received = 0, total = manifest.bytes || 0, chunks = [];
      var pull = function (name) {
        return fetch(buildUrl + "/" + name + assetVersion).then(function (response) {
          if (!response.ok) throw new Error("Data part " + name + " failed: HTTP " + response.status);
          var reader = response.body && response.body.getReader ? response.body.getReader() : null;
          if (!reader) {
            return response.arrayBuffer().then(function (buffer) { chunks.push(new Uint8Array(buffer)); received += buffer.byteLength; });
          }
          return (function pump() {
            return reader.read().then(function (result) {
              if (result.done) return;
              chunks.push(result.value);
              received += result.value.byteLength;
              if (total > 0) {
                var fraction = Math.min(1, received / total);
                if (progressBarFull) progressBarFull.style.width = (fraction * 90) + "%";
                setStatus("Downloading Solar System · " + Math.round(fraction * 100) + "%");
              }
              return pump();
            });
          })();
        });
      };
      return manifest.parts.reduce(function (chain, name) { return chain.then(function () { return pull(name); }); }, Promise.resolve())
        .then(function () {
          if (total > 0 && received !== total) throw new Error("Data parts incomplete: " + received + " of " + total + " bytes.");
          config.dataUrl = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
          setStatus("Starting Solar System…");
        });
    })
    .catch(function (error) { if (error !== noManifest) throw error; });
};
