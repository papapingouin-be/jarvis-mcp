<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
$pdo = $d['ok'] ? $d['pdo'] : null;
$runtimeEnv = env_all();
$scriptEnv = $pdo ? script_env_grouped($pdo) : [];
$appConfig = $pdo ? app_config_all($pdo) : [];
?>
<div class="stack">
  <div class="notice">Cette vue distingue le runtime PHP des variables de scripts stockees en base.</div>

  <div class="grid">
    <div class="kpi"><div class="label">Runtime ENV</div><div class="value"><?= h(count($runtimeEnv)) ?></div></div>
    <div class="kpi"><div class="label">Configs DB</div><div class="value"><?= h(count($appConfig)) ?></div></div>
    <div class="kpi"><div class="label">Scripts avec config</div><div class="value"><?= h(count($scriptEnv)) ?></div></div>
  </div>

  <?php if (!$d['ok']): ?>
    <?= jarvis_render_notice('<pre>' . h($d['message']) . '</pre>', 'warning') ?>
  <?php endif; ?>

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
