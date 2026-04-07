<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
$pdo = $d['ok'] ? $d['pdo'] : null;
$scriptEnvRows = $pdo ? script_env_rows($pdo) : [];
$transportValue = runtime_config_value($pdo, 'server.transport', 'JARVIS_MCP_TRANSPORT');
if ($transportValue === null) {
    $transportValue = runtime_config_value($pdo, 'server.transport', 'STARTER_TRANSPORT');
}

$checks = [
    [
        'label' => 'Connexion DB',
        'ok' => $d['ok'],
        'detail' => $d['message'],
        'action' => 'Verifier JARVIS_PG_HOST / JARVIS_PG_DB / JARVIS_PG_USER / JARVIS_PG_PASSWORD',
    ],
    [
        'label' => 'MASTER_KEY',
        'ok' => env_value('MASTER_KEY') !== null || env_value('MASTER_KEY_FILE') !== null,
        'detail' => 'Toujours geree par le runtime PHP, pas par la DB de scripts.',
        'action' => 'Ajouter MASTER_KEY ou MASTER_KEY_FILE dans le service jarvis_config_web',
    ],
    [
        'label' => 'Transport serveur',
        'ok' => $transportValue !== null,
        'detail' => 'Valeur resolue : ' . ($transportValue ?? 'absente'),
        'action' => 'Definir server.transport en base ou JARVIS_MCP_TRANSPORT dans l environnement',
    ],
    [
        'label' => 'Port serveur',
        'ok' => runtime_config_value($pdo, 'server.port', 'PORT') !== null,
        'detail' => 'Valeur resolue : ' . (runtime_config_value($pdo, 'server.port', 'PORT') ?? 'absente'),
        'action' => 'Definir server.port en base ou PORT dans l environnement',
    ],
    [
        'label' => 'Config scripts en base',
        'ok' => count($scriptEnvRows) > 0,
        'detail' => 'Nombre de variables en base : ' . count($scriptEnvRows),
        'action' => 'Alimenter jarvis_script_env_values avant de tester un script',
    ],
    [
        'label' => 'Scripts visibles sur disque',
        'ok' => count(scan_scripts()) > 0,
        'detail' => 'Nombre detecte : ' . count(scan_scripts()),
        'action' => 'Verifier le montage volume vers le dossier scripts configure',
    ],
];
?>
<div class="stack"><div class="notice">Cette page te donne des reponses actionnables, en distinguant runtime et configuration stockee en base.</div><div class="card"><table><thead><tr><th>point</th><th>etat</th><th>detail</th><th>action</th></tr></thead><tbody><?php foreach($checks as $c): ?><tr><td><?= h($c['label']) ?></td><td><span class="status <?= $c['ok']?'up':'warn' ?>"><?= $c['ok']?'OK':'A CORRIGER' ?></span></td><td><pre><?= h($c['detail']) ?></pre></td><td><button class="copy-btn" data-copy="<?= h($c['action']) ?>">Copier</button></td></tr><?php endforeach; ?></tbody></table></div></div>
