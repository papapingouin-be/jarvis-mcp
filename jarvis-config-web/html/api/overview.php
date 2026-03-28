<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
$pdo = $d['ok'] ? $d['pdo'] : null;
$rows = $pdo && table_exists($pdo, 'jarvis_script_registry') ? registry_all($pdo) : [];
$disk = scan_scripts();
$scriptEnvRows = $pdo ? script_env_rows($pdo) : [];
$scanPayload = null;
$scanError = null;
$versionOk = 0;
$versionDiff = 0;

if ($pdo !== null && registry_script_available()) {
    try {
        $scanPayload = registry_run_json('scan-scripts', 'collect', false);
    } catch (Throwable $e) {
        $scanError = $e->getMessage();
    }
}

$discoveredScripts = is_array($scanPayload['scripts'] ?? null) ? $scanPayload['scripts'] : [];
$diskByScriptName = [];
foreach ($discoveredScripts as $script) {
    $metadata = is_array($script['metadata'] ?? null) ? $script['metadata'] : [];
    $scriptName = trim((string) ($metadata['script_name'] ?? ''));
    if ($scriptName === '') {
        continue;
    }
    $diskByScriptName[$scriptName] = $script;
}

foreach ($rows as $row) {
    $scriptName = (string) ($row['script_name'] ?? '');
    $diskVersion = $diskByScriptName[$scriptName]['metadata']['version'] ?? '';
    $comparison = jarvis_version_compare($row['version'] ?? '', $diskVersion);
    if ($comparison['label'] === 'OK') {
        $versionOk++;
    } elseif ($comparison['label'] === 'DIFF') {
        $versionDiff++;
    }
}
?>
<div class="grid">
  <div class="kpi"><div class="label">UI</div><div class="value"><?= h(jarvis_ui_version()) ?></div></div>
  <div class="kpi"><div class="label">DB</div><div class="value"><?= $d['ok']?'OK':'KO' ?></div></div>
  <div class="kpi"><div class="label">Scripts DB</div><div class="value"><?= h(count($rows)) ?></div></div>
  <div class="kpi"><div class="label">Scripts disque</div><div class="value"><?= h(count($disk)) ?></div></div>
  <div class="kpi"><div class="label">Vars scripts DB</div><div class="value"><?= h(count($scriptEnvRows)) ?></div></div>
  <div class="kpi"><div class="label">Versions OK</div><div class="value"><?= h((string) $versionOk) ?></div></div>
  <div class="kpi"><div class="label">Versions DIFF</div><div class="value"><?= h((string) $versionDiff) ?></div></div>
</div>
<div class="notice">La configuration des scripts est maintenant lue depuis la DB. Le runtime PHP reste visible separement dans l onglet ENV.</div>
<?php if ($scanError !== null): ?>
  <div class="notice warning">Comparaison des versions indisponible : <code><?= h($scanError) ?></code></div>
<?php endif; ?>
