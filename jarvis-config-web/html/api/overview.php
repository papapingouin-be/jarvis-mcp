<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
$pdo = $d['ok'] ? $d['pdo'] : null;
$rows = $pdo && table_exists($pdo, 'jarvis_script_registry') ? registry_all($pdo) : [];
$disk = scan_scripts();
$scriptEnvRows = $pdo ? script_env_rows($pdo) : [];
?>
<div class="grid">
  <div class="kpi"><div class="label">DB</div><div class="value"><?= $d['ok']?'OK':'KO' ?></div></div>
  <div class="kpi"><div class="label">Scripts DB</div><div class="value"><?= h(count($rows)) ?></div></div>
  <div class="kpi"><div class="label">Scripts disque</div><div class="value"><?= h(count($disk)) ?></div></div>
  <div class="kpi"><div class="label">Vars scripts DB</div><div class="value"><?= h(count($scriptEnvRows)) ?></div></div>
</div>
<div class="notice">La configuration des scripts est maintenant lue depuis la DB. Le runtime PHP reste visible separement dans l onglet ENV.</div>
