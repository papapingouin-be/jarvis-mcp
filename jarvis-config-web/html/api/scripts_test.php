<?php
require_once __DIR__ . '/../inc/bootstrap.php';

$d = db_try();
if (!$d['ok']) {
    echo jarvis_render_notice('<pre>' . h($d['message']) . '</pre>', 'error');
    exit;
}

$pdo = $d['pdo'];
if (!table_exists($pdo, 'jarvis_script_registry')) {
    echo jarvis_render_notice('La table <code>jarvis_script_registry</code> n existe pas.', 'warning');
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        jarvis_check_csrf();
        $name = trim((string) ($_POST['script_name'] ?? ''));
        $phase = trim((string) ($_POST['phase'] ?? 'check'));
        $confirmed = ((string) ($_POST['confirmed'] ?? 'false') === 'true');
        $mode = trim((string) ($_POST['mode'] ?? 'precheck'));
        $params = validate_params_json((string) ($_POST['params_json'] ?? '{}'));

        if ($name === '') {
            throw new RuntimeException('script_name obligatoire.');
        }

        $pc = precheck($pdo, $name);
        $row = $pc['row'];
        $cmd = build_cmd((string) $row['file_name'], $phase, $confirmed, $params);

        echo '<div class="card"><h3>Pre-check</h3><table><thead><tr><th>point</th><th>etat</th><th>detail</th></tr></thead><tbody>';
        echo '<tr><td>script en DB</td><td><span class="status up">OK</span></td><td><code>' . h($row['script_name']) . '</code></td></tr>';
        echo '<tr><td>actif</td><td><span class="status ' . ($pc['active'] ? 'up' : 'warn') . '">' . ($pc['active'] ? 'YES' : 'NO') . '</span></td><td>' . h((string) $row['is_active']) . '</td></tr>';
        echo '<tr><td>fichier present</td><td><span class="status ' . ($pc['file_found'] ? 'up' : 'down') . '">' . ($pc['file_found'] ? 'YES' : 'NO') . '</span></td><td><code>' . h((string) $row['file_name']) . '</code></td></tr>';
        echo '<tr><td>config DB scripts</td><td><span class="status ' . ($pc['script_env_count'] > 0 ? 'up' : 'warn') . '">' . h((string) $pc['script_env_count']) . '</span></td><td>' . ($pc['script_env_count'] > 0 ? h(implode(', ', array_keys($pc['script_env']))) : 'Aucune variable chargee depuis jarvis_script_env_values') . '</td></tr>';
        echo '<tr><td>variables requises</td><td><span class="status ' . (count($pc['missing']) === 0 ? 'up' : 'warn') . '">' . (count($pc['missing']) === 0 ? 'OK' : 'MANQUANTES') . '</span></td><td>' . (count($pc['missing']) === 0 ? 'Toutes presentes en DB' : h(implode(', ', $pc['missing']))) . '</td></tr>';
        echo '</tbody></table></div>';
        echo '<div class="card"><h3>Commande simulee</h3><pre>' . h($cmd) . '</pre><p class="small">Les variables de script sont injectees depuis la DB au moment de l execution.</p></div>';

        if ($mode === 'precheck') {
            echo jarvis_render_notice('Pre-check termine. Rien n a ete execute.', 'info');
            exit;
        }

        if (!$pc['active']) {
            throw new RuntimeException('Le script est inactif.');
        }

        if (!$pc['file_found']) {
            throw new RuntimeException('Le fichier script est introuvable.');
        }

        if (count($pc['missing']) > 0) {
            throw new RuntimeException('Variables manquantes en base : ' . implode(', ', $pc['missing']));
        }

        if ($mode === 'simulate') {
            echo jarvis_render_notice('Simulation OK. Rien n a ete execute.', 'success');
            exit;
        }

        if ($mode !== 'execute') {
            throw new RuntimeException('Mode inconnu.');
        }

        $out = run_script_command($cmd, $pc['script_env']);
        jarvis_append_log('scripts-test', $name, 'executed', substr($out, 0, 800));
        echo '<div class="card"><h3>Retour script</h3><pre>' . h($out) . '</pre></div>';
        exit;
    } catch (Throwable $e) {
        echo jarvis_render_notice('<strong>Erreur test script :</strong><br><pre>' . h($e->getMessage()) . '</pre>', 'error');
        exit;
    }
}

$rows = registry_all($pdo);
?>
<div class="stack"><div class="notice">3 niveaux : <strong>pre-check</strong>, <strong>simulation</strong>, <strong>execution reelle</strong>.</div><div class="two"><div class="card"><h3>Parametres de test</h3><form id="scripts-test-form" method="post"><?= jarvis_csrf_input() ?><p><label>Script</label><select name="script_name"><option value="">-- Choisir un script --</option><?php foreach($rows as $r): ?><option value="<?= h($r['script_name']) ?>"><?= h($r['script_name']) ?> - <?= h($r['description']) ?></option><?php endforeach; ?></select></p><p><label>Phase</label><input type="text" name="phase" value="collect"></p><p><label>Confirmed</label><select name="confirmed"><option value="false">false</option><option value="true">true</option></select></p><p><label>Mode</label><select name="mode"><option value="precheck">Pre-check</option><option value="simulate">Simulation</option><option value="execute">Execution reelle</option></select></p><p><label>params JSON</label><textarea name="params_json">{}</textarea></p><div class="actions"><button class="primary-btn" type="submit">Lancer le test</button></div></form></div><div class="card"><h3>Convention supportee</h3><pre>bash /var/www/data/scripts/&lt;fichier&gt;
  --phase &lt;phase&gt;
  --confirmed &lt;true|false&gt;
  --param key=value</pre><p class="small">Le runner PHP injecte les variables requises depuis <code>jarvis_script_env_values</code>.</p></div></div><div id="scripts-test-result" class="card"><h3>Resultat</h3><p class="small">Le resultat du test apparaitra ici.</p></div></div>
