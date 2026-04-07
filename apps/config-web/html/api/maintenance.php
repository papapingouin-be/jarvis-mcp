<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
$pdo = $d['ok'] ? $d['pdo'] : null;
$files = scan_scripts();
$msg = '';
$type = 'success';
$scanPayload = null;
$scanError = null;
$syncResult = null;

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        jarvis_check_csrf();
        $action = trim((string) ($_POST['form_action'] ?? ''));

        if ($action === 'registry_preview' || $action === 'registry_apply') {
            $disableMissing = isset($_POST['disable_missing']) ? 'true' : 'false';
            $dryRun = $action === 'registry_preview' ? 'true' : 'false';

            $syncResult = registry_run_json('sync-registry', 'execute', true, [
                'dry_run' => $dryRun,
                'disable_missing' => $disableMissing,
            ]);

            $msg = $action === 'registry_preview'
                ? 'Dry-run d enregistrement termine.'
                : 'Enregistrement des scripts compatibles termine.';
        }
    }
} catch (Throwable $e) {
    $msg = $e->getMessage();
    $type = 'error';
}

try {
    $scanPayload = registry_run_json('scan-scripts', 'collect', false);
} catch (Throwable $e) {
    $scanError = $e->getMessage();
}

$dbRows = $pdo && table_exists($pdo, 'jarvis_script_registry') ? registry_all($pdo) : [];
$dbByScriptName = [];
foreach ($dbRows as $row) {
    $dbByScriptName[(string) $row['script_name']] = $row;
}

$discoveredScripts = is_array($scanPayload['scripts'] ?? null) ? $scanPayload['scripts'] : [];
?>
<div class="stack">
    <div class="notice">
        Inventaire des fichiers scripts visibles par l UI. Depuis cette page, tu peux aussi enregistrer en DB tous les scripts compatibles exposes par le registry.
    </div>

    <?php if ($msg !== ''): ?>
        <?= jarvis_render_notice(h($msg), $type) ?>
    <?php endif; ?>

    <div class="two">
        <div class="card">
            <h3>Actions registry</h3>
            <p class="small">
                L enregistrement en DB se fait pour tous les scripts compatibles du dossier
                <code><?= h(scripts_root()) ?></code>.
            </p>
            <?php if (!registry_script_available()): ?>
                <?= jarvis_render_notice('Le script <code>jarvis-script-registry.sh</code> est introuvable dans <code>' . h(scripts_root()) . '</code>.', 'error') ?>
            <?php else: ?>
                <form method="post" data-async-fragment="maintenance">
                    <?= jarvis_csrf_input() ?>
                    <p><label><input type="checkbox" name="disable_missing" value="1"> Desactiver en DB les scripts absents du disque</label></p>
                    <div class="actions">
                        <button class="secondary-btn" type="submit" name="form_action" value="registry_preview">Dry-run enregistrement</button>
                        <button class="primary-btn" type="submit" name="form_action" value="registry_apply" data-confirm="Enregistrer les scripts compatibles visibles sur disque dans la DB ?">Enregistrer en DB</button>
                    </div>
                </form>
            <?php endif; ?>
        </div>

        <div class="card">
            <h3>Resume</h3>
            <div class="grid">
                <div class="kpi"><div class="label">Disque</div><div class="value"><?= h(count($files)) ?></div></div>
                <div class="kpi"><div class="label">Compatibles</div><div class="value"><?= h((string) count(array_filter($discoveredScripts, static fn(array $s): bool => !empty($s['registry_compatible'])))) ?></div></div>
                <div class="kpi"><div class="label">En DB</div><div class="value"><?= h(count($dbRows)) ?></div></div>
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
            <h3>Resultat enregistrement</h3>
            <pre><?= h(json_encode($syncResult, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre>
        </div>
    <?php endif; ?>

    <div class="card">
        <h3>Scripts disque</h3>
        <table>
            <thead>
                <tr>
                    <th>chemin relatif</th>
                    <th>taille</th>
                    <th>modifie</th>
                    <th>executable</th>
                    <th>registry</th>
                    <th>script_name</th>
                    <th>DB</th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($files as $f): ?>
                    <?php
                    $abs = script_abs($f);
                    $registryInfo = null;
                    foreach ($discoveredScripts as $candidate) {
                        if ((string) ($candidate['file_name'] ?? '') === $f) {
                            $registryInfo = $candidate;
                            break;
                        }
                    }
                    $metadata = is_array($registryInfo['metadata'] ?? null) ? $registryInfo['metadata'] : [];
                    $scriptName = trim((string) ($metadata['script_name'] ?? ''));
                    $inDb = $scriptName !== '' && isset($dbByScriptName[$scriptName]);
                    ?>
                    <tr>
                        <td><code><?= h($f) ?></code></td>
                        <td><?= h((string) filesize($abs)) ?> o</td>
                        <td><?= h(date('Y-m-d H:i:s', filemtime($abs))) ?></td>
                        <td><span class="status <?= is_executable($abs) ? 'up' : 'warn' ?>"><?= is_executable($abs) ? 'YES' : 'NO' ?></span></td>
                        <td>
                            <?php if ($registryInfo === null): ?>
                                <span class="status warn">NON SCANNE</span>
                            <?php elseif (!empty($registryInfo['registry_compatible'])): ?>
                                <span class="status up">COMPATIBLE</span>
                            <?php else: ?>
                                <span class="status down">INCOMPATIBLE</span>
                            <?php endif; ?>
                        </td>
                        <td><?= h($scriptName !== '' ? $scriptName : '-') ?></td>
                        <td>
                            <span class="status <?= $inDb ? 'up' : 'warn' ?>">
                                <?= $inDb ? 'ENREGISTRE' : 'NON' ?>
                            </span>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </div>

    <?php if ($scanError !== null): ?>
        <div class="card">
            <h3>Erreur registry</h3>
            <pre><?= h($scanError) ?></pre>
        </div>
    <?php endif; ?>
</div>
