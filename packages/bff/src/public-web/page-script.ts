// The upload page's only script, inlined and allowed by its SHA-256 in the page's CSP (no
// `'unsafe-inline'`, no third-party script, docs/architecture.md §11). Per document it checks type and
// size, asks `POST <page>/presign` for a pre-signed POST, sends the file straight to storage with
// progress (XMLHttpRequest, because `fetch` reports no upload progress) and keeps the returned key;
// "Listo" sends the keys to `POST <page>/done` and shows the confirmation. Texts arrive in the
// `data-texts` attribute (copy.ts); the token is only ever read from the page's own path. Every POST
// to the page carries `x-amz-content-sha256` with the SHA-256 of its body: CloudFront signs the origin
// request (OAC) and Lambda refuses an unsigned body (ADR-0015 §3.1). Plain ES2017 without template
// literals, so it can live in a raw string here.
import { createHash } from "node:crypto";

export const UPLOAD_PAGE_SCRIPT = String.raw`(function () {
  "use strict";
  var root = document.getElementById("upload");
  if (!root) return;
  var texts = JSON.parse(root.getAttribute("data-texts") || "{}");
  var maxBytes = Number(root.getAttribute("data-max-bytes"));
  var base = window.location.pathname.replace(/\/+$/, "");
  var doneButton = document.getElementById("done");
  var doneStatus = document.getElementById("done-status");
  var uploaded = [];
  var busy = 0;

  function refresh() {
    doneButton.disabled = busy > 0 || uploaded.length === 0;
  }

  function show(item, text, state) {
    item.querySelector(".status").textContent = text;
    item.setAttribute("data-state", state);
  }

  function sha256Hex(text) {
    return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buffer) {
      return Array.prototype.map.call(new Uint8Array(buffer), function (byte) { return ("0" + byte.toString(16)).slice(-2); }).join("");
    });
  }

  function postJson(path, body) {
    var payload = JSON.stringify(body);
    return sha256Hex(payload).then(function (hash) {
      return fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-amz-content-sha256": hash },
        body: payload,
        credentials: "omit",
        cache: "no-store"
      });
    }).then(function (response) {
      return response.json().then(
        function (data) { return { status: response.status, data: data }; },
        function () { return { status: response.status, data: null }; }
      );
    });
  }

  function errorText(status) {
    if (status === 413) return texts.tooLarge;
    if (status === 415) return texts.notPdf;
    if (status === 409) return texts.limit;
    if (status === 404 || status === 410) return texts.linkGone;
    return texts.failed;
  }

  function sendFile(presigned, file, progress) {
    return new Promise(function (resolve, reject) {
      var form = new FormData();
      Object.keys(presigned.fields).forEach(function (name) { form.append(name, presigned.fields[name]); });
      form.append("file", file);
      var request = new XMLHttpRequest();
      request.open("POST", presigned.url);
      request.upload.onprogress = function (event) {
        if (event.lengthComputable) progress.value = Math.round((event.loaded / event.total) * 100);
      };
      request.onload = function () {
        if (request.status >= 200 && request.status < 300) resolve(); else reject(0);
      };
      request.onerror = function () { reject(0); };
      request.send(form);
    });
  }

  function isPdf(file) {
    return file.type === "application/pdf" || (file.type === "" && /\.pdf$/i.test(file.name));
  }

  function upload(item, input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size === 0) return show(item, texts.empty, "error");
    if (file.size > maxBytes) return show(item, texts.tooLarge, "error");
    if (!isPdf(file)) return show(item, texts.notPdf, "error");
    var progress = item.querySelector("progress");
    busy += 1;
    refresh();
    input.disabled = true;
    progress.value = 0;
    progress.hidden = false;
    show(item, texts.uploading, "uploading");
    postJson("/presign", { docType: item.getAttribute("data-doc-type"), size: file.size, contentType: "application/pdf" })
      .then(function (answer) {
        if (answer.status !== 200 || !answer.data || !answer.data.ok) throw answer.status;
        return sendFile(answer.data, file, progress).then(function () { return answer.data.key; });
      })
      .then(function (key) {
        uploaded.push(key);
        show(item, texts.uploaded, "uploaded");
      }, function (status) {
        show(item, errorText(typeof status === "number" ? status : 0), "error");
      })
      .then(function () {
        busy -= 1;
        input.disabled = false;
        input.value = "";
        progress.hidden = true;
        refresh();
      });
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-doc-type]"), function (item) {
    var input = item.querySelector("input[type=file]");
    input.addEventListener("change", function () { upload(item, input); });
  });

  doneButton.addEventListener("click", function () {
    if (uploaded.length === 0) return;
    busy += 1;
    refresh();
    doneStatus.textContent = "";
    postJson("/done", { keys: uploaded })
      .then(function (answer) {
        if (answer.status !== 200 || !answer.data || !answer.data.ok) throw answer.status;
        document.getElementById("confirmation-pending").textContent = answer.data.message;
        document.getElementById("form").hidden = true;
        var confirmation = document.getElementById("confirmation");
        confirmation.hidden = false;
        confirmation.focus();
      })
      .catch(function (status) {
        doneStatus.textContent = status === 404 || status === 410 ? texts.linkGone : texts.doneFailed;
      })
      .then(function () {
        busy -= 1;
        refresh();
      });
  });

  refresh();
})();`;

/** `'sha256-…'` source of a CSP directive for an inline element's exact text. */
export function cspHash(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export const UPLOAD_PAGE_SCRIPT_HASH = cspHash(UPLOAD_PAGE_SCRIPT);
