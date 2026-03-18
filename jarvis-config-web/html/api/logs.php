<?php require_once __DIR__.'/../inc/bootstrap.php'; $f=jarvis_log_file(); ?>
<div class="stack"><div class="card"><h3>Historique</h3><?= is_file($f)?'<pre>'.h((string)file_get_contents($f)).'</pre>':'<p class="small">Aucune action enregistrée.</p>' ?></div></div>
