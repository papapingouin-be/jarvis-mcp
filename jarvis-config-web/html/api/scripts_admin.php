<?php

require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
if (!$d['ok']) {
    echo jarvis_render_notice('<pre>' . h($d['message']) . '</pre>', 'error');
    exit;
}

$pdo = $d['pdo'];
if (!table_exists($pdo, 'jarvis_script_registry')) {
    echo jarvis_render_notice('La table <code>jarvis_script_registry</code> n existe pas. Lance le SQL fourni.', 'warning');
    exit;
}

$msg = '';
$type = 'success';
$syncResult = null;

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        jarvis_check_csrf();
        $action = trim((string) ($_POST['form_action'] ?? ''));

        if ($action === 'toggle') {
            registry_toggle($pdo, trim((string) ($_POST['script_name'] ?? '')));
            $msg = 'Etat du script mis a jour.';
        } elseif ($action === 'delete') {
            $scriptName = trim((string) ($_POST['script_name'] ?? ''));
            registry_delete($pdo, $scriptName);
            $msg = 'Script supprime de la registry.';
        } elseif ($action === 'install_script' || $action === 'install_script_overwrite') {
            $relativePath = trim((string) ($_POST['relative_path'] ?? ''));
            $installResult = install_script_into_runtime($relativePath, $action === 'install_script_overwrite');
            $msg = 'Script installe dans le systeme Jarvis : ' . $installResult['relative_path'] . '. Lance ensuite la synchronisation DB.';
            jarvis_append_log('scripts-admin', (string) $installResult['relative_path'], 'installed', (string) $installResult['target']);
        } elseif ($action === 'sync_preview' || $action === 'sync_apply') {
            $disableMissing = isset($_POST['disable_missing']) ? 'true' : 'false';
            $dryRun = $action === 'sync_preview' ? 'true' : 'false';

            $syncResult = registry_run_json('sync-registry', 'execute', true, [
                'dry_run' => $dryRun,
                'disable_missing' => $disableMissing,
            ]);

            $msg = $action === 'sync_preview'
                ? 'Dry-run de synchronisation termine.'
                : 'Synchronisation de la registry terminee.';
        }
    }
} catch (Throwable $e) {
    $msg = $e->getMessage();
    $type = 'error';
}

$rows = registry_all($pdo);
$dbByScriptName = [];
foreach ($rows as $row) {
    $dbByScriptName[(string) $row['script_name']] = $row;
}

$scanPayload = null;
$scanError = null;

try {
    $scanPayload = registry_run_json('scan-scripts', 'collect', false);
} catch (Throwable $e) {
    $scanError = $e->getMessage();
}

$discoveredScripts = is_array($scanPayload['scripts'] ?? null) ? $scanPayload['scripts'] : [];
$compatibleScripts = array_values(array_filter(
    $discoveredScripts,
    static fn(array $script): bool => !empty($script['registry_compatible'])
));
$incompatibleScripts = array_values(array_filter(
    $discoveredScripts,
    static fn(array $script): bool => empty($script['registry_compatible'])
));
$installCatalogScripts = scan_install_catalog_scripts();
$runtimeScripts = scan_scripts();
$runtimeScriptMap = array_fill_keys($runtimeScripts, true);
?>
<div class="stack">
  <div class="notice">
    Cette page ne cree plus les scripts a la main. Elle lit l inventaire publie par les scripts,
    puis synchronise la DB via <code>jarvis-script-registry.sh</code>.
  </div>

  <?php if ($msg !== ''): ?>
    <?= jarvis_render_notice(h($msg), $type) ?>
  <?php endif; ?>

  <?php if (!registry_script_available()): ?>
    <?= jarvis_render_notice('Le script <code>jarvis-script-registry.sh</code> est introuvable dans <code>' . h(scripts_root()) . '</code>. Copie-le d abord sur la cible Linux.', 'error') ?>
  <?php endif; ?>

  <div class="two">
    <div class="card">
      <h3>Installer un script dans Jarvis</h3>
      <p class="small">
        Le catalogue d installation est lu depuis <code><?= h(script_install_catalog_root()) ?></code>.
        Le dossier runtime Jarvis est <code><?= h(scripts_root()) ?></code>.
      </p>
      <?php if (!$installCatalogScripts): ?>
        <p class="small">Aucun script disponible dans le catalogue d installation.</p>
      <?php else: ?>
        <table>
          <thead>
            <tr>
              <th>script catalogue</th>
              <th>present dans Jarvis</th>
              <th>action</th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($installCatalogScripts as $catalogScript): ?>
              <?php $alreadyInstalled = isset($runtimeScriptMap[$catalogScript]); ?>
              <tr>
                <td><code><?= h($catalogScript) ?></code></td>
                <td><span class="status <?= $alreadyInstalled ? 'up' : 'warn' ?>"><?= $alreadyInstalled ? 'OUI' : 'NON' ?></span></td>
                <td>
                  <div class="actions">
                    <form method="post">
                      <?= jarvis_csrf_input() ?>
                      <input type="hidden" name="form_action" value="install_script">
                      <input type="hidden" name="relative_path" value="<?= h($catalogScript) ?>">
                      <button class="secondary-btn" type="submit" <?= $alreadyInstalled ? 'disabled' : '' ?>>Installer</button>
                    </form>
                    <?php if ($alreadyInstalled): ?>
                      <form method="post">
                        <?= jarvis_csrf_input() ?>
                        <input type="hidden" name="form_action" value="install_script_overwrite">
                        <input type="hidden" name="relative_path" value="<?= h($catalogScript) ?>">
                        <button class="ghost-btn" type="submit" data-confirm="Ecraser <?= h($catalogScript) ?> dans le systeme Jarvis ?">Ecraser</button>
                      </form>
                    <?php endif; ?>
                  </div>
                </td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>

    <div class="card">
      <h3>Synchronisation DB</h3>
      <p class="small">
        Le dry-run compare le disque et la DB sans ecriture.
        La synchronisation applique insertions, mises a jour, et desactivation optionnelle.
      </p>
      <form method="post">
        <?= jarvis_csrf_input() ?>
        <p><label><input type="checkbox" name="disable_missing" value="1"> Desactiver en DB les scripts absents du disque</label></p>
        <div class="actions">
          <button class="secondary-btn" type="submit" name="form_action" value="sync_preview">Dry-run sync</button>
          <button class="primary-btn" type="submit" name="form_action" value="sync_apply" data-confirm="Appliquer la synchronisation de la registry ?">Synchroniser la DB</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h3>Resume</h3>
      <div class="grid">
        <div class="kpi"><div class="label">DB</div><div class="value"><?= h(count($rows)) ?></div></div>
        <div class="kpi"><div class="label">Compatibles</div><div class="value"><?= h(count($compatibleScripts)) ?></div></div>
        <div class="kpi"><div class="label">Incompatibles</div><div class="value"><?= h(count($incompatibleScripts)) ?></div></div>
      </div>
      <?php if ($scanPayload !== null): ?>
        <p class="small"><?= h((string) ($scanPayload['summary'] ?? '')) ?></p>
      <?php elseif ($scanError !== null): ?>
        <p class="small"><?= h($scanError) ?></p>
      <?php endif; ?>
    </div>
  </div>

  <?php if (is_array($syncResult)): ?>
    <div class="card">
      <h3>Resultat sync</h3>
      <pre><?= h(json_encode($syncResult, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre>
    </div>
  <?php endif; ?>

  <div class="card">
    <h3>Scripts en DB</h3>
    <table>
      <thead>
        <tr>
          <th>script_name</th>
          <th>file_name</th>
          <th>description</th>
          <th>required_env_json</th>
          <th>actif</th>
          <th>fichier</th>
          <th>actions</th>
        </tr>
      </thead>
      <tbody>
        <?php foreach ($rows as $row): ?>
          <?php $found = is_file(script_abs((string) $row['file_name'])); ?>
          <tr>
            <td><strong><?= h((string) $row['script_name']) ?></strong></td>
            <td><code><?= h((string) $row['file_name']) ?></code></td>
            <td><?= h((string) $row['description']) ?></td>
            <td><pre><?= h((string) $row['required_env_json']) ?></pre></td>
            <td><span class="status <?= ((bool) $row['is_active']) ? 'up' : 'warn' ?>"><?= ((bool) $row['is_active']) ? 'YES' : 'NO' ?></span></td>
            <td><span class="status <?= $found ? 'up' : 'down' ?>"><?= $found ? 'TROUVE' : 'MANQUANT' ?></span></td>
            <td>
              <div class="actions">
                <form method="post">
                  <?= jarvis_csrf_input() ?>
                  <input type="hidden" name="form_action" value="toggle">
                  <input type="hidden" name="script_name" value="<?= h((string) $row['script_name']) ?>">
                  <button class="ghost-btn" type="submit"><?= ((bool) $row['is_active']) ? 'Desactiver' : 'Activer' ?></button>
                </form>
                <form method="post">
                  <?= jarvis_csrf_input() ?>
                  <input type="hidden" name="form_action" value="delete">
                  <input type="hidden" name="script_name" value="<?= h((string) $row['script_name']) ?>">
                  <button class="danger-btn" type="submit" data-confirm="Supprimer <?= h((string) $row['script_name']) ?> ?">Supprimer</button>
                </form>
              </div>
            </td>
          </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h3>Scripts detectes sur disque</h3>
    <?php if ($scanError !== null): ?>
      <?= jarvis_render_notice('<pre>' . h($scanError) . '</pre>', 'error') ?>
    <?php elseif (!$discoveredScripts): ?>
      <p class="small">Aucun script detecte.</p>
    <?php else: ?>
      <table>
        <thead>
          <tr>
            <th>file_name</th>
            <th>script_name</th>
            <th>etat registry</th>
            <th>description</th>
            <th>required_env</th>
            <th>services</th>
            <th>erreur</th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($discoveredScripts as $script): ?>
            <?php
            $metadata = is_array($script['metadata'] ?? null) ? $script['metadata'] : [];
            $scriptName = (string) ($metadata['script_name'] ?? '');
            $dbState = $scriptName !== '' && isset($dbByScriptName[$scriptName]) ? 'EN DB' : 'HORS DB';
            $requiredEnv = is_array($metadata['required_env'] ?? null) ? $metadata['required_env'] : [];
            $services = is_array($metadata['services'] ?? null) ? $metadata['services'] : [];
            ?>
            <tr>
              <td><code><?= h((string) ($script['file_name'] ?? '')) ?></code></td>
              <td><?= h($scriptName !== '' ? $scriptName : '-') ?></td>
              <td>
                <span class="status <?= !empty($script['registry_compatible']) ? 'up' : 'down' ?>">
                  <?= !empty($script['registry_compatible']) ? h($dbState) : 'INCOMPATIBLE' ?>
                </span>
              </td>
              <td><?= h((string) ($metadata['description'] ?? '')) ?></td>
              <td><?= h((string) count($requiredEnv)) ?></td>
              <td><?= h((string) count($services)) ?></td>
              <td><pre><?= h((string) ($script['error'] ?? '')) ?></pre></td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    <?php endif; ?>
  </div>
</div>
