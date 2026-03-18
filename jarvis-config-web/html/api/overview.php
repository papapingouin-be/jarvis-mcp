<?php require_once __DIR__.'/../inc/bootstrap.php'; $d=db_try(); $pdo=$d['ok']?$d['pdo']:null; $rows=$pdo&&table_exists($pdo,'jarvis_script_registry')?registry_all($pdo):[]; $disk=scan_scripts(); ?>
<div class="grid">
  <div class="kpi"><div class="label">DB</div><div class="value"><?= $d['ok']?'OK':'KO' ?></div></div>
  <div class="kpi"><div class="label">Scripts DB</div><div class="value"><?= h(count($rows)) ?></div></div>
  <div class="kpi"><div class="label">Scripts disque</div><div class="value"><?= h(count($disk)) ?></div></div>
  <div class="kpi"><div class="label">ENV visibles</div><div class="value"><?= h(count(env_all())) ?></div></div>
</div>
<div class="notice">V7.1 remet les outils utiles et ajoute l’adaptation MCP : descriptions, sous-dossiers scripts, test MCP, SQL runner, diagnostics, services.</div>
