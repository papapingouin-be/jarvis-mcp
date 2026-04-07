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
$scanPayload = null;
$scanError = null;
$diskByScriptName = [];

try {
    $scanPayload = registry_run_json('scan-scripts', 'collect', false);
} catch (Throwable $e) {
    $scanError = $e->getMessage();
}

foreach ((array) ($scanPayload['scripts'] ?? []) as $script) {
    $metadata = is_array($script['metadata'] ?? null) ? $script['metadata'] : [];
    $scriptName = trim((string) ($metadata['script_name'] ?? ''));
    if ($scriptName === '') {
        continue;
    }
    $diskByScriptName[$scriptName] = $script;
}
?>
<div class="stack" data-page-version="<?= h(jarvis_file_version(__FILE__)) ?>">
    <div class="notice">
        Catalogue local base sur la registry. Il expose maintenant la version DB, la version detectee sur disque et leur coherence.
    </div>

    <?php if ($scanError !== null): ?>
        <?= jarvis_render_notice('<pre>' . h($scanError) . '</pre>', 'warning') ?>
    <?php endif; ?>

    <div class="card">
        <h3>Catalogue scripts</h3>
        <table>
            <thead>
                <tr>
                    <th>script_name</th>
                    <th>file_name</th>
                    <th>version DB</th>
                    <th>version disque</th>
                    <th>etat version</th>
                    <th>description</th>
                    <th>history</th>
                    <th>updated_at</th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($rows as $r): ?>
                    <?php
                    $diskScript = $diskByScriptName[(string) $r['script_name']] ?? [];
                    $diskMetadata = is_array($diskScript['metadata'] ?? null) ? $diskScript['metadata'] : [];
                    $comparison = jarvis_version_compare($r['version'] ?? '', $diskMetadata['version'] ?? '');
                    ?>
                    <tr>
                        <td><strong><?= h($r['script_name']) ?></strong></td>
                        <td><code><?= h($r['file_name']) ?></code></td>
                        <td><code><?= h(jarvis_version_value($r['version'] ?? '')) ?></code></td>
                        <td><code><?= h(jarvis_version_value($diskMetadata['version'] ?? '')) ?></code></td>
                        <td><span class="status <?= h($comparison['class']) ?>"><?= h($comparison['label']) ?></span></td>
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
                        <td><code><?= h(jarvis_version_value($row['version'] ?? '')) ?></code></td>
                        <td><code><?= h((string) ($row['file_name'] ?? '')) ?></code></td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </div>
</div>
