<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
if (!$d['ok']) {
    echo jarvis_render_notice('<pre>' . h($d['message']) . '</pre>', 'error');
    exit;
}

$pdo = $d['pdo'];
$rows = table_exists($pdo, 'jarvis_script_registry') ? registry_all($pdo) : [];
$history = registry_history($pdo, null, 50);
?>
<div class="stack">
    <div class="notice">
        Catalogue local base sur la registry. Il expose maintenant la version courante et l historique recent de chaque script.
    </div>

    <div class="card">
        <h3>Catalogue scripts</h3>
        <table>
            <thead>
                <tr>
                    <th>script_name</th>
                    <th>file_name</th>
                    <th>version</th>
                    <th>description</th>
                    <th>history</th>
                    <th>updated_at</th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($rows as $r): ?>
                    <tr>
                        <td><strong><?= h($r['script_name']) ?></strong></td>
                        <td><code><?= h($r['file_name']) ?></code></td>
                        <td><code><?= h((string) ($r['version'] ?? '')) ?></code></td>
                        <td><?= h($r['description']) ?></td>
                        <td>
                            <?= h((string) ($r['history_count'] ?? '0')) ?>
                            <?php if (!empty($r['last_changed_at'])): ?>
                                <div><small><?= h((string) $r['last_changed_at']) ?></small></div>
                            <?php endif; ?>
                        </td>
                        <td><?= h((string) ($r['updated_at'] ?? '')) ?></td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </div>

    <div class="card">
        <h3>Historique recent</h3>
        <table>
            <thead>
                <tr>
                    <th>changed_at</th>
                    <th>script_name</th>
                    <th>change_type</th>
                    <th>version</th>
                    <th>file_name</th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($history as $row): ?>
                    <tr>
                        <td><?= h((string) ($row['changed_at'] ?? '')) ?></td>
                        <td><strong><?= h((string) ($row['script_name'] ?? '')) ?></strong></td>
                        <td><code><?= h((string) ($row['change_type'] ?? '')) ?></code></td>
                        <td><code><?= h((string) ($row['version'] ?? '')) ?></code></td>
                        <td><code><?= h((string) ($row['file_name'] ?? '')) ?></code></td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </div>
</div>
