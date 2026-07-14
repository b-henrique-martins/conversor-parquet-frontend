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
};

let selectedFile = null;
let pollTimer = null;

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
// Seleção de arquivo (clique ou drag-and-drop)
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
  els.convertBtn.disabled = true;
  els.resultArea.classList.add("hidden");
  els.progressArea.classList.remove("hidden");
  setProgress("Preparando envio…", 0);

  try {
    const presign = await apiCall("/api/uploads/presign", "POST", {
      filename: selectedFile.name,
      content_type: selectedFile.type || "application/octet-stream",
    });

    setProgress("Enviando arquivo…", 0);
    await uploadWithProgress(presign.upload_url, selectedFile, (pct) => {
      setProgress("Enviando arquivo…", pct);
    });

    setProgress("Iniciando conversão…", 100);

    const { job_id } = await apiCall("/api/convert", "POST", {
      input_key: presign.object_key,
      original_filename: selectedFile.name,
      direction: els.direction.value,
    });

    setProgress(
      "Convertendo… isso pode levar alguns minutos em arquivos grandes",
      100,
    );
    els.progressFill.classList.add("indeterminate");

    pollJob(job_id);
  } catch (err) {
    showError(err.message || "Falha inesperada ao converter o arquivo.");
    els.convertBtn.disabled = false;
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
        els.convertBtn.disabled = false;
        return;
      }

      if (job.status === "error") {
        stopPolling();
        els.progressFill.classList.remove("indeterminate");
        els.progressArea.classList.add("hidden");
        showError(job.error || "Falha durante a conversão.");
        els.convertBtn.disabled = false;
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
      els.convertBtn.disabled = false;
    }
  }, interval);
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

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

function setProgress(label, pct) {
  els.progressLabel.textContent = label;
  els.progressPct.textContent = `${pct}%`;
  els.progressFill.style.width = `${pct}%`;
}

// ---------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------
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
