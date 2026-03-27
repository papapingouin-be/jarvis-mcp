const meta = {
  overview: ["Vue d'ensemble", "Console admin MCP et runtime"],
  scripts_admin: ["Gestion scripts", "Discovery script 0, sync DB et coherence registry"],
  scripts_test: ["Test scripts MCP", "Services publies, pre-check, simulation et execution"],
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

function bindAsyncFragmentForms() {
  document.querySelectorAll("form[data-async-fragment]").forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();

      const fragment = form.dataset.asyncFragment || "";
      if (!fragment) {
        return;
      }

      const submitter = event.submitter || null;
      const body = new URLSearchParams(new FormData(form));
      if (submitter?.name) {
        body.set(submitter.name, submitter.value || "");
      }

      const content = document.getElementById("content");
      if (content) {
        content.innerHTML = "Chargement...";
      }

      const response = await fetch(`api/${fragment}.php`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (content) {
        content.innerHTML = await response.text();
      }

      bind();
    };
  });
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

function renderScriptHelp(help) {
  const phases = Object.entries(help.mcp_phases || {})
    .map(([phase, description]) => `<li><code>${phase}</code> - ${description}</li>`)
    .join("");

  const modes = Object.entries(help.modes || {})
    .map(([mode, description]) => {
      const recommendedPhase = help.recommended_phase_by_mode?.[mode];
      const suffix = recommendedPhase ? ` <span class="small">(phase recommandee: <code>${recommendedPhase}</code>)</span>` : "";
      return `<li><code>${mode}</code> - ${description}${suffix}</li>`;
    })
    .join("");

  const notes = Array.isArray(help.notes)
    ? help.notes.map((note) => `<li>${note}</li>`).join("")
    : "";

  return `
    <p class="small"><strong>Phases MCP</strong></p>
    <ul>${phases}</ul>
    <p class="small"><strong>Modes du script</strong></p>
    <ul>${modes || "<li>Aucun mode documente.</li>"}</ul>
    ${notes ? `<p class="small"><strong>Notes</strong></p><ul>${notes}</ul>` : ""}
  `;
}

function renderServiceInfo(service) {
  const required = Array.isArray(service.required_params)
    ? service.required_params.map((value) => `<li><code>${value}</code></li>`).join("")
    : "";
  const optional = Array.isArray(service.optional_params)
    ? service.optional_params.map((value) => `<li><code>${value}</code></li>`).join("")
    : "";

  return `
    <div class="notice info">
      <strong>${service.name}</strong> - ${service.description || ""}
    </div>
    <p class="small">Phase recommandee: <code>${service.phase || ""}</code> | confirmed requis: <code>${String(service.confirmed_required)}</code></p>
    <p class="small"><strong>Champs requis</strong></p>
    <ul>${required || "<li>Aucun</li>"}</ul>
    <p class="small"><strong>Champs optionnels</strong></p>
    <ul>${optional || "<li>Aucun</li>"}</ul>
    <p class="small"><strong>Defaults</strong></p>
    <pre>${JSON.stringify(service.defaults || {}, null, 2)}</pre>
    <p class="small"><strong>Exemple params JSON</strong></p>
    <pre>${JSON.stringify(service.example_params || {}, null, 2)}</pre>
  `;
}

function renderValidation(validation) {
  const known = validation.known || {};
  const missingRequired = Array.isArray(validation.missing_required) ? validation.missing_required : [];
  const optionalMissing = Array.isArray(validation.optional_missing) ? validation.optional_missing : [];

  return `
    <div class="notice ${validation.ready ? "success" : "warning"}">
      <strong>${validation.service}</strong> - ${validation.summary}
    </div>
    <p class="small">Phase recommandee: <code>${validation.phase || ""}</code> | confirmed requis: <code>${String(validation.confirmed_required)}</code></p>
    <p class="small"><strong>Connu</strong></p>
    <pre>${JSON.stringify(known, null, 2)}</pre>
    <p class="small"><strong>Champs requis manquants</strong></p>
    <ul>${missingRequired.length ? missingRequired.map((value) => `<li><code>${value}</code></li>`).join("") : "<li>Aucun</li>"}</ul>
    <p class="small"><strong>Champs optionnels manquants</strong></p>
    <ul>${optionalMissing.length ? optionalMissing.map((value) => `<li><code>${value}</code></li>`).join("") : "<li>Aucun</li>"}</ul>
  `;
}

function setPhaseFields(phaseInput, phaseDisplayInput, phaseValue) {
  const safePhase = phaseValue || "";
  if (phaseInput) {
    phaseInput.value = safePhase;
  }
  if (phaseDisplayInput) {
    phaseDisplayInput.value = safePhase;
  }
}

function setResultLoading(result, title, message = "Chargement en cours...") {
  if (!result) {
    return;
  }

  result.innerHTML = `
    <div class="card">
      <h3>${title}</h3>
      <div class="notice info">
        <strong>Traitement en cours</strong><br>
        ${message}
      </div>
    </div>
  `;
}

function setButtonBusy(button, busyLabel) {
  if (!button) {
    return () => {};
  }

  const previousLabel = button.textContent;
  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = busyLabel;

  return () => {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = previousLabel;
  };
}

function setServiceUiState({
  serviceSelect,
  serviceStatus,
  serviceInfoButton,
  validateButton,
  enabled,
  statusText,
}) {
  if (serviceSelect) {
    serviceSelect.disabled = !enabled;
  }

  if (serviceInfoButton) {
    serviceInfoButton.disabled = !enabled;
  }

  if (validateButton) {
    validateButton.disabled = !enabled;
  }

  if (serviceStatus) {
    serviceStatus.textContent = statusText;
  }
}

async function refreshScriptsTestHelp() {
  const scriptName = document.getElementById("scripts-test-script-name")?.value || "";
  const helpContainer = document.getElementById("scripts-test-help");

  if (!helpContainer) {
    return;
  }

  if (scriptName.trim() === "") {
    helpContainer.innerHTML = "<h3>Phases et modes</h3><p class=\"small\">Choisis un script pour afficher ses phases MCP et ses modes utiles.</p>";
    return;
  }

  const response = await fetch(
    `api/scripts_test.php?action=help&script_name=${encodeURIComponent(scriptName)}`
  );
  const payload = await response.json();

  if (!payload.ok) {
    helpContainer.innerHTML = `<h3>Phases et modes</h3><div class="notice error"><pre>${payload.message || "Erreur help"}</pre></div>`;
    return;
  }

  helpContainer.innerHTML = `<h3>Phases et modes</h3>${renderScriptHelp(payload.help)}`;
}

async function loadScriptServices() {
  const scriptName = document.getElementById("scripts-test-script-name")?.value || "";
  const serviceSelect = document.getElementById("scripts-test-service-name");
  const result = document.getElementById("scripts-test-result");
  const serviceStatus = document.getElementById("scripts-test-service-status");
  const serviceInfoButton = document.getElementById("scripts-test-service-info-btn");
  const validateButton = document.getElementById("scripts-test-validate-btn");
  const phaseInput = document.getElementById("scripts-test-phase");
  const phaseDisplayInput = document.getElementById("scripts-test-phase-display");

  if (!serviceSelect) {
    return;
  }

  serviceSelect.innerHTML = '<option value="">-- Choisir un service --</option>';
  setServiceUiState({
    serviceSelect,
    serviceStatus,
    serviceInfoButton,
    validateButton,
    enabled: false,
    statusText: "Choisis un script pour charger ses services.",
  });

  if (scriptName.trim() === "") {
    setPhaseFields(phaseInput, phaseDisplayInput, "");
    return;
  }

  setResultLoading(result, "Services", "Chargement des services exposes par le script...");
  setServiceUiState({
    serviceSelect,
    serviceStatus,
    serviceInfoButton,
    validateButton,
    enabled: false,
    statusText: "Chargement des services...",
  });

  const response = await fetch(
    `api/scripts_test.php?action=service_catalog&script_name=${encodeURIComponent(scriptName)}`
  );
  const payload = await response.json();

  if (!payload.ok || !Array.isArray(payload.services)) {
    result.innerHTML = `<div class="notice error"><pre>${payload.message || "Impossible de charger les services."}</pre></div>`;
    setServiceUiState({
      serviceSelect,
      serviceStatus,
      serviceInfoButton,
      validateButton,
      enabled: false,
      statusText: "Chargement impossible pour ce script.",
    });
    return;
  }

  if (payload.services.length === 0) {
    result.innerHTML = '<div class="notice warning">Ce script ne publie aucun service exploitable dans cette vue.</div>';
    setServiceUiState({
      serviceSelect,
      serviceStatus,
      serviceInfoButton,
      validateButton,
      enabled: false,
      statusText: "Aucun service disponible pour ce script dans cette vue.",
    });
    return;
  }

  payload.services.forEach((service) => {
    const option = document.createElement("option");
    option.value = service.name || "";
    option.textContent = `${service.name || ""} - ${service.description || `phase ${service.phase || "?"}`}`;
    serviceSelect.appendChild(option);
  });

  const firstService = payload.services[0] || null;
  if (firstService?.name) {
    serviceSelect.value = firstService.name;
    setPhaseFields(phaseInput, phaseDisplayInput, firstService.phase || "");
  }

  setServiceUiState({
    serviceSelect,
    serviceStatus,
    serviceInfoButton,
    validateButton,
    enabled: true,
    statusText: `${payload.services.length} service(s) disponibles. Choisis-en un pour afficher son detail.`,
  });
  result.innerHTML = `<div class="notice success">${payload.services.length} service(s) charges. Choisis un service puis clique sur <strong>Infos du service</strong>.</div>`;
}

async function fetchAndRenderServiceInfo({
  scriptName,
  serviceName,
  result,
  phaseInput,
  phaseDisplayInput,
  confirmedInput,
  busyButton,
}) {
  if (scriptName.trim() === "" || serviceName.trim() === "") {
    result.innerHTML = '<div class="notice warning">Choisis un script et un service.</div>';
    return;
  }

  setResultLoading(result, "Infos du service", "Recuperation de la description du service...");
  const done = busyButton ? setButtonBusy(busyButton, "Chargement...") : () => {};

  try {
    const response = await fetch(
      `api/scripts_test.php?action=service_info&script_name=${encodeURIComponent(scriptName)}&service=${encodeURIComponent(serviceName)}`
    );
    const payload = await response.json();

    if (!payload.ok) {
      result.innerHTML = `<div class="notice error"><pre>${payload.message || "Erreur service_info"}</pre></div>`;
      return;
    }

    if (!payload.service || Object.keys(payload.service).length === 0) {
      result.innerHTML = '<div class="notice warning">Le script n a retourne aucune information pour ce service.</div>';
      return;
    }

    setPhaseFields(phaseInput, phaseDisplayInput, payload.service?.phase || "");

    if (confirmedInput) {
      confirmedInput.value = payload.service?.confirmed_required ? "true" : "false";
    }

    result.innerHTML = `<div class="card"><h3>Action possible</h3>${renderServiceInfo(payload.service || {})}</div>`;
  } catch (error) {
    result.innerHTML = `<div class="notice error"><pre>${error?.message || "Erreur reseau service_info"}</pre></div>`;
  } finally {
    done();
  }
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
  const serviceInfoButton = document.getElementById("scripts-test-service-info-btn");
  const validateButton = document.getElementById("scripts-test-validate-btn");
  const scriptNameInput = document.getElementById("scripts-test-script-name");
  const phaseInput = document.getElementById("scripts-test-phase");
  const phaseDisplayInput = document.getElementById("scripts-test-phase-display");
  const serviceInput = document.getElementById("scripts-test-service-name");
  const confirmedInput = document.getElementById("scripts-test-confirmed");
  const paramsJsonInput = document.getElementById("scripts-test-params-json");
  const result = document.getElementById("scripts-test-result");

  if (scriptNameInput) {
    scriptNameInput.onchange = async () => {
      refreshScriptsTestHelp();
      await loadScriptServices();
      if (serviceInput?.value) {
        await fetchAndRenderServiceInfo({
          scriptName: scriptNameInput.value || "",
          serviceName: serviceInput.value || "",
          result,
          phaseInput,
          phaseDisplayInput,
          confirmedInput,
        });
      }
    };
  }

  if (serviceInput) {
    serviceInput.onchange = async () => {
      await fetchAndRenderServiceInfo({
        scriptName: scriptNameInput?.value || "",
        serviceName: serviceInput.value || "",
        result,
        phaseInput,
        phaseDisplayInput,
        confirmedInput,
      });
    };
  }

  refreshScriptsTestHelp();
  loadScriptServices().then(async () => {
    if (serviceInput?.value) {
      await fetchAndRenderServiceInfo({
        scriptName: scriptNameInput?.value || "",
        serviceName: serviceInput.value || "",
        result,
        phaseInput,
        phaseDisplayInput,
        confirmedInput,
      });
    }
  });

  if (serviceInfoButton) {
    serviceInfoButton.onclick = async () => {
      await fetchAndRenderServiceInfo({
        scriptName: scriptNameInput?.value || "",
        serviceName: serviceInput?.value || "",
        result,
        phaseInput,
        phaseDisplayInput,
        confirmedInput,
        busyButton: serviceInfoButton,
      });
    };
  }

  if (!exampleButton) {
    return;
  }

  exampleButton.onclick = async () => {
    const scriptName = scriptNameInput?.value || "";
    const phase = phaseInput?.value || "collect";
    const service = serviceInput?.value || "";

    if (scriptName.trim() === "") {
      result.innerHTML = '<div class="notice warning">Choisis d abord un script.</div>';
      return;
    }

    setResultLoading(result, "Exemple params JSON", "Generation de l exemple adapte au service courant...");
    const done = setButtonBusy(exampleButton, "Generation...");

    try {
      const response = await fetch(
        `api/scripts_test.php?action=example&script_name=${encodeURIComponent(scriptName)}&phase=${encodeURIComponent(phase)}&service=${encodeURIComponent(service)}`
      );
      const payload = await response.json();

      if (!payload.ok) {
        result.innerHTML = `<div class="notice error"><pre>${payload.message || "Erreur example"}</pre></div>`;
        return;
      }

      const example = payload.example;
      if (!example) {
        result.innerHTML = '<div class="notice warning">Aucun exemple n a ete retourne par le script.</div>';
        return;
      }

      if (paramsJsonInput) {
        paramsJsonInput.value = example.pretty_params_json || "{}";
      }

      if (confirmedInput) {
        confirmedInput.value = example.confirmed ? "true" : "false";
      }

      setPhaseFields(phaseInput, phaseDisplayInput, example.phase || "");

      result.innerHTML = `<div class="card"><h3>Exemple params JSON</h3>${renderScriptExample(example)}</div>`;
    } catch (error) {
      result.innerHTML = `<div class="notice error"><pre>${error?.message || "Erreur reseau example"}</pre></div>`;
    } finally {
      done();
    }
  };

  if (validateButton) {
    validateButton.onclick = async () => {
      const scriptName = scriptNameInput?.value || "";
      const serviceName = serviceInput?.value || "";

      if (scriptName.trim() === "" || serviceName.trim() === "") {
        result.innerHTML = '<div class="notice warning">Choisis un script et un service.</div>';
        return;
      }

      setResultLoading(result, "Verification des infos connues", "Analyse des champs fournis et des champs manquants...");
      const done = setButtonBusy(validateButton, "Verification...");

      try {
        const body = new URLSearchParams(new FormData(testForm)).toString();
        const response = await fetch("api/scripts_test.php?action=validate_service", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const payload = await response.json();

        if (!payload.ok) {
          result.innerHTML = `<div class="notice error"><pre>${payload.message || "Erreur validate_service"}</pre></div>`;
          return;
        }

        if (!payload.validation) {
          result.innerHTML = '<div class="notice warning">Le script n a retourne aucun resultat de validation.</div>';
          return;
        }

        setPhaseFields(phaseInput, phaseDisplayInput, payload.validation?.phase || "");

        if (confirmedInput) {
          confirmedInput.value = payload.validation?.confirmed_required ? "true" : "false";
        }

        result.innerHTML = `<div class="card"><h3>Verification des infos connues</h3>${renderValidation(payload.validation || {})}</div>`;
      } catch (error) {
        result.innerHTML = `<div class="notice error"><pre>${error?.message || "Erreur reseau validate_service"}</pre></div>`;
      } finally {
        done();
      }
    };
  }
}

function bind() {
  bindFilter();
  bindCopyButtons();
  bindConfirmButtons();
  bindPrefillScriptButtons();
  bindAsyncFragmentForms();
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
