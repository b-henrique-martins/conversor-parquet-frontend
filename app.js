// ---------------------------------------------------------------------
// Configuração fixa do backend (edite o valor abaixo)
// ---------------------------------------------------------------------
const API_URL = "https://conversor-parquet-backend.onrender.com";

// Intervalo de polling do status do job. Começa rápido e vai espaçando
// pra não martelar o backend em conversões longas.
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_INTERVAL_MS = 8000;

const els = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  fileName: document.getElementById("file-name"),
  direction: document.getElementById("direction"),
  convertBtn: document.getElementById("convert-btn"),

  progressArea: document.getElementById("progress-area"),
  progressLabel: document.getElementById("progress-label"),
  progressPct: document.getElementById("progress-pct"),
  progressFill: document.getElementById("progress-fill"),
  resultArea: document.getElementById("result-area"),

  tabConvert: document.getElementById("tab-convert"),
  tabView: document.getElementById("tab-view"),
  sectionConvert: document.getElementById("section-convert"),
  sectionView: document.getElementById("section-view"),

  viewDropzone: document.getElementById("view-dropzone"),
  viewFileInput: document.getElementById("view-file-input"),
  viewFileName: document.getElementById("view-file-name"),
  viewBtn: document.getElementById("view-btn"),
  viewProgressArea: document.getElementById("view-progress-area"),
  viewProgressLabel: document.getElementById("view-progress-label"),
  viewProgressPct: document.getElementById("view-progress-pct"),
  viewProgressFill: document.getElementById("view-progress-fill"),
  viewResult: document.getElementById("view-result"),
};

let selectedFile = null;
let pollTimer = null;

// ---------------------------------------------------------------------
// Controle do estado visual do botão de converter (spinner + texto)
// ---------------------------------------------------------------------
const CONVERT_BTN_DEFAULT_LABEL = els.convertBtn.textContent; // "Converter"

function setConvertButtonLoading(loading) {
  if (loading) {
    els.convertBtn.disabled = true;
    els.convertBtn.classList.add("is-loading");
    els.convertBtn.innerHTML =
      '<span class="btn-spinner" aria-hidden="true"></span><span>Convertendo…</span>';
  } else {
    els.convertBtn.classList.remove("is-loading");
    els.convertBtn.textContent = CONVERT_BTN_DEFAULT_LABEL;
    els.convertBtn.disabled = !selectedFile;
  }
}

// ---------------------------------------------------------------------
// "Acorda" o backend assim que a página carrega. Em planos free/starter
// do Render, o serviço hiberna depois de um tempo sem tráfego -- sem
// isso, a PRIMEIRA ação real do usuário (presign) é que pagaria o custo
// do cold start (pode levar dezenas de segundos). Isso é só um "toque",
// não bloqueia nada e ignora erro silenciosamente (se falhar, o próximo
// apiCall vai simplesmente esperar o tempo normal de cold start).
// ---------------------------------------------------------------------
function wakeServer() {
  fetch(API_URL + "/health", { method: "GET" }).catch(() => {
    // silencioso de propósito -- não é uma ação do usuário, não precisa de erro visível
  });
}

wakeServer();

// ---------------------------------------------------------------------
// Abas: Converter / Visualizar
// ---------------------------------------------------------------------
els.tabConvert.addEventListener("click", () => switchTab("convert"));
els.tabView.addEventListener("click", () => switchTab("view"));

function switchTab(tab) {
  const isConvert = tab === "convert";

  els.tabConvert.classList.toggle("active", isConvert);
  els.tabView.classList.toggle("active", !isConvert);
  els.tabConvert.setAttribute("aria-selected", String(isConvert));
  els.tabView.setAttribute("aria-selected", String(!isConvert));

  els.sectionConvert.classList.toggle("hidden", !isConvert);
  els.sectionView.classList.toggle("hidden", isConvert);
}

// ---------------------------------------------------------------------
// Seleção de arquivo (clique ou drag-and-drop) -- aba Converter
// ---------------------------------------------------------------------
els.dropzone.addEventListener("click", () => els.fileInput.click());

els.dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropzone.classList.add("drag-over");
});

els.dropzone.addEventListener("dragleave", () =>
  els.dropzone.classList.remove("drag-over"),
);

els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) handleFileSelected(e.dataTransfer.files[0]);
});

els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files.length) handleFileSelected(els.fileInput.files[0]);
});

function handleFileSelected(file) {
  selectedFile = file;
  els.fileName.textContent = `${file.name}  (${formatBytes(file.size)})`;
  els.convertBtn.disabled = false;

  if (file.name.endsWith(".csv")) {
    els.direction.value = "csv_to_parquet";
  } else if (file.name.endsWith(".parquet")) {
    els.direction.value = "parquet_to_csv";
  }
}

// ---------------------------------------------------------------------
// Fluxo de conversão: presign -> upload direto -> criar job -> polling
// ---------------------------------------------------------------------
els.convertBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  stopPolling();
  setConvertButtonLoading(true);
  els.resultArea.classList.add("hidden");
  els.progressArea.classList.remove("hidden");
  setProgress(els, "Preparando envio…", 0);

  try {
    const presign = await apiCall("/api/uploads/presign", "POST", {
      filename: selectedFile.name,
      content_type: selectedFile.type || "application/octet-stream",
    });

    setProgress(els, "Enviando arquivo…", 0);
    await uploadWithProgress(presign.upload_url, selectedFile, (pct) => {
      setProgress(els, "Enviando arquivo…", pct);
    });

    setProgress(els, "Iniciando conversão…", 100);

    const { job_id } = await apiCall("/api/convert", "POST", {
      input_key: presign.object_key,
      original_filename: selectedFile.name,
      direction: els.direction.value,
    });

    setProgress(
      els,
      "Convertendo… isso pode levar alguns minutos em arquivos grandes",
      100,
    );
    els.progressFill.classList.add("indeterminate");

    pollJob(job_id);
  } catch (err) {
    showError(err.message || "Falha inesperada ao converter o arquivo.");
    setConvertButtonLoading(false);
    els.progressArea.classList.add("hidden");
  }
});

// ---------------------------------------------------------------------
// Polling do status do job. A conversão roda em background no backend,
// então essa requisição de /api/convert já voltou na hora -- aqui só
// ficamos perguntando "já terminou?" até a resposta ser done ou error.
// ---------------------------------------------------------------------
function pollJob(jobId, interval = POLL_INTERVAL_MS) {
  pollTimer = setTimeout(async () => {
    try {
      const job = await apiCall(`/api/jobs/${jobId}`, "GET");

      if (job.status === "done") {
        stopPolling();
        els.progressFill.classList.remove("indeterminate");
        els.progressArea.classList.add("hidden");
        showSuccess(job);
        setConvertButtonLoading(false);
        return;
      }

      if (job.status === "error") {
        stopPolling();
        els.progressFill.classList.remove("indeterminate");
        els.progressArea.classList.add("hidden");
        showError(job.error || "Falha durante a conversão.");
        setConvertButtonLoading(false);
        return;
      }

      // ainda pending/processing -- continua perguntando, espaçando um pouco
      const nextInterval = Math.min(interval * 1.3, POLL_MAX_INTERVAL_MS);
      pollJob(jobId, nextInterval);
    } catch (err) {
      stopPolling();
      els.progressArea.classList.add("hidden");
      showError(
        "Perdemos a conexão com o status da conversão. Tente novamente.",
      );
      setConvertButtonLoading(false);
    }
  }, interval);
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function showSuccess(job) {
  els.resultArea.className = "result-area success";
  els.resultArea.innerHTML = `
    <p class="result-title">Conversão concluída</p>
    <p class="result-detail">linhas de entrada: ${job.row_count_in}</p>
    <p class="result-detail">linhas de saída: ${job.row_count_out}</p>
    <p class="result-detail">${job.row_count_in === job.row_count_out ? "✓ contagem de linhas conferida" : "⚠ contagem de linhas divergente"}</p>
    <a class="btn-primary" href="${job.download_url}" target="_blank" rel="noopener">Baixar arquivo</a>
  `;
  els.resultArea.classList.remove("hidden");
}

function showError(message) {
  els.resultArea.className = "result-area error";
  els.resultArea.innerHTML = `
    <p class="result-title">Não foi possível concluir</p>
    <p class="result-detail">${escapeHtml(message)}</p>
  `;
  els.resultArea.classList.remove("hidden");
}

// ---------------------------------------------------------------------
// Aba Visualizar: upload -> preview -> apaga o objeto do bucket na hora.
// Fluxo independente do de conversão -- não cria job, não passa por
// /api/convert.
// ---------------------------------------------------------------------
let selectedViewFile = null;

const VIEW_BTN_DEFAULT_LABEL = els.viewBtn.textContent; // "Visualizar"

function setViewButtonLoading(loading) {
  if (loading) {
    els.viewBtn.disabled = true;
    els.viewBtn.classList.add("is-loading");
    els.viewBtn.innerHTML =
      '<span class="btn-spinner" aria-hidden="true"></span><span>Carregando…</span>';
  } else {
    els.viewBtn.classList.remove("is-loading");
    els.viewBtn.textContent = VIEW_BTN_DEFAULT_LABEL;
    els.viewBtn.disabled = !selectedViewFile;
  }
}

els.viewDropzone.addEventListener("click", () => els.viewFileInput.click());

els.viewDropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.viewDropzone.classList.add("drag-over");
});

els.viewDropzone.addEventListener("dragleave", () =>
  els.viewDropzone.classList.remove("drag-over"),
);

els.viewDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.viewDropzone.classList.remove("drag-over");
  if (e.dataTransfer.files.length)
    handleViewFileSelected(e.dataTransfer.files[0]);
});

els.viewFileInput.addEventListener("change", () => {
  if (els.viewFileInput.files.length)
    handleViewFileSelected(els.viewFileInput.files[0]);
});

function handleViewFileSelected(file) {
  selectedViewFile = file;
  els.viewFileName.textContent = `${file.name}  (${formatBytes(file.size)})`;
  els.viewBtn.disabled = false;
}

els.viewBtn.addEventListener("click", async () => {
  if (!selectedViewFile) return;

  setViewButtonLoading(true);
  els.viewResult.classList.add("hidden");
  els.viewProgressArea.classList.remove("hidden");
  setProgress(
    {
      progressLabel: els.viewProgressLabel,
      progressPct: els.viewProgressPct,
      progressFill: els.viewProgressFill,
    },
    "Enviando arquivo…",
    0,
  );

  let objectKey = null;

  try {
    const presign = await apiCall("/api/uploads/presign", "POST", {
      filename: selectedViewFile.name,
      content_type: selectedViewFile.type || "application/octet-stream",
    });
    objectKey = presign.object_key;

    await uploadWithProgress(presign.upload_url, selectedViewFile, (pct) => {
      setProgress(
        {
          progressLabel: els.viewProgressLabel,
          progressPct: els.viewProgressPct,
          progressFill: els.viewProgressFill,
        },
        "Enviando arquivo…",
        pct,
      );
    });

    setProgress(
      {
        progressLabel: els.viewProgressLabel,
        progressPct: els.viewProgressPct,
        progressFill: els.viewProgressFill,
      },
      "Gerando visualização…",
      100,
    );

    const data = await apiCall("/api/preview", "POST", {
      object_key: objectKey,
      limit: 100,
    });

    els.viewProgressArea.classList.add("hidden");
    renderViewResult(data);
  } catch (err) {
    els.viewProgressArea.classList.add("hidden");
    els.viewResult.className = "preview-inline";
    els.viewResult.innerHTML = `<div class="preview-error">${escapeHtml(err.message || "Falha ao gerar a visualização.")}</div>`;
    els.viewResult.classList.remove("hidden");
  } finally {
    // arquivo enviado só serve pra esse preview -- some do bucket na hora,
    // não precisa esperar a limpeza de órfãos (6h).
    if (objectKey) {
      apiCall("/api/uploads/delete", "POST", { object_key: objectKey }).catch(
        () => {},
      );
    }
    setViewButtonLoading(false);
  }
});

function renderViewResult(data) {
  const totalLabel =
    data.row_count_total != null
      ? `${data.row_count_total} linhas no total`
      : "total de linhas não calculado (arquivo grande)";

  const truncatedNote = data.truncated_columns
    ? " · algumas colunas foram omitidas nesta visualização"
    : "";

  const headerHtml = data.columns
    .map((c) => `<th>${escapeHtml(c)}</th>`)
    .join("");
  const rowsHtml = data.rows
    .map(
      (row) =>
        `<tr>${row.map((v) => `<td>${v == null ? "" : escapeHtml(String(v))}</td>`).join("")}</tr>`,
    )
    .join("");

  els.viewResult.className = "preview-inline";
  els.viewResult.innerHTML = `
    <p class="preview-meta">mostrando ${data.row_count_returned} linhas · ${totalLabel}${truncatedNote}</p>
    <div class="preview-table-wrap">
      <table>
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
  els.viewResult.classList.remove("hidden");
}

// ---------------------------------------------------------------------
// Utilitários compartilhados pelas duas abas
// ---------------------------------------------------------------------
function uploadWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error("Falha no upload para o storage."));
    xhr.onerror = () => reject(new Error("Erro de rede durante o upload."));
    xhr.send(file);
  });
}

function setProgress(target, label, pct) {
  target.progressLabel.textContent = label;
  target.progressPct.textContent = `${pct}%`;
  target.progressFill.style.width = `${pct}%`;
}

async function apiCall(path, method, body) {
  const res = await fetch(API_URL + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let detail = `Erro ${res.status}`;
    try {
      const data = await res.json();
      detail = data.detail || detail;
    } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes;
  let i = -1;
  do {
    val /= 1024;
    i++;
  } while (val >= 1024 && i < units.length - 1);
  return `${val.toFixed(1)} ${units[i]}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
