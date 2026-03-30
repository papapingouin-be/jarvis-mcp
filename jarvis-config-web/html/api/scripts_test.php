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

function scripts_test_metadata_summary(PDO $pdo, string $scriptName): array
{
    $pc = precheck($pdo, $scriptName);
    $row = $pc['row'];
    $metadataBundle = script_metadata_bundle($pdo, $scriptName);
    $runtimeMetadata = is_array($metadataBundle['metadata'] ?? null) ? $metadataBundle['metadata'] : [];
    $dbVersion = (string) ($row['version'] ?? '');
    $runtimeVersion = (string) ($runtimeMetadata['version'] ?? '');
    $versionState = jarvis_version_compare($dbVersion, $runtimeVersion);

    return [
        'script_name' => (string) ($row['script_name'] ?? $scriptName),
        'file_name' => (string) ($row['file_name'] ?? ''),
        'runtime_file' => scripts_root() . '/' . (string) ($row['file_name'] ?? ''),
        'metadata_source' => (string) ($metadataBundle['source'] ?? 'unknown'),
        'db_version' => jarvis_version_value($dbVersion),
        'runtime_version' => jarvis_version_value($runtimeVersion),
        'version_state' => $versionState,
        'file_found' => !empty($pc['file_found']),
    ];
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

        echo json_encode([
            'ok' => true,
            'example' => script_test_example_payload($pdo, $name, $phase, $service !== '' ? $service : null),
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

        $details = script_service_catalog_details($pdo, $name);

        echo json_encode([
            'ok' => true,
            'services' => $details['services'] ?? [],
            'source' => $details['source'] ?? '',
            'debug' => $details['debug'] ?? [],
            'metadata_summary' => scripts_test_metadata_summary($pdo, $name),
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

        $details = script_service_info_details($pdo, $name, $service);

        echo json_encode([
            'ok' => true,
            'service' => $details['service'] ?? [],
            'source' => $details['source'] ?? '',
            'debug' => $details['debug'] ?? [],
            'metadata_summary' => scripts_test_metadata_summary($pdo, $name),
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

        if (!isset($knownParams['mode'])) {
            $knownParams['mode'] = $service;
        }

        $details = script_service_validate_details($pdo, $name, $service, $knownParams);

        echo json_encode([
            'ok' => true,
            'validation' => $details['validation'] ?? [],
            'source' => $details['source'] ?? '',
            'debug' => $details['debug'] ?? [],
            'metadata_summary' => scripts_test_metadata_summary($pdo, $name),
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
            'help' => script_test_help_payload($pdo, $name),
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
        $selectedService = trim((string) ($_POST['service_name'] ?? ''));
        $requestedPhase = trim((string) ($_POST['phase'] ?? 'collect'));
        $executionMode = trim((string) ($_POST['mode'] ?? 'precheck'));
        $confirmed = ((string) ($_POST['confirmed'] ?? 'false') === 'true');
        $params = validate_params_json((string) ($_POST['params_json'] ?? '{}'));

        if ($name === '') {
            throw new RuntimeException('script_name obligatoire.');
        }

        $serviceInfo = [];
        if ($selectedService !== '') {
            $serviceInfo = script_service_info($pdo, $name, $selectedService);
            if (!isset($params['mode'])) {
                $params['mode'] = $selectedService;
            }
        }

        $effectivePhase = trim((string) ($serviceInfo['phase'] ?? $requestedPhase));
        if ($effectivePhase === '') {
            $effectivePhase = 'collect';
        }

        $pc = precheck($pdo, $name);
        $row = $pc['row'];
        $cmd = build_cmd((string) $row['file_name'], $effectivePhase, $confirmed, $params);
        $metadataSummary = scripts_test_metadata_summary($pdo, $name);

        $serviceValidation = [];
        if ($selectedService !== '') {
            $serviceValidation = script_service_validate($pdo, $name, $selectedService, $params);
        }

        echo '<div class="card"><h3>Pre-check</h3><table><thead><tr><th>point</th><th>etat</th><th>detail</th></tr></thead><tbody>';
        echo '<tr><td>script en DB</td><td><span class="status up">OK</span></td><td><code>' . h((string) $row['script_name']) . '</code></td></tr>';
        echo '<tr><td>service choisi</td><td><span class="status ' . ($selectedService !== '' ? 'up' : 'warn') . '">' . ($selectedService !== '' ? 'OUI' : 'NON') . '</span></td><td>' . h($selectedService !== '' ? $selectedService : 'Aucun service explicite') . '</td></tr>';
        echo '<tr><td>phase effective</td><td><span class="status up">OK</span></td><td><code>' . h($effectivePhase) . '</code></td></tr>';
        echo '<tr><td>actif</td><td><span class="status ' . ($pc['active'] ? 'up' : 'warn') . '">' . ($pc['active'] ? 'YES' : 'NO') . '</span></td><td>' . h((string) $row['is_active']) . '</td></tr>';
        echo '<tr><td>fichier present</td><td><span class="status ' . ($pc['file_found'] ? 'up' : 'down') . '">' . ($pc['file_found'] ? 'YES' : 'NO') . '</span></td><td><code>' . h((string) $row['file_name']) . '</code></td></tr>';
        echo '<tr><td>fichier execute</td><td><span class="status ' . (!empty($metadataSummary['file_found']) ? 'up' : 'down') . '">' . (!empty($metadataSummary['file_found']) ? 'OK' : 'KO') . '</span></td><td><code>' . h((string) ($metadataSummary['runtime_file'] ?? '')) . '</code></td></tr>';
        echo '<tr><td>metadata source</td><td><span class="status up">INFO</span></td><td><code>' . h((string) ($metadataSummary['metadata_source'] ?? 'unknown')) . '</code></td></tr>';
        echo '<tr><td>version DB</td><td><span class="status up">INFO</span></td><td><code>' . h((string) ($metadataSummary['db_version'] ?? '-')) . '</code></td></tr>';
        echo '<tr><td>version runtime</td><td><span class="status up">INFO</span></td><td><code>' . h((string) ($metadataSummary['runtime_version'] ?? '-')) . '</code></td></tr>';
        echo '<tr><td>etat version</td><td><span class="status ' . h((string) (($metadataSummary['version_state']['class'] ?? 'warn'))) . '">' . h((string) (($metadataSummary['version_state']['label'] ?? 'INCONNUE'))) . '</span></td><td>Compare la version en base et la version publiee par le script execute.</td></tr>';
        echo '<tr><td>config DB scripts</td><td><span class="status ' . ($pc['script_env_count'] > 0 ? 'up' : 'warn') . '">' . h((string) $pc['script_env_count']) . '</span></td><td>' . ($pc['script_env_count'] > 0 ? h(implode(', ', array_keys($pc['script_env']))) : 'Aucune variable chargee depuis jarvis_script_env_values') . '</td></tr>';
        echo '<tr><td>variables requises</td><td><span class="status ' . (count($pc['missing']) === 0 ? 'up' : 'warn') . '">' . (count($pc['missing']) === 0 ? 'OK' : 'MANQUANTES') . '</span></td><td>' . (count($pc['missing']) === 0 ? 'Toutes presentes en DB' : h(implode(', ', $pc['missing']))) . '</td></tr>';
        echo '</tbody></table></div>';

        if ($selectedService !== '') {
            $missingRequired = is_array($serviceValidation['missing_required'] ?? null) ? $serviceValidation['missing_required'] : [];
            $ready = !empty($serviceValidation['ready']);

            echo '<div class="card"><h3>Validation du service</h3>';
            echo '<p class="small">Validation publiee par le script lui-meme avant execution.</p>';
            echo '<p><strong>Service</strong> : <code>' . h($selectedService) . '</code></p>';
            echo '<p><strong>Summary</strong> : ' . h((string) ($serviceValidation['summary'] ?? '')) . '</p>';
            echo '<p><strong>Ready</strong> : <span class="status ' . ($ready ? 'up' : 'warn') . '">' . ($ready ? 'YES' : 'NO') . '</span></p>';
            echo '<p><strong>Champs requis manquants</strong></p><pre>' . h(json_encode($missingRequired, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) . '</pre>';
            echo '</div>';
        }

        echo '<div class="card"><h3>Commande simulee</h3><pre>' . h($cmd) . '</pre><p class="small">Les variables de script sont injectees depuis la DB au moment de l execution.</p></div>';

        if ($executionMode === 'precheck') {
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

        if ($selectedService !== '' && !empty($serviceValidation) && empty($serviceValidation['ready'])) {
            $missingRequired = is_array($serviceValidation['missing_required'] ?? null) ? $serviceValidation['missing_required'] : [];
            throw new RuntimeException('Le service selectionne n est pas pret. Champs manquants : ' . implode(', ', $missingRequired));
        }

        if ($executionMode === 'simulate') {
            echo jarvis_render_notice('Simulation OK. Rien n a ete execute.', 'success');
            exit;
        }

        if ($executionMode !== 'execute') {
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
<div class="stack" data-page-version="<?= h(jarvis_file_version(__FILE__)) ?>"><div class="notice">Parcours recommande : <strong>1. choisir un script</strong>, <strong>2. choisir un service</strong>, <strong>3. verifier les champs connus</strong>, <strong>4. lancer un pre-check</strong>, <strong>5. executer si tout est vert</strong>.</div><div class="two"><div class="card"><h3>Parametres de test</h3><form id="scripts-test-form" method="post"><?= jarvis_csrf_input() ?><p><label>Script</label><select id="scripts-test-script-name" name="script_name"><option value="">-- Choisir un script --</option><?php foreach($rows as $r): ?><option value="<?= h((string) $r['script_name']) ?>"><?= h((string) $r['script_name']) ?> - <?= h((string) $r['description']) ?></option><?php endforeach; ?></select></p><p><label>Action / service propose par le script</label><select id="scripts-test-service-name" name="service_name"><option value="">-- Choisir un service --</option></select><span id="scripts-test-service-status" class="small">Choisis un script pour charger ses services.</span></p><p><label>Source metadata/service</label><input id="scripts-test-service-source" type="text" value="" readonly><span class="small">Indique si la vue a utilise <code>list-services</code>, <code>describe-service</code>, <code>registry-doc</code>, <code>self-doc</code> ou un fallback local.</span></p><p><label>Version DB</label><input id="scripts-test-db-version" type="text" value="" readonly></p><p><label>Version runtime</label><input id="scripts-test-runtime-version" type="text" value="" readonly></p><p><label>Etat version</label><input id="scripts-test-version-state" type="text" value="" readonly></p><p><label>Fichier execute</label><input id="scripts-test-runtime-file" type="text" value="" readonly></p><p><label>Phase MCP utilisee</label><input id="scripts-test-phase-display" type="text" value="" readonly><input id="scripts-test-phase" type="hidden" name="phase" value="collect"></p><p><label>Confirmed</label><select id="scripts-test-confirmed" name="confirmed"><option value="false">false</option><option value="true">true</option></select><span class="small">Renseigne automatiquement depuis le service quand disponible.</span></p><p><label>Mode du test</label><select name="mode"><option value="precheck">Pre-check</option><option value="simulate">Simulation</option><option value="execute">Execution reelle</option></select></p><p><label>params JSON</label><textarea id="scripts-test-params-json" name="params_json">{}</textarea></p><div class="actions"><button class="secondary-btn" id="scripts-test-service-info-btn" type="button">Infos du service</button><button class="secondary-btn" id="scripts-test-validate-btn" type="button">Verifier infos connues</button><button class="secondary-btn" id="scripts-test-example-btn" type="button">Exemple params JSON</button><button class="primary-btn" type="submit">Lancer le test</button></div></form></div><div class="card"><h3>Convention supportee</h3><pre>bash <?= h(scripts_root()) ?>/&lt;fichier&gt;
  --phase &lt;collect|execute&gt;
  --confirmed &lt;true|false&gt;
  --param key=value</pre><p class="small">Le runner PHP injecte les variables de script depuis <code>jarvis_script_env_values</code> et ajoute automatiquement <code>mode=&lt;service&gt;</code> quand un service est selectionne.</p><p class="small">Les actions, les details d action, les exemples JSON et la validation des champs connus proviennent du script lorsqu il publie ces metadonnees.</p></div></div><div id="scripts-test-help" class="card"><h3>Phases et modes</h3><p class="small">Choisis un script pour afficher ses phases MCP et ses modes utiles.</p></div><div id="scripts-test-debug" class="card"><h3>Debug metadata/services</h3><p class="small">Choisis un script pour afficher le detail des tentatives de lecture MCP.</p></div><div id="scripts-test-result" class="card"><h3>Resultat</h3><p class="small">Le resultat du test apparaitra ici.</p></div></div>
