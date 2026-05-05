/* MultiLLM RAG Chatbot — Frontend Logic */
(function () {
  "use strict";

  let currentSession = localStorage.getItem("currentSession") || null;
  let currentChat = null;
  let selectedFiles = [];
  let currentChatResults = [];

  // ── Safe DOM selector ────────────────────────────────────────────────────
  const $ = (sel) => { try { return document.querySelector(sel); } catch(e) { return null; } };
  const $$ = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch(e) { return []; } };

  // ── Get DOM refs ─────────────────────────────────────────────────────────
  const sidebar          = $("#sidebar");
  const sidebarToggle    = $("#sidebarToggle");
  const sidebarClose     = $("#sidebarClose");
  const newChatBtn       = $("#newChatBtn");
  const deleteAllChatsBtn= $("#deleteAllChatsBtn");
  const fileList         = $("#fileList");
  const chatHistory      = $("#chatHistory");
  const dropZone         = $("#dropZone");
  const fileInput        = $("#fileInput");
  const browseLabel      = $("#browseLabel");
  const uploadBtn        = $("#uploadBtn");
  const uploadStatus     = $("#uploadStatus");
  const queryInput       = $("#queryInput");
  const queryBtn         = $("#queryBtn");
  const resultsArea      = $("#resultsArea");
  const runBenchmarkChk  = $("#runBenchmark");
  const groundTruthInput = $("#groundTruthInput");
  const groundTruthText  = $("#groundTruthText");

  function setButtonDisabled(btn, disabled) {
    if (!btn) return;
    try { btn.disabled = disabled; } catch(e) {}
  }

  // ── Sidebar toggle ──────────────────────────────────────────────────────
  function toggleSidebar() {
    if (sidebar) sidebar.classList.toggle("collapsed");
    const main = $(".main-content");
    if (main) main.classList.toggle("sidebar-collapsed");
  }
  if (sidebarToggle) sidebarToggle.addEventListener("click", toggleSidebar);
  if (sidebarClose)  sidebarClose.addEventListener("click", toggleSidebar);

  // ── Slider & Input sync ──────────────────────────────────────────────────
  [["#topKSlider","#topK"],["#cosineThresholdSlider","#cosineThreshold"],["#temperatureSlider","#temperature"]].forEach(([s,i]) => {
    const sl = $(s), inp = $(i);
    if (sl && inp) {
      sl.addEventListener("input", () => { inp.value = sl.value; });
      inp.addEventListener("input", () => { sl.value = inp.value; });
    }
  });

  // ── File selection ──────────────────────────────────────────────────────
  if (browseLabel && fileInput) {
    browseLabel.addEventListener("click", (e) => { e.preventDefault(); fileInput.click(); });
  }
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      selectedFiles = [...fileInput.files];
      updateFilePreview();
    });
  }
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault(); dropZone.classList.remove("dragover");
      selectedFiles = [...e.dataTransfer.files];
      updateFilePreview();
    });
  }

  function updateFilePreview() {
    if (!selectedFiles.length) return;
    if (dropZone) {
      dropZone.innerHTML = `<p>${selectedFiles.length} file(s) selected: <strong>${selectedFiles.map(f=>f.name).join(", ")}</strong></p>`;
    }
    setButtonDisabled(uploadBtn, false);
  }

  // ── Upload ──────────────────────────────────────────────────────────────
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      if (!selectedFiles.length) return;
      setButtonDisabled(uploadBtn, true);
      if (uploadStatus) { uploadStatus.className = "status"; uploadStatus.innerHTML = '<span class="loading"></span> Uploading & indexing …'; }

      const fd = new FormData();
      selectedFiles.forEach(f => fd.append("files", f));
      fd.append("text_chunk_size", $("#textChunkSize")?.value || 512);
      fd.append("text_chunk_overlap", $("#textOverlap")?.value || 64);
      fd.append("image_chunk_size", $("#imageChunkSize")?.value || 256);
      if (currentSession) fd.append("session_id", currentSession);

      try {
        const resp = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || "Upload failed");
        currentSession = data.session_id;
        localStorage.setItem("currentSession", currentSession);
        if (uploadStatus) {
          uploadStatus.className = "status success";
          uploadStatus.innerHTML = data.results.map(r =>
            `<b>${r.filename}</b>: ${r.total_chunks} chunks (${r.text_chunks} text, ${r.table_chunks} table, ${r.image_chunks} image)`
          ).join("<br>");
        }
        setButtonDisabled(queryBtn, false);
        refreshSidebar();
      } catch (e) {
        if (uploadStatus) { uploadStatus.className = "status error"; uploadStatus.textContent = e.message; }
        setButtonDisabled(uploadBtn, false);
      }
    });
  }

  // ── Query ───────────────────────────────────────────────────────────────
  if (queryBtn && queryInput) {
    queryBtn.addEventListener("click", sendQuery);
    queryInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQuery(); } });
  }

  async function sendQuery() {
    if (!queryInput) return;
    const query = queryInput.value.trim();
    if (!query || !currentSession) { alert("Please upload files first, then type a question."); return; }
    const selectedModels = $$('input[name="model"]:checked').map(cb => cb.value);
    if (selectedModels.length < 2 || selectedModels.length > 6) { alert("Select between 2 and 6 models"); return; }

    setButtonDisabled(queryBtn, true);
    if (resultsArea) resultsArea.innerHTML = '<div class="card"><span class="loading"></span> Comparing models …</div>';

    const fd = new FormData();
    fd.append("query", query);
    fd.append("session_id", currentSession);
    fd.append("models", selectedModels.join(","));
    fd.append("top_k", $("#topK")?.value || 5);
    fd.append("cosine_threshold", $("#cosineThreshold")?.value || 0);
    fd.append("temperature", $("#temperature")?.value || 0.3);

    try {
      const resp = await fetch("/api/query", { method: "POST", body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Query failed");
      currentSession = data.session_id;
      localStorage.setItem("currentSession", currentSession);
      currentChat = data.chat;
      await renderResults(data.chat);
      refreshSidebar();
    } catch (e) {
      if (resultsArea) resultsArea.innerHTML = `<div class="card status error">${escHtml(e.message)}</div>`;
    }
    setButtonDisabled(queryBtn, false);
  }

  // ── Render Results ──────────────────────────────────────────────────────
  async function renderResults(chat) {
    if (!resultsArea || !chat) return;

    // Load ratings to sort by user score
    let ratings = {};
    try {
      const rr = await fetch(`/api/ratings/${chat.id}`);
      if (rr.ok) { const rd = await rr.json(); (rd.ratings||[]).forEach(r => { if (r.score) ratings[r.model_id] = r.score; }); }
    } catch(_) {}

    const sortedResults = (chat.results || []).map(r => ({ ...r, userScore: ratings[r.model] || 0 }))
      .sort((a, b) => b.userScore - a.userScore);
    currentChatResults = sortedResults;

    let html = `<div class="card"><h2>Question</h2><p>${escHtml(chat.query)}</p>`;
    html += `<p class="muted">${chat.timestamp ? new Date(chat.timestamp).toLocaleString() : ''} &middot; Models: ${(chat.models||[]).join(", ")}</p></div>`;
    html += `<div class="models-grid">`;
    for (const r of sortedResults) html += renderModelCard(r, chat.id);
    html += `</div>`;
    resultsArea.innerHTML = html;

    // Recompute benchmark scores if benchmark is active and ground truth is set
    applyBenchmarkVisibility();
    // Also re-run when user edits the ground truth textarea
    if (groundTruthText && !groundTruthText._listenerAttached) {
      groundTruthText.addEventListener("input", applyBenchmarkVisibility);
      groundTruthText._listenerAttached = true;
    }
  }

  function renderModelCard(result, chatId) {
    let html = `<div class="model-card" data-model="${escHtml(result.model)}">`;
    html += `<h3>${escHtml(result.model)}`;
    if (result.userScore) html += ` <span class="user-score-badge">Score: ${result.userScore}/10</span>`;
    html += `</h3>`;
    if (result.error) {
      html += `<p class="status error">${escHtml(result.error)}</p>`;
    } else {
      html += `<div class="answer-text">${escHtml(result.answer)}</div>`;
      html += `<p class="muted">Latency: ${result.latency_s?.toFixed(2) || "?"}s</p>`;

      // Benchmark badges (hidden by default)
      const bench = result.benchmark || {};
      html += `<div class="metrics-row bench-scores" style="display:none;">`;
      html += `<div class="metric-badge" title="Word n-gram overlap vs all other models">BLEU: ${(bench.bleu||0).toFixed(2)}</div>`;
      html += `<div class="metric-badge" title="Longest-subsequence similarity vs all other models">ROUGE: ${(bench.rouge||0).toFixed(2)}</div>`;
      html += `</div>`;

      // Rating section
      html += `<div class="rating-section"><label>Rate this answer:</label><div class="rating-controls">`;
      html += `<div class="rating-slider">`;
      const initScore = result.userScore || 5;
      html += `<input type="range" min="1" max="10" value="${initScore}" class="score-slider" data-chat="${chatId}" data-model="${escHtml(result.model)}">`;
      html += `<span class="score-display">${initScore}</span>`;
      html += `<button class="btn-submit-score" data-chat="${chatId}" data-model="${escHtml(result.model)}">Submit</button>`;
      html += `</div>`;
      html += `<div class="thumbs">`;
      html += `<button class="thumb-btn thumb-up" data-chat="${chatId}" data-model="${escHtml(result.model)}" data-rating="thumbs_up" title="Good answer">GOOD</button>`;
      html += `<button class="thumb-btn thumb-down" data-chat="${chatId}" data-model="${escHtml(result.model)}" data-rating="thumbs_down" title="Bad answer">BAD</button>`;
      html += `</div></div></div>`;

      if (result.sources && result.sources.length) {
        html += `<div class="sources"><b>Retrieved from:</b>`;
        result.sources.slice(0,3).forEach(s => { html += `<span class="source-tag">${escHtml(s.source)} p.${s.page}</span>`; });
        html += `</div>`;
      }
    }
    html += `</div>`;
    return html;
  }

  function applyBenchmarkVisibility() {
    const active = runBenchmarkChk && runBenchmarkChk.checked;
    const gt = groundTruthText ? groundTruthText.value.trim() : "";
    if (active && gt) {
      // Recompute scores against the pasted ground truth
      $$(".model-card").forEach(card => {
        const modelName = card.dataset.model;
        const result = currentChatResults.find(r => r.model === modelName);
        if (!result || !result.answer) return;
        const bleu = simpleBLEU(gt, result.answer);
        const rouge = simpleROUGE(gt, result.answer);
        const row = card.querySelector(".bench-scores");
        if (row) {
          row.querySelector(".metric-badge:nth-child(1)").textContent = `BLEU: ${bleu.toFixed(2)}`;
          row.querySelector(".metric-badge:nth-child(2)").textContent = `ROUGE: ${rouge.toFixed(2)}`;
          row.style.display = "flex";
        }
      });
    } else {
      $$(".bench-scores").forEach(el => { el.style.display = "none"; });
    }
  }

  // ── Benchmark toggle (inside query section) ─────────────────────────────
  if (runBenchmarkChk) {
    runBenchmarkChk.addEventListener("change", () => {
      if (groundTruthInput) groundTruthInput.style.display = runBenchmarkChk.checked ? "block" : "none";
      // If unchecked, hide all score rows and clear the textarea
      if (!runBenchmarkChk.checked) {
        $$(".bench-scores").forEach(el => { el.style.display = "none"; });
        if (groundTruthText) groundTruthText.value = "";
      }
    });
  }

  // Client-side scoring helpers for ground-truth recompute
  function simpleBLEU(ref, cand) {
    const r = ref.toLowerCase().split(/\s+/), c = cand.toLowerCase().split(/\s+/);
    if (!c.length || !r.length) return 0;
    const rCnt = {}, cCnt = {};
    r.forEach(w => { rCnt[w] = (rCnt[w]||0)+1; });
    c.forEach(w => { cCnt[w] = (cCnt[w]||0)+1; });
    let overlap = 0;
    Object.keys(cCnt).forEach(w => { if (rCnt[w]) overlap += Math.min(cCnt[w], rCnt[w]); });
    return Math.min(overlap / c.length, 1.0);
  }
  function simpleROUGE(ref, cand) {
    const r = ref.toLowerCase().split(/\s+/), c = cand.toLowerCase().split(/\s+/);
    if (!r.length || !c.length) return 0;
    // LCS length
    const m = r.length, n = c.length;
    const dp = Array.from({length:m+1}, () => new Array(n+1).fill(0));
    for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
      dp[i][j] = r[i-1]===c[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
    return dp[m][n] / Math.max(m, n);
  }

  // ── Rating handlers ─────────────────────────────────────────────────────
  if (resultsArea) {
    resultsArea.addEventListener("input", (e) => {
      if (e.target.classList.contains("score-slider")) {
        const disp = e.target.parentElement.querySelector(".score-display");
        if (disp) disp.textContent = e.target.value;
      }
    });
    resultsArea.addEventListener("click", async (e) => {
      if (e.target.classList.contains("btn-submit-score")) {
        const chatId = e.target.dataset.chat, modelId = e.target.dataset.model;
        const slider = e.target.parentElement.querySelector(".score-slider");
        await submitRating(chatId, modelId, "score", slider ? parseInt(slider.value) : 5);
        e.target.textContent = "Saved";
        setTimeout(() => { e.target.textContent = "Submit"; }, 2000);
      }
      if (e.target.classList.contains("thumb-btn")) {
        const chatId = e.target.dataset.chat, modelId = e.target.dataset.model, ratingType = e.target.dataset.rating;
        await submitRating(chatId, modelId, ratingType, null);
        if (ratingType === "thumbs_up") {
          $$(".model-card").forEach(card => { if (card.dataset.model !== modelId) card.style.display = "none"; });
        }
      }
    });
  }

  async function submitRating(chatId, modelId, ratingType, score) {
    const fd = new FormData();
    fd.append("chat_id", chatId); fd.append("model_id", modelId); fd.append("rating_type", ratingType);
    if (score !== null) fd.append("score", score);
    try { await fetch("/api/rate", { method: "POST", body: fd }); } catch(e) {}
  }

  // ── Sidebar refresh ─────────────────────────────────────────────────────
  async function refreshSidebar() {
    if (!currentSession) {
      if (fileList) fileList.innerHTML = "";
      if (chatHistory) chatHistory.innerHTML = "";
      return;
    }
    try {
      const resp = await fetch(`/api/session/${currentSession}`);
      if (!resp.ok) {
        // Session no longer exists — clear stale localStorage
        if (resp.status === 404) { localStorage.removeItem("currentSession"); currentSession = null; }
        return;
      }
      const sess = await resp.json();
      if (fileList) {
        fileList.innerHTML = "";
        (sess.files || []).forEach(f => {
          const li = document.createElement("li");
          const a = document.createElement("a");
          a.href = `/download/${encodeURIComponent(f.filename || f)}`;
          a.download = f.filename || f;
          a.textContent = f.filename || f;
          a.className = "file-link";
          li.appendChild(a); fileList.appendChild(li);
        });
      }
      if (chatHistory) {
        chatHistory.innerHTML = "";
        (sess.chats || []).forEach(c => {
          const li = document.createElement("li");
          const preview = c.query.substring(0, 35) + (c.query.length > 35 ? "…" : "");
          const ts = c.timestamp ? new Date(c.timestamp).toLocaleString() : "";

          const textSpan = document.createElement("span");
          textSpan.className = "chat-item-text";
          textSpan.textContent = preview;
          textSpan.title = `${c.query}\n${ts}`;
          textSpan.addEventListener("click", () => renderResults(c));

          const actions = document.createElement("div");
          actions.className = "chat-actions";

          const renBtn = document.createElement("button");
          renBtn.className = "btn-action btn-rename"; renBtn.textContent = "✎"; renBtn.title = "Rename";
          renBtn.addEventListener("click", (e) => { e.stopPropagation(); renameChat(c.id, c.query); });

          const delBtn = document.createElement("button");
          delBtn.className = "btn-action btn-delete"; delBtn.textContent = "✕"; delBtn.title = "Delete";
          delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteChat(c.id); });

          actions.appendChild(renBtn); actions.appendChild(delBtn);
          li.appendChild(textSpan); li.appendChild(actions);
          chatHistory.appendChild(li);
        });
      }
    } catch(_) {}
  }

  // ── New chat ─────────────────────────────────────────────────────────────
  if (newChatBtn) {
    newChatBtn.addEventListener("click", () => {
      // Keep the session alive in localStorage so sidebar history is preserved.
      // Just reset the work area: upload state, results, query input.
      currentChat = null; selectedFiles = []; currentChatResults = [];
      if (dropZone) dropZone.innerHTML = '<p>Drop files here (PDF, DOCX, TXT, etc.) or <label class="link" id="browseLabel">browse</label></p>';
      // Re-bind browse label after innerHTML reset
      const newBrowse = $("#browseLabel");
      if (newBrowse && fileInput) newBrowse.addEventListener("click", (e) => { e.preventDefault(); fileInput.click(); });
      if (fileInput) fileInput.value = "";
      if (queryInput) queryInput.value = "";
      setButtonDisabled(uploadBtn, true);
      if (resultsArea) resultsArea.innerHTML = "";
      if (uploadStatus) uploadStatus.innerHTML = "";
      // Hide benchmark scores on new chat
      $$(".bench-scores").forEach(el => { el.style.display = "none"; });
      // Sidebar stays unchanged — history is preserved
    });
  }

  // ── Delete all chats ─────────────────────────────────────────────────────
  if (deleteAllChatsBtn) {
    deleteAllChatsBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!currentSession || !confirm("Delete all chats in this session?")) return;
      try {
        const resp = await fetch(`/api/session/${currentSession}/delete_all_chats`, { method: "POST" });
        if (!resp.ok) throw new Error("Failed");
        if (resultsArea) resultsArea.innerHTML = "";
        $$(".bench-scores").forEach(el => { el.style.display = "none"; });
        refreshSidebar();
      } catch(e) { alert(`Error: ${e.message}`); }
    });
  }

  async function deleteChat(chatId) {
    if (!confirm("Delete this chat?")) return;
    try {
      const resp = await fetch(`/api/chat/${chatId}`, { method: "DELETE" });
      if (!resp.ok) throw new Error("Failed");
      if (currentChat && currentChat.id === chatId) { if (resultsArea) resultsArea.innerHTML = ""; currentChat = null; }
      refreshSidebar();
    } catch(e) { alert(`Error: ${e.message}`); }
  }

  function renameChat(chatId, currentQuery) {
    prompt("Note: editing here is display-only.", currentQuery);
  }

  function escHtml(s) { const d = document.createElement("div"); d.textContent = String(s||""); return d.innerHTML; }

  // ── Init ────────────────────────────────────────────────────────────────
  if (currentSession) { setButtonDisabled(uploadBtn, false); setButtonDisabled(queryBtn, false); }
  refreshSidebar();
})();

