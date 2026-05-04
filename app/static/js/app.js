/* MultiLLM RAG Chatbot — Frontend Logic */
(function () {
  "use strict";

  let currentSession = null;
  let currentChat = null;
  let selectedFiles = [];

  // ── Safe DOM selector ────────────────────────────────────────────────────
  const $ = (sel) => {
    try {
      return document.querySelector(sel);
    } catch (e) {
      console.warn(`querySelector failed for ${sel}:`, e);
      return null;
    }
  };
  const $$ = (sel) => {
    try {
      return [...document.querySelectorAll(sel)];
    } catch (e) {
      console.warn(`querySelectorAll failed for ${sel}:`, e);
      return [];
    }
  };

  // ── Get DOM refs safely ──────────────────────────────────────────────────
  const sidebar       = $("#sidebar") || { classList: { toggle: () => {} } };
  const sidebarToggle = $("#sidebarToggle");
  const newSessionBtn = $("#newSessionBtn");
  const sessionList   = $("#sessionList");
  const fileList      = $("#fileList");
  const chatHistory   = $("#chatHistory");

  const dropZone   = $("#dropZone");
  const fileInput  = $("#fileInput");
  const uploadBtn  = $("#uploadBtn");
  const uploadStatus = $("#uploadStatus");

  const queryInput = $("#queryInput");
  const queryBtn   = $("#queryBtn");
  const resultsArea = $("#resultsArea");

  // ── Safe button state setter ─────────────────────────────────────────────
  function setButtonDisabled(btn, disabled) {
    if (!btn) return;
    try {
      btn.disabled = disabled;
    } catch (e) {
      console.error("Failed to set button disabled state:", e);
    }
  }

  // ── Slider & Input Sync ─────────────────────────────────────────────────
  const sliderPairs = [
    { slider: "#topKSlider", input: "#topK" },
    { slider: "#cosineThresholdSlider", input: "#cosineThreshold" },
    { slider: "#temperatureSlider", input: "#temperature" }
  ];

  sliderPairs.forEach(pair => {
    const slider = $(pair.slider);
    const input = $(pair.input);
    if (slider && input) {
      slider.addEventListener("input", () => { input.value = slider.value; });
      input.addEventListener("input", () => { slider.value = input.value; });
    }
  });

  // ── Sidebar toggle ──────────────────────────────────────────────────────
  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => sidebar.classList.toggle("open"));
  }

  // ── File selection ──────────────────────────────────────────────────────
  if (dropZone && fileInput) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault(); dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault(); dropZone.classList.remove("dragover");
      selectedFiles = [...e.dataTransfer.files];
      updateFilePreview();
    });
    fileInput.addEventListener("change", () => {
      selectedFiles = [...fileInput.files];
      updateFilePreview();
    });
  }

  function updateFilePreview() {
    if (selectedFiles.length && dropZone) {
      dropZone.innerHTML = `<p>${selectedFiles.length} file(s) selected: ${selectedFiles.map(f=>f.name).join(", ")}</p>`;
      setButtonDisabled(uploadBtn, false);
    }
  }

  // ── Upload ──────────────────────────────────────────────────────────────
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      if (!selectedFiles.length) return;
      setButtonDisabled(uploadBtn, true);
      if (uploadStatus) {
        uploadStatus.className = "status";
        uploadStatus.innerHTML = '<span class="loading"></span> Uploading & indexing …';
      }

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
        if (uploadStatus) {
          uploadStatus.className = "status success";
          let summary = data.results.map(r =>
            `<b>${r.filename}</b>: ${r.total_chunks} chunks (${r.text_chunks} text, ` +
            `${r.table_chunks} table, ${r.image_chunks} image)`
          ).join("<br>");
          uploadStatus.innerHTML = summary;
        }
        setButtonDisabled(queryBtn, false);
        refreshSidebar();
      } catch (e) {
        if (uploadStatus) {
          uploadStatus.className = "status error";
          uploadStatus.textContent = e.message;
        }
        setButtonDisabled(uploadBtn, false);
      }
    });
  }

  // ── Query ───────────────────────────────────────────────────────────────
  if (queryBtn && queryInput) {
    queryBtn.addEventListener("click", sendQuery);
    queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQuery(); }
    });
  }

  async function sendQuery() {
    if (!queryInput) return;
    const query = queryInput.value.trim();
    if (!query || !currentSession) return;

    const selectedModels = $$('input[name="model"]:checked').map(cb => cb.value);
    if (!selectedModels.length) { alert("Select at least 2 models"); return; }
    if (selectedModels.length < 2 || selectedModels.length > 6) {
      alert("Select between 2 and 6 models");
      return;
    }

    setButtonDisabled(queryBtn, true);
    if (resultsArea) {
      resultsArea.innerHTML = '<div class="card"><span class="loading"></span> Comparing models …</div>';
    }

    const fd = new FormData();
    fd.append("query", query);
    fd.append("session_id", currentSession);
    fd.append("models", selectedModels.join(","));
    fd.append("top_k", ($("#topK")?.value || 5));
    fd.append("cosine_threshold", ($("#cosineThreshold")?.value || 0));
    fd.append("temperature", ($("#temperature")?.value || 0.3));

    try {
      const resp = await fetch("/api/query", { method: "POST", body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Query failed");
      currentChat = data.chat;
      renderResults(data.chat);
      refreshSidebar();
    } catch (e) {
      if (resultsArea) resultsArea.innerHTML = `<div class="card status error">${e.message}</div>`;
    }
    setButtonDisabled(queryBtn, false);
  }

  function renderResults(chat) {
    if (!resultsArea) return;
    let html = `<div class="card"><h2>Question</h2><p>${escHtml(chat.query)}</p>`;
    html += `<p class="muted">${chat.timestamp} · Comparing: ${chat.models.join(", ")}</p></div>`;

    html += `<div class="models-grid">`;
    for (const r of chat.results) {
      html += renderModelCard(r, chat.id);
    }
    html += `</div>`;
    resultsArea.innerHTML = html;
  }

  function renderModelCard(result, chatId) {
    let html = `<div class="model-card">`;
    html += `<h3>${result.model}</h3>`;
    
    if (result.error) {
      html += `<p class="status error">${result.error}</p>`;
    } else {
      // Answer text
      html += `<div class="answer-text">${escHtml(result.answer)}</div>`;
      
      // Metadata
      html += `<p class="muted">Latency: ${result.latency_s.toFixed(2)}s</p>`;
      
      // Auto-evaluation metrics
      html += `<div class="metrics-row">`;
      html += `<div class="metric-badge" title="How many words match">BLEU: 0.00</div>`;
      html += `<div class="metric-badge" title="Structure similarity">ROUGE: 0.00</div>`;
      html += `<div class="metric-badge" title="Answer accuracy">Faith: 0.00</div>`;
      html += `</div>`;
      
      // Rating section
      html += `<div class="rating-section">`;
      html += `<label>Rate this answer:</label>`;
      html += `<div class="rating-controls">`;
      
      // Slider rating
      html += `<div class="rating-slider">`;
      html += `<input type="range" min="1" max="10" value="5" class="score-slider" data-chat="${chatId}" data-model="${result.model}">`;
      html += `<span class="score-display">5</span>`;
      html += `</div>`;
      
      // Thumbs
      html += `<div class="thumbs">`;
      html += `<button class="thumb-btn thumb-up" data-chat="${chatId}" data-model="${result.model}" data-rating="thumbs_up" title="Good answer">👍</button>`;
      html += `<button class="thumb-btn thumb-down" data-chat="${chatId}" data-model="${result.model}" data-rating="thumbs_down" title="Bad answer">👎</button>`;
      html += `</div>`;
      
      // Score input
      html += `<input type="number" class="score-input" min="0" max="10" placeholder="Score" data-chat="${chatId}" data-model="${result.model}">`;
      html += `</div>`;
      html += `</div>`;
      
      // Sources
      if (result.sources && result.sources.length) {
        html += `<div class="sources">`;
        html += `<b>Retrieved from:</b>`;
        result.sources.slice(0, 3).forEach(s => {
          html += `<span class="source-tag">${s.source} p.${s.page}</span>`;
        });
        html += `</div>`;
      }
    }
    html += `</div>`;
    return html;
  }

  // ── Rating handlers ─────────────────────────────────────────────────────
  if (resultsArea) {
    resultsArea.addEventListener("input", async (e) => {
      if (e.target.classList.contains("score-slider")) {
        const chatId = e.target.dataset.chat;
        const modelId = e.target.dataset.model;
        const score = e.target.value;
        e.target.parentElement.querySelector(".score-display").textContent = score;
        await submitRating(chatId, modelId, "score", parseInt(score));
      }
    });

    resultsArea.addEventListener("click", async (e) => {
      if (e.target.classList.contains("thumb-btn")) {
        const chatId = e.target.dataset.chat;
        const modelId = e.target.dataset.model;
        const ratingType = e.target.dataset.rating;
        await submitRating(chatId, modelId, ratingType, null);
      }
    });

    resultsArea.addEventListener("change", async (e) => {
      if (e.target.classList.contains("score-input")) {
        const chatId = e.target.dataset.chat;
        const modelId = e.target.dataset.model;
        const score = e.target.value;
        if (score) {
          await submitRating(chatId, modelId, "custom", parseInt(score));
          e.target.value = "";
        }
      }
    });
  }

  async function submitRating(chatId, modelId, ratingType, score) {
    const fd = new FormData();
    fd.append("chat_id", chatId);
    fd.append("model_id", modelId);
    fd.append("rating_type", ratingType);
    if (score !== null) fd.append("score", score);

    try {
      await fetch("/api/rate", { method: "POST", body: fd });
    } catch (e) {
      console.error("Rating failed:", e);
    }
  }

  // ── Sidebar refresh ─────────────────────────────────────────────────────
  async function refreshSidebar() {
    try {
      const resp = await fetch("/api/sessions");
      const data = await resp.json();
      if (sessionList) {
        sessionList.innerHTML = "";
        data.sessions.forEach(s => {
          const li = document.createElement("li");
          li.textContent = `${s.id} (${s.files} files)`;
          if (s.id === currentSession) li.classList.add("active");
          li.addEventListener("click", () => loadSession(s.id));
          sessionList.appendChild(li);
        });
      }
    } catch (_) {}

    if (currentSession) {
      try {
        const resp = await fetch(`/api/session/${currentSession}`);
        const sess = await resp.json();
        if (fileList) {
          fileList.innerHTML = "";
          (sess.files || []).forEach(f => {
            const li = document.createElement("li"); 
            li.textContent = f.filename || f;
            fileList.appendChild(li);
          });
        }
        if (chatHistory) {
          chatHistory.innerHTML = "";
          (sess.chats || []).forEach(c => {
            const li = document.createElement("li");
            li.textContent = c.query.substring(0, 40) + (c.query.length > 40 ? "…" : "");
            li.addEventListener("click", () => renderResults(c));
            chatHistory.appendChild(li);
          });
        }
      } catch (_) {}
    }
  }

  async function loadSession(sid) {
    currentSession = sid;
    setButtonDisabled(queryBtn, false);
    refreshSidebar();
  }

  // ── New session ─────────────────────────────────────────────────────────
  if (newSessionBtn) {
    newSessionBtn.addEventListener("click", () => {
      currentSession = null;
      currentChat = null;
      selectedFiles = [];
      if (dropZone) dropZone.innerHTML = '<p>Drop files here (PDF, DOCX, TXT, etc.) or <label class="link" for="fileInput">browse</label></p>';
      if (fileInput) fileInput.value = "";
      setButtonDisabled(uploadBtn, true);
      setButtonDisabled(queryBtn, true);
      if (resultsArea) resultsArea.innerHTML = "";
      if (uploadStatus) uploadStatus.innerHTML = "";
      refreshSidebar();
    });
  }

  function escHtml(s) {
    const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
  }

  // ── Init ────────────────────────────────────────────────────────────────
  console.log("MultiLLM RAG Chatbot initializing...");
  console.log("DOM refs:", {
    sidebar: !!sidebar,
    sidebarToggle: !!sidebarToggle,
    newSessionBtn: !!newSessionBtn,
    dropZone: !!dropZone,
    fileInput: !!fileInput,
    uploadBtn: !!uploadBtn,
    queryBtn: !!queryBtn,
    queryInput: !!queryInput,
    resultsArea: !!resultsArea
  });
  refreshSidebar();
  console.log("MultiLLM RAG Chatbot ready!");
})();
