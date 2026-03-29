<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
$pdo = $d['ok'] ? $d['pdo'] : null;
$runtimeEnv = env_all();
$scriptEnv = $pdo ? script_env_grouped($pdo) : [];
$appConfig = $pdo ? app_config_all($pdo) : [];
$registryRows = $pdo && table_exists($pdo, 'jarvis_script_registry') ? registry_all($pdo) : [];
$selectedScript = trim((string) ($_POST['script_name'] ?? $_GET['script_name'] ?? ''));
$expectedRows = [];
$flash = '';
$flashType = 'success';

if ($pdo !== null && $_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        jarvis_check_csrf();
        $action = trim((string) ($_POST['form_action'] ?? ''));

        if ($action === 'save_script_env') {
            if ($selectedScript === '') {
                throw new RuntimeException('Choisis un script avant de sauvegarder.');
            }

            $rawValues = $_POST['env_values'] ?? [];
            if (!is_array($rawValues)) {
                throw new RuntimeException('Format env_values invalide.');
            }

            $toUpsert = [];
            $toDelete = [];

            foreach ($rawValues as $envName => $envValue) {
                $name = trim((string) $envName);
                if ($name === '') {
                    continue;
                }

                $value = trim((string) $envValue);
                if ($value === '') {
                    $toDelete[] = $name;
                    continue;
                }

                $toUpsert[$name] = $value;
            }

            $updated = script_env_upsert_many($pdo, $selectedScript, $toUpsert);
            $deleted = script_env_delete_many($pdo, $selectedScript, $toDelete);
            $flash = 'Configuration sauvegardee pour ' . $selectedScript . ' : ' . $updated . ' variable(s) enregistree(s), ' . $deleted . ' supprimee(s).';
            jarvis_append_log('env', $selectedScript, 'saved', $flash);
            $scriptEnv = script_env_grouped($pdo);
        }
    } catch (Throwable $e) {
        $flash = $e->getMessage();
        $flashType = 'error';
    }
}

if ($pdo !== null && $selectedScript !== '') {
    try {
        $expectedRows = script_expected_env_with_values($pdo, $selectedScript);
    } catch (Throwable $e) {
        if ($flash === '') {
            $flash = $e->getMessage();
            $flashType = 'error';
        }
    }
}
?>
<div class="stack">
  <div class="notice">Cette vue distingue le runtime PHP des variables de scripts stockees en base et permet maintenant de les renseigner directement.</div>

  <div class="grid">
    <div class="kpi"><div class="label">Runtime ENV</div><div class="value"><?= h(count($runtimeEnv)) ?></div></div>
    <div class="kpi"><div class="label">Configs DB</div><div class="value"><?= h(count($appConfig)) ?></div></div>
    <div class="kpi"><div class="label">Scripts avec config</div><div class="value"><?= h(count($scriptEnv)) ?></div></div>
  </div>

  <?php if (!$d['ok']): ?>
    <?= jarvis_render_notice('<pre>' . h($d['message']) . '</pre>', 'warning') ?>
  <?php endif; ?>

  <?php if ($flash !== ''): ?>
    <?= jarvis_render_notice(h($flash), $flashType) ?>
  <?php endif; ?>

  <div class="card">
    <h3>Assistant de configuration scripts</h3>
    <?php if (!$d['ok']): ?>
      <p class="small">Connexion DB indisponible.</p>
    <?php elseif (!$registryRows): ?>
      <p class="small">Aucun script en registry.</p>
    <?php else: ?>
      <form method="post" data-async-fragment="env">
        <?= jarvis_csrf_input() ?>
        <input type="hidden" name="form_action" value="select_script">
        <p>
          <label>Script</label>
          <select name="script_name">
            <option value="">-- Choisir un script --</option>
            <?php foreach ($registryRows as $row): ?>
              <option value="<?= h((string) $row['script_name']) ?>" <?= $selectedScript === (string) $row['script_name'] ? 'selected' : '' ?>>
                <?= h((string) $row['script_name']) ?> - <?= h((string) ($row['description'] ?? '')) ?>
              </option>
            <?php endforeach; ?>
          </select>
        </p>
        <div class="actions">
          <button class="secondary-btn" type="submit">Charger les variables attendues</button>
        </div>
      </form>

      <?php if ($selectedScript !== ''): ?>
        <div class="notice info" style="margin-top:12px">
          <strong><?= h($selectedScript) ?></strong><br>
          Les lignes ci-dessous fusionnent les variables attendues par le script et les valeurs deja presentes en DB.
          Laisse une valeur vide puis sauvegarde pour supprimer l entree cote DB.
        </div>

        <form method="post" data-async-fragment="env">
          <?= jarvis_csrf_input() ?>
          <input type="hidden" name="form_action" value="save_script_env">
          <input type="hidden" name="script_name" value="<?= h($selectedScript) ?>">
          <table>
            <thead>
              <tr>
                <th>variable</th>
                <th>requise</th>
                <th>origine</th>
                <th>services</th>
                <th>description</th>
                <th>etat DB</th>
                <th>valeur</th>
              </tr>
            </thead>
            <tbody>
              <?php foreach ($expectedRows as $row): ?>
                <?php
                $sources = is_array($row['sources'] ?? null) ? $row['sources'] : [];
                $services = is_array($row['services'] ?? null) ? $row['services'] : [];
                $stored = !empty($row['stored']);
                ?>
                <tr>
                  <td><code><?= h((string) $row['name']) ?></code></td>
                  <td><span class="status <?= !empty($row['required']) ? 'warn' : 'up' ?>"><?= !empty($row['required']) ? 'OUI' : 'NON' ?></span></td>
                  <td><?= h(implode(', ', $sources)) ?></td>
                  <td><?= h($services ? implode(', ', $services) : '-') ?></td>
                  <td><?= h((string) ($row['description'] ?? '')) ?></td>
                  <td><span class="status <?= $stored ? 'up' : 'down' ?>"><?= $stored ? 'PRESENTE' : 'ABSENTE' ?></span></td>
                  <td>
                    <textarea name="env_values[<?= h((string) $row['name']) ?>]" style="min-height:80px"><?= h((string) ($row['value'] ?? '')) ?></textarea>
                  </td>
                </tr>
              <?php endforeach; ?>
            </tbody>
          </table>
          <div class="actions" style="margin-top:12px">
            <button class="primary-btn" type="submit">Sauvegarder en DB</button>
          </div>
        </form>
      <?php endif; ?>
    <?php endif; ?>
  </div>

  <div class="card">
    <h3>Configuration scripts en base</h3>
    <?php if (!$d['ok']): ?>
      <p class="small">Connexion DB indisponible.</p>
    <?php elseif (!$scriptEnv): ?>
      <p class="small">Aucune variable de script en base.</p>
    <?php else: ?>
      <table>
        <thead><tr><th>script</th><th>variable</th><th>valeur</th><th>maj</th></tr></thead>
        <tbody>
          <?php foreach ($scriptEnv as $scriptName => $rows): ?>
            <?php foreach ($rows as $index => $row): ?>
              <tr>
                <td><?= $index === 0 ? '<strong>' . h($scriptName) . '</strong>' : '' ?></td>
                <td><code><?= h((string) $row['env_name']) ?></code></td>
                <td><pre><?= h((string) $row['env_value']) ?></pre></td>
                <td><?= h((string) $row['updated_at']) ?></td>
              </tr>
            <?php endforeach; ?>
          <?php endforeach; ?>
        </tbody>
      </table>
    <?php endif; ?>
  </div>

  <div class="card">
    <h3>Configuration application en base</h3>
    <?php if (!$d['ok']): ?>
      <p class="small">Connexion DB indisponible.</p>
    <?php elseif (!$appConfig): ?>
      <p class="small">Aucune configuration applicative stockee.</p>
    <?php else: ?>
      <table>
        <thead><tr><th>cle</th><th>valeur</th><th>maj</th></tr></thead>
        <tbody>
          <?php foreach ($appConfig as $row): ?>
            <tr>
              <td><strong><?= h((string) $row['config_key']) ?></strong></td>
              <td><pre><?= h(is_string($row['config_value']) ? $row['config_value'] : json_encode($row['config_value'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) ?></pre></td>
              <td><?= h((string) $row['updated_at']) ?></td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    <?php endif; ?>
  </div>

  <div class="card">
    <h3>Runtime PHP</h3>
    <input id="env-filter" type="text" placeholder="Filtrer par nom ou contenu">
    <table style="margin-top:12px">
      <thead><tr><th>cle</th><th>valeur</th></tr></thead>
      <tbody>
        <?php foreach ($runtimeEnv as $key => $value): ?>
          <tr data-filter="<?= h($key . ' ' . $value) ?>">
            <td><strong><?= h($key) ?></strong></td>
            <td><pre><?= h($value) ?></pre></td>
          </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
</div>
