const meta = {
  overview: ["Vue d'ensemble", "Console admin MCP et runtime"],
  scripts_admin: ["Gestion scripts", "CRUD registry, scan disque, coherence DB"],
  scripts_test: ["Test scripts MCP", "Pre-check, simulation et execution"],
  scripts_catalog: ["Catalogue MCP", "Vue des scripts et des descriptions"],
  maintenance: ["Scripts disque", "Inventaire des fichiers scripts"],
  sql: ["SQL runner", "Fichiers SQL et requetes manuelles"],
  env: ["ENV", "Variables visibles par PHP"],
  logs: ["Logs", "Historique de l'UI"],
  services: ["Services", "Etat des services declares"],
  diagnostics: ["Diagnostics", "Problemes frequents et actions utiles"],
};

async function loadPage(page) {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  document.getElementById("title").textContent = meta[page]?.[0] || page;
  document.getElementById("subtitle").textContent = meta[page]?.[1] || "";

  const content = document.getElementById("content");
  content.innerHTML = "Chargement...";

  const response = await fetch(`api/${page}.php?_=${Date.now()}`);
  content.innerHTML = await response.text();
  bind();
}

function bindFilter() {
  const filter = document.getElementById("env-filter");
  if (!filter) {
    return;
  }

  filter.oninput = () => {
    const query = filter.value.toLowerCase();
    document.querySelectorAll("tbody tr[data-filter]").forEach((row) => {
      row.style.display = row.dataset.filter.toLowerCase().includes(query) ? "" : "none";
    });
  };
}

function bindCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.onclick = async () => {
      await navigator.clipboard.writeText(button.dataset.copy || "");
      button.textContent = "Copie";
      setTimeout(() => {
        button.textContent = "Copier";
      }, 1200);
    };
  });
}

function bindConfirmButtons() {
  document.querySelectorAll("[data-confirm]").forEach((button) => {
    button.onclick = (event) => {
      if (!confirm(button.dataset.confirm || "Confirmer ?")) {
        event.preventDefault();
      }
    };
  });
}

function bindPrefillScriptButtons() {
  document.querySelectorAll("[data-prefill-script]").forEach((button) => {
    button.onclick = () => {
      const scriptName = button.dataset.prefillScript || "";
      const scriptNameInput = document.getElementById("script_name");
      const fileNameInput = document.getElementById("file_name");

      if (scriptNameInput && !scriptNameInput.value) {
        scriptNameInput.value = scriptName;
      }

      if (fileNameInput) {
        fileNameInput.value = scriptName;
      }

      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: "smooth",
      });
    };
  });
}

function bindSqlPreview() {
  const sqlFileSelect = document.getElementById("sql-file-select");
  if (!sqlFileSelect) {
    return;
  }

  sqlFileSelect.onchange = async () => {
    const response = await fetch(`api/sql.php?action=preview&file=${encodeURIComponent(sqlFileSelect.value)}`);
    document.getElementById("sql-preview").innerHTML = await response.text();
  };
}

function bindSqlManualForm() {
  const sqlManualForm = document.getElementById("sql-manual-form");
  if (!sqlManualForm) {
    return;
  }

  sqlManualForm.onsubmit = async (event) => {
    event.preventDefault();
    const body = new URLSearchParams(new FormData(sqlManualForm)).toString();
    const response = await fetch("api/sql.php?action=manual", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    document.getElementById("sql-manual-result").innerHTML = await response.text();
  };
}

function renderScriptExample(example) {
  const notes = Array.isArray(example.notes)
    ? example.notes.map((note) => `<li>${note}</li>`).join("")
    : "";

  return `
    <div class="notice info">
      <strong>${example.script_name}</strong> - ${example.summary}
    </div>
    <p class="small">Phase suggeree: <code>${example.phase}</code> | confirmed: <code>${String(example.confirmed)}</code></p>
    <pre>${example.pretty_params_json}</pre>
    ${notes ? `<ul>${notes}</ul>` : ""}
  `;
}

function bindScriptsTestForm() {
  const testForm = document.getElementById("scripts-test-form");
  if (!testForm) {
    return;
  }

  testForm.onsubmit = async (event) => {
    event.preventDefault();
    const body = new URLSearchParams(new FormData(testForm)).toString();
    const response = await fetch("api/scripts_test.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    document.getElementById("scripts-test-result").innerHTML = await response.text();
  };

  const exampleButton = document.getElementById("scripts-test-example-btn");
  if (!exampleButton) {
    return;
  }

  exampleButton.onclick = async () => {
    const scriptName = document.getElementById("scripts-test-script-name")?.value || "";
    const phase = document.getElementById("scripts-test-phase")?.value || "collect";
    const result = document.getElementById("scripts-test-result");

    if (scriptName.trim() === "") {
      result.innerHTML = '<div class="notice warning">Choisis d abord un script.</div>';
      return;
    }

    const response = await fetch(
      `api/scripts_test.php?action=example&script_name=${encodeURIComponent(scriptName)}&phase=${encodeURIComponent(phase)}`
    );
    const payload = await response.json();

    if (!payload.ok) {
      result.innerHTML = `<div class="notice error"><pre>${payload.message || "Erreur example"}</pre></div>`;
      return;
    }

    const example = payload.example;
    const paramsJson = document.getElementById("scripts-test-params-json");
    const confirmed = document.getElementById("scripts-test-confirmed");

    if (paramsJson) {
      paramsJson.value = example.pretty_params_json || "{}";
    }

    if (confirmed) {
      confirmed.value = example.confirmed ? "true" : "false";
    }

    result.innerHTML = `<div class="card"><h3>Exemple params JSON</h3>${renderScriptExample(example)}</div>`;
  };
}

function bind() {
  bindFilter();
  bindCopyButtons();
  bindConfirmButtons();
  bindPrefillScriptButtons();
  bindSqlPreview();
  bindSqlManualForm();
  bindScriptsTestForm();
}

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.onclick = () => loadPage(button.dataset.page);
});

document.getElementById("refresh-btn").onclick = () => {
  const activeButton = document.querySelector(".nav-btn.active");
  loadPage(activeButton.dataset.page);
};

loadPage("overview");
