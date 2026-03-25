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

if ($_SERVER['REQUEST_METHOD'] === 'GET' && (string) ($_GET['action'] ?? '') === 'example') {
    header('Content-Type: application/json; charset=utf-8');

    try {
        $name = trim((string) ($_GET['script_name'] ?? ''));
        $phase = trim((string) ($_GET['phase'] ?? 'collect'));
        $service = trim((string) ($_GET['service'] ?? ''));

        if ($name === '') {
            throw new RuntimeException('script_name obligatoire.');
        }

        if ($name === 'proxmox-diagnose.sh' && $service !== '') {
            $serviceInfo = script_service_info($pdo, $name, $service);
            echo json_encode([
                'ok' => true,
                'example' => [
                    'script_name' => $name,
                    'phase' => (string) ($serviceInfo['phase'] ?? $phase),
                    'confirmed' => (bool) ($serviceInfo['confirmed_required'] ?? false),
                    'summary' => 'Exemple genere depuis la description du service.',
                    'notes' => [
                        'Exemple base sur le service selectionne dans le script.',
                    ],
                    'params' => (array) ($serviceInfo['example_params'] ?? []),
                    'pretty_params_json' => json_encode(
                        (array) ($serviceInfo['example_params'] ?? []),
                        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
                    ),
                ],
            ], JSON_UNESCAPED_SLASHES);
            exit;
        }

        echo json_encode([
            'ok' => true,
            'example' => script_test_example_payload($name, $phase),
        ], JSON_UNESCAPED_SLASHES);
    } catch (Throwable $e) {
        http_response_code(400);
        echo json_encode([
            'ok' => false,
            'message' => $e->getMessage(),
        ], JSON_UNESCAPED_SLASHES);
    }

    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET' && (string) ($_GET['action'] ?? '') === 'service_catalog') {
    header('Content-Type: application/json; charset=utf-8');

    try {
        $name = trim((string) ($_GET['script_name'] ?? ''));
        if ($name === '') {
            throw new RuntimeException('script_name obligatoire.');
        }

        echo json_encode([
            'ok' => true,
            'services' => script_service_catalog($pdo, $name),
        ], JSON_UNESCAPED_SLASHES);
    } catch (Throwable $e) {
        http_response_code(400);
        echo json_encode([
            'ok' => false,
            'message' => $e->getMessage(),
        ], JSON_UNESCAPED_SLASHES);
    }

    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET' && (string) ($_GET['action'] ?? '') === 'service_info') {
    header('Content-Type: application/json; charset=utf-8');

    try {
        $name = trim((string) ($_GET['script_name'] ?? ''));
        $service = trim((string) ($_GET['service'] ?? ''));
        if ($name === '' || $service === '') {
            throw new RuntimeException('script_name et service sont obligatoires.');
        }

        echo json_encode([
            'ok' => true,
            'service' => script_service_info($pdo, $name, $service),
        ], JSON_UNESCAPED_SLASHES);
    } catch (Throwable $e) {
        http_response_code(400);
        echo json_encode([
            'ok' => false,
            'message' => $e->getMessage(),
        ], JSON_UNESCAPED_SLASHES);
    }

    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && (string) ($_GET['action'] ?? '') === 'validate_service') {
    header('Content-Type: application/json; charset=utf-8');

    try {
        jarvis_check_csrf();
        $name = trim((string) ($_POST['script_name'] ?? ''));
        $service = trim((string) ($_POST['service_name'] ?? ''));
        $knownParams = validate_params_json((string) ($_POST['params_json'] ?? '{}'));

        if ($name === '' || $service === '') {
            throw new RuntimeException('script_name et service sont obligatoires.');
        }

        echo json_encode([
            'ok' => true,
            'validation' => script_service_validate($pdo, $name, $service, $knownParams),
        ], JSON_UNESCAPED_SLASHES);
    } catch (Throwable $e) {
        http_response_code(400);
        echo json_encode([
            'ok' => false,
            'message' => $e->getMessage(),
        ], JSON_UNESCAPED_SLASHES);
    }

    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET' && (string) ($_GET['action'] ?? '') === 'help') {
    header('Content-Type: application/json; charset=utf-8');

    try {
        $name = trim((string) ($_GET['script_name'] ?? ''));

        if ($name === '') {
            throw new RuntimeException('script_name obligatoire.');
        }

        echo json_encode([
            'ok' => true,
            'help' => script_test_help_payload($name),
        ], JSON_UNESCAPED_SLASHES);
    } catch (Throwable $e) {
        http_response_code(400);
        echo json_encode([
            'ok' => false,
            'message' => $e->getMessage(),
        ], JSON_UNESCAPED_SLASHES);
    }

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
<div class="stack"><div class="notice">Parcours recommande : <strong>1. choisir un script</strong>, <strong>2. voir les actions possibles</strong>, <strong>3. voir les infos necessaires</strong>, <strong>4. verifier les infos deja connues</strong>, <strong>5. lancer un test</strong>.</div><div class="two"><div class="card"><h3>Parametres de test</h3><form id="scripts-test-form" method="post"><?= jarvis_csrf_input() ?><p><label>Script</label><select id="scripts-test-script-name" name="script_name"><option value="">-- Choisir un script --</option><?php foreach($rows as $r): ?><option value="<?= h($r['script_name']) ?>"><?= h($r['script_name']) ?> - <?= h($r['description']) ?></option><?php endforeach; ?></select></p><p><label>Action / service propose par le script</label><select id="scripts-test-service-name" name="service_name"><option value="">-- Choisir un service --</option></select><span id="scripts-test-service-status" class="small">Choisis un script pour charger ses services.</span></p><p><label>Phase MCP utilisee</label><input id="scripts-test-phase-display" type="text" value="" readonly><input id="scripts-test-phase" type="hidden" name="phase" value="collect"></p><p><label>Confirmed</label><select id="scripts-test-confirmed" name="confirmed"><option value="false">false</option><option value="true">true</option></select><span class="small">Renseigne automatiquement depuis le service quand disponible.</span></p><p><label>Mode du test</label><select name="mode"><option value="precheck">Pre-check</option><option value="simulate">Simulation</option><option value="execute">Execution reelle</option></select></p><p><label>params JSON</label><textarea id="scripts-test-params-json" name="params_json">{}</textarea></p><div class="actions"><button class="secondary-btn" id="scripts-test-service-info-btn" type="button">Infos du service</button><button class="secondary-btn" id="scripts-test-validate-btn" type="button">Verifier infos connues</button><button class="secondary-btn" id="scripts-test-example-btn" type="button">Exemple params JSON</button><button class="primary-btn" type="submit">Lancer le test</button></div></form></div><div class="card"><h3>Convention supportee</h3><pre>bash /var/www/data/scripts/&lt;fichier&gt;
  --phase &lt;phase&gt;
  --confirmed &lt;true|false&gt;
  --param key=value</pre><p class="small">Le runner PHP injecte les variables requises depuis <code>jarvis_script_env_values</code>.</p><p class="small"><strong>Phases MCP:</strong> <code>collect</code> et <code>execute</code>.</p><p class="small"><strong>Proxmox:</strong> <code>proxmox-diagnose.sh</code> est la nouvelle reference de dev/test. Le bouton d exemple pre-remplit un JSON adapte au script et a la phase.</p></div></div><div id="scripts-test-help" class="card"><h3>Phases et modes</h3><p class="small">Choisis un script pour afficher ses phases MCP et ses modes utiles.</p></div><div id="scripts-test-result" class="card"><h3>Resultat</h3><p class="small">Le resultat du test apparaitra ici.</p></div></div>
