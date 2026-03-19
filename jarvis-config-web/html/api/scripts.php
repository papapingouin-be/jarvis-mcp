<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
if (!$d['ok']) {
    echo jarvis_render_notice('<pre>' . h($d['message']) . '</pre>', 'error');
    exit;
}

$pdo = $d['pdo'];

if (isset($_GET['run'])) {
    $name = trim((string) $_GET['run']);
    $pc = precheck($pdo, $name);

    if (!$pc['active']) {
        throw new RuntimeException('Le script est inactif.');
    }

    if (!$pc['file_found']) {
        throw new RuntimeException('Le fichier script est introuvable.');
    }

    if (count($pc['missing']) > 0) {
        throw new RuntimeException('Variables manquantes en base : ' . implode(', ', $pc['missing']));
    }

    $out = run_script_command(build_cmd((string) $pc['row']['file_name'], 'collect', false, []), $pc['script_env']);
    jarvis_append_log('scripts', $name, 'executed', substr($out, 0, 800));
    echo '<pre>' . h($out) . '</pre>';
    exit;
}

$res = registry_all($pdo);

echo '<h2>Scripts</h2>';
echo '<table>';
echo '<thead><tr><th>script_name</th><th>file_name</th><th>is_active</th><th>vars DB</th><th>action</th></tr></thead><tbody>';

foreach ($res as $row) {
    $scriptName = (string) $row['script_name'];
    $scriptEnv = script_env_values($pdo, $scriptName);
    echo '<tr>';
    echo '<td>' . h($scriptName) . '</td>';
    echo '<td>' . h((string) $row['file_name']) . '</td>';
    echo '<td>' . h((string) $row['is_active']) . '</td>';
    echo '<td>' . h((string) count($scriptEnv)) . '</td>';
    echo '<td><button onclick="runScript(\'' . h($scriptName) . '\')">RUN</button></td>';
    echo '</tr>';
}

echo '</tbody></table>';
