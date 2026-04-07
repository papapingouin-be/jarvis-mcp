<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
if (!$d['ok']) {
    echo jarvis_render_notice('<pre>' . h($d['message']) . '</pre>', 'error');
    exit;
}

$rows = app_config_all($d['pdo']);

echo '<h2>Config DB</h2>';
echo '<table>';
echo '<thead><tr><th>config_key</th><th>config_value</th><th>updated_at</th></tr></thead><tbody>';

foreach ($rows as $row) {
    $value = is_string($row['config_value']) ? $row['config_value'] : json_encode($row['config_value'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    echo '<tr>';
    echo '<td>' . h((string) $row['config_key']) . '</td>';
    echo '<td><pre>' . h((string) $value) . '</pre></td>';
    echo '<td>' . h((string) $row['updated_at']) . '</td>';
    echo '</tr>';
}

echo '</tbody></table>';
