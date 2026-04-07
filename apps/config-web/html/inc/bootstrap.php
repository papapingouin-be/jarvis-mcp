<?php

declare(strict_types=1);

if (session_status() !== PHP_SESSION_ACTIVE) {
    @session_start();
}

function h(mixed $v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function jarvis_ui_version(): string
{
    return 'V7.6';
}

function jarvis_file_version(string $path): string
{
    if (!is_file($path)) {
        return 'php:missing';
    }

    $mtime = @filemtime($path);
    $hash = @sha1_file($path);
    $stamp = $mtime !== false ? date('Ymd.His', $mtime) : 'unknown';
    $shortHash = is_string($hash) ? substr($hash, 0, 7) : 'nohash';

    return 'php:' . $stamp . '-' . $shortHash;
}

function jarvis_data_path(string $s = ''): string
{
    $base = '/var/www/data';
    return $s === '' ? $base : $base . '/' . ltrim($s, '/');
}

function jarvis_log_file(): string
{
    return jarvis_data_path('logs/actions.log');
}

function jarvis_append_log(string $type, string $target, string $status, string $details = ''): void
{
    $line = sprintf(
        "[%s] type=%s target=%s status=%s details=%s\n",
        date('c'),
        $type,
        $target,
        $status,
        preg_replace('/\s+/', ' ', trim($details))
    );

    @file_put_contents(jarvis_log_file(), $line, FILE_APPEND);
}

function jarvis_render_notice(string $message, string $type = 'warning'): string
{
    return '<div class="notice ' . h($type) . '">' . $message . '</div>';
}

function jarvis_csrf_token(): string
{
    if (empty($_SESSION['jarvis_csrf_token'])) {
        $_SESSION['jarvis_csrf_token'] = bin2hex(random_bytes(16));
    }

    return $_SESSION['jarvis_csrf_token'];
}

function jarvis_csrf_input(): string
{
    return '<input type="hidden" name="csrf_token" value="' . h(jarvis_csrf_token()) . '">';
}

function jarvis_check_csrf(): void
{
    $token = $_POST['csrf_token'] ?? '';
    if (!is_string($token) || !hash_equals(jarvis_csrf_token(), $token)) {
        throw new RuntimeException('Jeton CSRF invalide.');
    }
}

function env_all(): array
{
    $env = getenv();
    if (!is_array($env)) {
        $env = [];
    }

    foreach ($_SERVER as $key => $value) {
        if (is_string($value) && preg_match('/^[A-Z0-9_]+$/', $key) && !array_key_exists($key, $env)) {
            $env[$key] = $value;
        }
    }

    ksort($env);
    return $env;
}

function env_value(string $key): ?string
{
    $value = getenv($key);
    if ($value !== false) {
        return (string) $value;
    }

    return isset($_SERVER[$key]) && is_string($_SERVER[$key]) ? $_SERVER[$key] : null;
}

function db(): PDO
{
    $host = env_value('JARVIS_PG_HOST') ?: 'jarvis_postgres';
    $name = env_value('JARVIS_PG_DB') ?: 'jarvis_memory';
    $user = env_value('JARVIS_PG_USER') ?: 'n8n';
    $pass = env_value('JARVIS_PG_PASSWORD') ?: '';
    $port = env_value('JARVIS_PG_PORT') ?: '5432';

    return new PDO(
        "pgsql:host=$host;port=$port;dbname=$name",
        $user,
        $pass,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );
}

function db_try(): array
{
    try {
        $pdo = db();
        $version = $pdo->query('select version() as version')->fetch();

        return [
            'ok' => true,
            'pdo' => $pdo,
            'message' => $version['version'] ?? 'OK',
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'pdo' => null,
            'message' => $e->getMessage(),
        ];
    }
}

function table_exists(PDO $pdo, string $table): bool
{
    $statement = $pdo->prepare(
        'select exists(select 1 from information_schema.tables where table_schema=current_schema() and table_name=:t) as e'
    );
    $statement->execute(['t' => $table]);
    $row = $statement->fetch();

    return !empty($row['e']);
}

function column_exists(PDO $pdo, string $table, string $column): bool
{
    $statement = $pdo->prepare(
        'select exists(
            select 1
            from information_schema.columns
            where table_schema=current_schema()
              and table_name=:t
              and column_name=:c
        ) as e'
    );
    $statement->execute([
        't' => $table,
        'c' => $column,
    ]);
    $row = $statement->fetch();

    return !empty($row['e']);
}

function app_config_all(PDO $pdo): array
{
    if (!table_exists($pdo, 'jarvis_app_config')) {
        return [];
    }

    return $pdo->query('select config_key, config_value, updated_at from jarvis_app_config order by config_key')->fetchAll();
}

function app_config_value(PDO $pdo, string $key): mixed
{
    if (!table_exists($pdo, 'jarvis_app_config')) {
        return null;
    }

    $statement = $pdo->prepare('select config_value from jarvis_app_config where config_key=:k');
    $statement->execute(['k' => $key]);
    $row = $statement->fetch();

    return $row['config_value'] ?? null;
}

function scalar_to_string(mixed $value): ?string
{
    if ($value === null) {
        return null;
    }

    if (is_bool($value)) {
        return $value ? 'true' : 'false';
    }

    if (!is_scalar($value)) {
        return null;
    }

    return trim((string) $value);
}

function runtime_config_value(?PDO $pdo, string $configKey, string $envName): ?string
{
    if ($pdo !== null) {
        $stored = scalar_to_string(app_config_value($pdo, $configKey));
        if ($stored !== null && $stored !== '') {
            return $stored;
        }
    }

    return env_value($envName);
}

function script_env_rows(PDO $pdo, ?string $scriptName = null): array
{
    if (!table_exists($pdo, 'jarvis_script_env_values')) {
        return [];
    }

    if ($scriptName === null) {
        return $pdo->query(
            'select script_name, env_name, env_value, updated_at from jarvis_script_env_values order by script_name, env_name'
        )->fetchAll();
    }

    $statement = $pdo->prepare(
        'select script_name, env_name, env_value, updated_at from jarvis_script_env_values where script_name=:n order by env_name'
    );
    $statement->execute(['n' => $scriptName]);

    return $statement->fetchAll();
}

function script_env_values(PDO $pdo, string $scriptName): array
{
    $out = [];

    foreach (script_env_rows($pdo, $scriptName) as $row) {
        $name = trim((string) ($row['env_name'] ?? ''));
        if ($name === '') {
            continue;
        }

        $out[$name] = (string) ($row['env_value'] ?? '');
    }

    return $out;
}

function script_env_upsert_many(PDO $pdo, string $scriptName, array $values): int
{
    if (!table_exists($pdo, 'jarvis_script_env_values')) {
        throw new RuntimeException('La table jarvis_script_env_values n existe pas.');
    }

    $count = 0;
    $statement = $pdo->prepare(
        'insert into jarvis_script_env_values(script_name, env_name, env_value, updated_at)
         values(:script_name, :env_name, :env_value, now())
         on conflict (script_name, env_name)
         do update set env_value = excluded.env_value, updated_at = now()'
    );

    foreach ($values as $envName => $envValue) {
        $name = trim((string) $envName);
        if ($name === '') {
            continue;
        }

        $statement->execute([
            'script_name' => $scriptName,
            'env_name' => $name,
            'env_value' => (string) $envValue,
        ]);
        $count++;
    }

    return $count;
}

function script_env_delete_many(PDO $pdo, string $scriptName, array $envNames): int
{
    if (!table_exists($pdo, 'jarvis_script_env_values')) {
        throw new RuntimeException('La table jarvis_script_env_values n existe pas.');
    }

    $statement = $pdo->prepare(
        'delete from jarvis_script_env_values where script_name=:script_name and env_name=:env_name'
    );
    $count = 0;

    foreach ($envNames as $envName) {
        $name = trim((string) $envName);
        if ($name === '') {
            continue;
        }

        $statement->execute([
            'script_name' => $scriptName,
            'env_name' => $name,
        ]);
        $count += $statement->rowCount();
    }

    return $count;
}

function script_env_grouped(PDO $pdo): array
{
    $out = [];

    foreach (script_env_rows($pdo) as $row) {
        $script = trim((string) ($row['script_name'] ?? ''));
        $name = trim((string) ($row['env_name'] ?? ''));
        if ($script === '' || $name === '') {
            continue;
        }

        if (!isset($out[$script])) {
            $out[$script] = [];
        }

        $out[$script][] = $row;
    }

    ksort($out);
    return $out;
}

function scripts_root(): string
{
    return env_value('JARVIS_UI_SCRIPTS_ROOT')
        ?: env_value('JARVIS_SCRIPTS_ROOT')
        ?: '/var/www/data/scripts';
}

function script_install_catalog_root(): string
{
    return env_value('JARVIS_SCRIPT_INSTALL_CATALOG_ROOT')
        ?: jarvis_data_path('script-catalog');
}

function scan_script_root(string $root): array
{
    $out = [];

    if (!is_dir($root)) {
        return $out;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
    );

    foreach ($iterator as $file) {
        if (!$file->isFile()) {
            continue;
        }

        $relative = str_replace(str_replace('\\', '/', $root) . '/', '', str_replace('\\', '/', $file->getPathname()));
        if (preg_match('#^[a-zA-Z0-9._/-]+$#', $relative)) {
            $out[] = $relative;
        }
    }

    sort($out);
    return $out;
}

function safe_script_rel(string $rel): string
{
    $rel = trim(str_replace('\\', '/', $rel));
    if ($rel === '' || str_starts_with($rel, '/') || str_contains($rel, '../')) {
        throw new RuntimeException('Chemin script invalide.');
    }

    if (!preg_match('#^[a-zA-Z0-9._/-]+$#', $rel)) {
        throw new RuntimeException('Chemin script invalide.');
    }

    return $rel;
}

function script_abs(string $rel): string
{
    return scripts_root() . '/' . safe_script_rel($rel);
}

function script_install_source_abs(string $rel): string
{
    return script_install_catalog_root() . '/' . safe_script_rel($rel);
}

function sql_abs(string $rel): string
{
    return jarvis_data_path('sql/postgres/' . basename($rel));
}

function validate_required_env_json(string $json): array
{
    if (trim($json) === '') {
        return [];
    }

    $decoded = json_decode($json, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('required_env_json doit etre un tableau JSON.');
    }

    $normalized = [];

    foreach ($decoded as $value) {
        if (is_string($value)) {
            $name = trim($value);
            if ($name === '') {
                throw new RuntimeException('required_env_json contient un nom vide.');
            }

            $normalized[] = [
                'name' => $name,
                'required' => true,
                'secret' => false,
                'description' => '',
            ];
            continue;
        }

        if (!is_array($value)) {
            throw new RuntimeException('required_env_json doit contenir des chaines ou objets valides.');
        }

        $name = trim((string) ($value['name'] ?? ''));
        if ($name === '') {
            throw new RuntimeException('required_env_json.name est obligatoire.');
        }

        $normalized[] = [
            'name' => $name,
            'required' => array_key_exists('required', $value) ? (bool) $value['required'] : true,
            'secret' => array_key_exists('secret', $value) ? (bool) $value['secret'] : false,
            'description' => trim((string) ($value['description'] ?? '')),
        ];
    }

    return $normalized;
}

function required_env_definitions(mixed $value): array
{
    if (!is_array($value)) {
        return [];
    }

    return validate_required_env_json(json_encode($value, JSON_UNESCAPED_SLASHES));
}

function required_env_names(array $definitions, bool $requiredOnly = true): array
{
    $names = [];

    foreach ($definitions as $definition) {
        if (!is_array($definition)) {
            continue;
        }

        $name = trim((string) ($definition['name'] ?? ''));
        if ($name === '') {
            continue;
        }

        $required = !array_key_exists('required', $definition) || (bool) $definition['required'];
        if ($requiredOnly && !$required) {
            continue;
        }

        $names[] = $name;
    }

    return array_values(array_unique($names));
}

function script_explicit_fallback_env_names(string $scriptName): array
{
    if ($scriptName !== 'jarvis_sync_build_redeploy.sh') {
        return [];
    }

    return [
        'jarvis_tools_PORTAINER_URL',
        'jarvis_tools_PORTAINER_USER',
        'jarvis_tools_PORTAINER_PASSWORD',
        'PORTAINER_ENDPOINT_ID',
        'JARVIS_TOOLS_STACK_NAME',
        'JARVIS_TOOLS_CONTAINER_NAME',
        'PORTAINER_REDEPLOY_WAIT_SECONDS',
        'PORTAINER_API_FALLBACK_TO_REMOTE_COMPOSE',
        'JARVIS_TOOLS_REMOTE_COMPOSE_FILE',
        'JARVIS_TOOLS_REMOTE_ENV_FILE',
        'JARVIS_TOOLS_REMOTE_PROJECT_NAME',
        'JARVIS_MCPO_CONTAINER_NAME',
        'RESTART_STRATEGY',
    ];
}

function validate_params_json(string $json): array
{
    if (trim($json) === '') {
        return [];
    }

    $decoded = json_decode($json, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('params doit etre un JSON objet.');
    }

    foreach ($decoded as $key => $value) {
        if (!is_string($key) || $key === '') {
            throw new RuntimeException('Cle params invalide.');
        }

        if (is_array($value) || is_object($value)) {
            throw new RuntimeException('Valeurs params scalaires uniquement.');
        }
    }

    return $decoded;
}

function script_test_example_payload(PDO $pdo, string $scriptName, string $phase, ?string $serviceName = null): array
{
    $normalizedPhase = trim($phase) === '' ? 'collect' : trim($phase);
    $selectedService = $serviceName !== null && trim($serviceName) !== ''
        ? trim($serviceName)
        : null;

    if ($selectedService === null) {
        $services = script_service_catalog($pdo, $scriptName);
        foreach ($services as $service) {
            if (($service['phase'] ?? null) === $normalizedPhase && !empty($service['name'])) {
                $selectedService = (string) $service['name'];
                break;
            }
        }

        if ($selectedService === null && isset($services[0]['name'])) {
            $selectedService = (string) $services[0]['name'];
        }
    }

    if ($selectedService !== null) {
        $serviceInfo = script_service_info($pdo, $scriptName, $selectedService);
        $params = (array) ($serviceInfo['example_params'] ?? []);

        return [
            'script_name' => $scriptName,
            'service' => $selectedService,
            'phase' => (string) ($serviceInfo['phase'] ?? $normalizedPhase),
            'confirmed' => (bool) ($serviceInfo['confirmed_required'] ?? ($normalizedPhase === 'execute')),
            'summary' => 'Exemple genere depuis la description du service.',
            'notes' => [
                'Exemple base sur le service selectionne dans le script.',
            ],
            'params' => $params,
            'pretty_params_json' => json_encode(
                $params,
                JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
            ),
        ];
    }

    $example = [
        'script_name' => $scriptName,
        'phase' => $normalizedPhase,
        'confirmed' => $normalizedPhase === 'execute',
        'summary' => 'Exemple generique de params JSON.',
        'notes' => [
            'Le script ne publie pas de service detaille pour cette vue.',
            'Adapte les valeurs a ton environnement avant execution reelle.',
        ],
        'params' => [],
    ];

    $example['pretty_params_json'] = json_encode(
        $example['params'],
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
    );

    return $example;
}

function script_test_help_payload(PDO $pdo, string $scriptName): array
{
    $services = script_service_catalog($pdo, $scriptName);
    $help = [
        'script_name' => $scriptName,
        'mcp_phases' => [
            'collect' => 'Lecture, inventaire, diagnostic ou preparation.',
            'execute' => 'Action active ou sensible, a utiliser avec confirmed=true.',
        ],
        'recommended_phase_by_mode' => [],
        'modes' => [],
        'notes' => [
            'La phase MCP et le mode du script sont deux notions differentes.',
        ],
    ];

    foreach ($services as $service) {
        $name = trim((string) ($service['name'] ?? ''));
        if ($name === '') {
            continue;
        }

        $help['modes'][$name] = (string) ($service['description'] ?? '');
        $help['recommended_phase_by_mode'][$name] = (string) ($service['phase'] ?? '');
    }

    if (count($help['modes']) > 0) {
        $help['notes'] = [
            'Les actions affichees ci-dessous viennent directement du script.',
            'La phase MCP recommandee est determinee depuis la description de chaque action.',
            'Le bouton Exemple params JSON te donne un preset adapte a l action selectionnee.',
        ];
    } else {
        $help['notes'][] = 'Aucune aide specifique disponible pour ce script.';
    }

    return $help;
}

function run_script_json_by_name(PDO $pdo, string $scriptName, string $phase, bool $confirmed, array $params): array
{
    $pc = precheck($pdo, $scriptName);
    if (!$pc['file_found']) {
        throw new RuntimeException('Le fichier script est introuvable.');
    }

    $command = build_cmd((string) $pc['row']['file_name'], $phase, $confirmed, $params);
    $output = trim(run_script_command($command, $pc['script_env']));
    $decoded = json_decode($output, true);

    if (!is_array($decoded)) {
        throw new RuntimeException('Le script n a pas retourne un JSON valide.');
    }

    return $decoded;
}

function script_registry_row(PDO $pdo, string $scriptName): ?array
{
    if (!table_exists($pdo, 'jarvis_script_registry')) {
        return null;
    }

    $statement = $pdo->prepare(
        "select script_name,file_name,coalesce(description,'') as description,coalesce(metadata_json,'{}'::jsonb) as metadata_json
         from jarvis_script_registry
         where script_name=:n"
    );
    $statement->execute(['n' => $scriptName]);
    $row = $statement->fetch();

    return is_array($row) ? $row : null;
}

function jarvis_version_value(mixed $value): string
{
    $normalized = trim((string) $value);
    return $normalized !== '' ? $normalized : '-';
}

function jarvis_version_compare(mixed $dbVersion, mixed $diskVersion): array
{
    $db = trim((string) $dbVersion);
    $disk = trim((string) $diskVersion);

    if ($db === '' && $disk === '') {
        return [
            'label' => 'INCONNUE',
            'class' => 'warn',
        ];
    }

    if ($db !== '' && $disk !== '') {
        return [
            'label' => $db === $disk ? 'OK' : 'DIFF',
            'class' => $db === $disk ? 'up' : 'down',
        ];
    }

    if ($db !== '') {
        return [
            'label' => 'DB SEULE',
            'class' => 'warn',
        ];
    }

    return [
        'label' => 'DISQUE SEUL',
        'class' => 'warn',
    ];
}

function script_debug_attempt(string $label, string $command, array $result, ?array $payload = null): array
{
    return [
        'label' => $label,
        'command' => $command,
        'exit_code' => (int) ($result['exit_code'] ?? -1),
        'stdout' => (string) ($result['stdout'] ?? ''),
        'stderr' => (string) ($result['stderr'] ?? ''),
        'decoded' => $payload,
    ];
}

function script_run_json_attempt(PDO $pdo, string $scriptName, string $phase, bool $confirmed, array $params, string $label): array
{
    $pc = precheck($pdo, $scriptName);
    if (!$pc['file_found']) {
        throw new RuntimeException('Le fichier script est introuvable.');
    }

    $command = build_cmd((string) $pc['row']['file_name'], $phase, $confirmed, $params);
    $result = run_script_process($command, $pc['script_env']);
    $decoded = null;

    if (trim((string) $result['stdout']) !== '') {
        $candidate = json_decode((string) $result['stdout'], true);
        if (is_array($candidate)) {
            $decoded = $candidate;
        }
    }

    return [
        'ok' => (int) ($result['exit_code'] ?? 1) === 0 && is_array($decoded),
        'payload' => $decoded,
        'attempt' => script_debug_attempt($label, $command, $result, $decoded),
    ];
}

function script_services_from_metadata(array $metadata): array
{
    $services = is_array($metadata['services'] ?? null) ? $metadata['services'] : [];
    $normalized = [];

    foreach ($services as $service) {
        if (!is_array($service)) {
            continue;
        }

        $name = trim((string) ($service['name'] ?? ''));
        if ($name === '') {
            continue;
        }

        $normalized[] = [
            'name' => $name,
            'phase' => trim((string) ($service['phase'] ?? '')),
            'confirmed_required' => !empty($service['confirmed_required']),
            'description' => trim((string) ($service['description'] ?? '')),
            'required_params' => is_array($service['required_params'] ?? null) ? array_values($service['required_params']) : [],
            'optional_params' => is_array($service['optional_params'] ?? null) ? array_values($service['optional_params']) : [],
            'required_env' => is_array($service['required_env'] ?? null) ? array_values($service['required_env']) : [],
            'optional_env' => is_array($service['optional_env'] ?? null) ? array_values($service['optional_env']) : [],
            'defaults' => is_array($service['defaults'] ?? null) ? $service['defaults'] : [],
            'example_params' => is_array($service['example_params'] ?? null) ? $service['example_params'] : [],
        ];
    }

    return $normalized;
}

function script_service_find_in_metadata(array $metadata, string $serviceName): array
{
    foreach (script_services_from_metadata($metadata) as $service) {
        if (($service['name'] ?? '') === $serviceName) {
            return $service;
        }
    }

    return [];
}

function script_merge_service_lists(array $primary, array $secondary): array
{
    $merged = [];

    foreach ([$primary, $secondary] as $list) {
        foreach (script_services_from_metadata(['services' => $list]) as $service) {
            $name = trim((string) ($service['name'] ?? ''));
            if ($name === '') {
                continue;
            }

            if (!isset($merged[$name])) {
                $merged[$name] = $service;
                continue;
            }

            $merged[$name] = [
                'name' => $name,
                'phase' => trim((string) ($merged[$name]['phase'] ?? $service['phase'] ?? '')),
                'confirmed_required' => !empty($merged[$name]['confirmed_required']) || !empty($service['confirmed_required']),
                'description' => trim((string) ($merged[$name]['description'] ?? '')) !== ''
                    ? (string) $merged[$name]['description']
                    : (string) ($service['description'] ?? ''),
                'required_params' => array_values(array_unique(array_merge(
                    is_array($merged[$name]['required_params'] ?? null) ? $merged[$name]['required_params'] : [],
                    is_array($service['required_params'] ?? null) ? $service['required_params'] : []
                ))),
                'optional_params' => array_values(array_unique(array_merge(
                    is_array($merged[$name]['optional_params'] ?? null) ? $merged[$name]['optional_params'] : [],
                    is_array($service['optional_params'] ?? null) ? $service['optional_params'] : []
                ))),
                'required_env' => array_values(array_unique(array_merge(
                    is_array($merged[$name]['required_env'] ?? null) ? $merged[$name]['required_env'] : [],
                    is_array($service['required_env'] ?? null) ? $service['required_env'] : []
                ))),
                'optional_env' => array_values(array_unique(array_merge(
                    is_array($merged[$name]['optional_env'] ?? null) ? $merged[$name]['optional_env'] : [],
                    is_array($service['optional_env'] ?? null) ? $service['optional_env'] : []
                ))),
                'defaults' => is_array($merged[$name]['defaults'] ?? null) && count($merged[$name]['defaults']) > 0
                    ? $merged[$name]['defaults']
                    : (is_array($service['defaults'] ?? null) ? $service['defaults'] : []),
                'example_params' => is_array($merged[$name]['example_params'] ?? null) && count($merged[$name]['example_params']) > 0
                    ? $merged[$name]['example_params']
                    : (is_array($service['example_params'] ?? null) ? $service['example_params'] : []),
            ];
        }
    }

    ksort($merged);
    return array_values($merged);
}

function script_merge_metadata(array $preferred, array $fallback): array
{
    $merged = $preferred;

    foreach (['script_name', 'file_name', 'description', 'version'] as $field) {
        $current = trim((string) ($merged[$field] ?? ''));
        if ($current === '' && trim((string) ($fallback[$field] ?? '')) !== '') {
            $merged[$field] = $fallback[$field];
        }
    }

    $merged['required_env'] = required_env_definitions(array_merge(
        is_array($preferred['required_env'] ?? null) ? $preferred['required_env'] : [],
        is_array($fallback['required_env'] ?? null) ? $fallback['required_env'] : []
    ));

    $merged['services'] = script_merge_service_lists(
        is_array($preferred['services'] ?? null) ? $preferred['services'] : [],
        is_array($fallback['services'] ?? null) ? $fallback['services'] : []
    );

    foreach (['capabilities', 'tags'] as $field) {
        $merged[$field] = array_values(array_unique(array_merge(
            is_array($preferred[$field] ?? null) ? $preferred[$field] : [],
            is_array($fallback[$field] ?? null) ? $fallback[$field] : []
        )));
    }

    if (!array_key_exists('supports_registry', $merged) && array_key_exists('supports_registry', $fallback)) {
        $merged['supports_registry'] = $fallback['supports_registry'];
    }

    return $merged;
}

function script_expected_env_entries(PDO $pdo, string $scriptName): array
{
    $bundle = script_metadata_bundle($pdo, $scriptName);
    $metadata = is_array($bundle['metadata'] ?? null) ? $bundle['metadata'] : [];
    $definitions = required_env_definitions($metadata['required_env'] ?? []);
    $entries = [];

    foreach ($definitions as $definition) {
        if (!is_array($definition)) {
            continue;
        }

        $name = trim((string) ($definition['name'] ?? ''));
        if ($name === '') {
            continue;
        }

        $entries[$name] = [
            'name' => $name,
            'required' => !array_key_exists('required', $definition) || (bool) $definition['required'],
            'secret' => !empty($definition['secret']),
            'description' => trim((string) ($definition['description'] ?? '')),
            'sources' => ['script'],
            'services' => [],
        ];
    }

    foreach (script_services_from_metadata($metadata) as $service) {
        $serviceName = trim((string) ($service['name'] ?? ''));
        foreach ([
            'required_env' => true,
            'optional_env' => false,
        ] as $field => $required) {
            $envNames = is_array($service[$field] ?? null) ? $service[$field] : [];
            foreach ($envNames as $envName) {
                $name = trim((string) $envName);
                if ($name === '') {
                    continue;
                }

                if (!isset($entries[$name])) {
                    $entries[$name] = [
                        'name' => $name,
                        'required' => false,
                        'secret' => false,
                        'description' => '',
                        'sources' => [],
                        'services' => [],
                    ];
                }

                $entries[$name]['required'] = !empty($entries[$name]['required']) || $required;
                $entries[$name]['sources'][] = $required ? 'service-required-env' : 'service-optional-env';
                if ($serviceName !== '') {
                    $entries[$name]['services'][] = $serviceName;
                }
            }
        }
    }

    foreach ($entries as $name => $entry) {
        $entries[$name]['sources'] = array_values(array_unique($entry['sources']));
        $entries[$name]['services'] = array_values(array_unique($entry['services']));
    }

    ksort($entries);
    return array_values($entries);
}

function script_expected_env_with_values(PDO $pdo, string $scriptName): array
{
    $expected = script_expected_env_entries($pdo, $scriptName);
    $stored = script_env_values($pdo, $scriptName);
    $byName = [];

    foreach ($expected as $entry) {
        $name = (string) ($entry['name'] ?? '');
        if ($name === '') {
            continue;
        }
        $entry['stored'] = array_key_exists($name, $stored);
        $entry['value'] = $stored[$name] ?? '';
        $byName[$name] = $entry;
    }

    foreach ($stored as $name => $value) {
        if (isset($byName[$name])) {
            continue;
        }

        $byName[$name] = [
            'name' => $name,
            'required' => false,
            'secret' => false,
            'description' => '',
            'sources' => ['db-only'],
            'services' => [],
            'stored' => true,
            'value' => $value,
        ];
    }

    ksort($byName);
    return array_values($byName);
}

function script_metadata_bundle(PDO $pdo, string $scriptName): array
{
    $debug = [];
    $dbRow = script_registry_row($pdo, $scriptName);
    $dbMetadata = [];

    if ($dbRow !== null) {
        $decoded = json_decode((string) ($dbRow['metadata_json'] ?? '{}'), true);
        $dbMetadata = is_array($decoded) ? $decoded : [];
        $debug[] = [
            'label' => 'db-metadata',
            'script_name' => (string) ($dbRow['script_name'] ?? $scriptName),
            'file_name' => (string) ($dbRow['file_name'] ?? ''),
            'has_metadata' => !empty($dbMetadata),
            'services_count' => count(script_services_from_metadata($dbMetadata)),
        ];
    } else {
        $debug[] = [
            'label' => 'db-metadata',
            'script_name' => $scriptName,
            'file_name' => '',
            'has_metadata' => false,
            'services_count' => 0,
        ];
    }

    $registryAttempt = script_run_json_attempt($pdo, $scriptName, 'collect', false, [
        'mode' => 'registry-doc',
    ], 'registry-doc');
    $debug[] = $registryAttempt['attempt'];
    if ($registryAttempt['ok'] && is_array($registryAttempt['payload']['script'] ?? null)) {
        return [
            'source' => !empty($dbMetadata) ? 'registry-doc+db-metadata' : 'registry-doc',
            'metadata' => !empty($dbMetadata)
                ? script_merge_metadata($registryAttempt['payload']['script'], $dbMetadata)
                : $registryAttempt['payload']['script'],
            'debug' => $debug,
        ];
    }

    $selfDocAttempt = script_run_json_attempt($pdo, $scriptName, 'collect', false, [
        'mode' => 'self-doc',
    ], 'self-doc');
    $debug[] = $selfDocAttempt['attempt'];
    if ($selfDocAttempt['ok'] && is_array($selfDocAttempt['payload']['script'] ?? null)) {
        return [
            'source' => !empty($dbMetadata) ? 'self-doc+db-metadata' : 'self-doc',
            'metadata' => !empty($dbMetadata)
                ? script_merge_metadata($selfDocAttempt['payload']['script'], $dbMetadata)
                : $selfDocAttempt['payload']['script'],
            'debug' => $debug,
        ];
    }

    if (!empty($dbMetadata)) {
        return [
            'source' => 'db-metadata',
            'metadata' => $dbMetadata,
            'debug' => $debug,
        ];
    }

    return [
        'source' => 'none',
        'metadata' => [],
        'debug' => $debug,
    ];
}

function script_service_catalog_details(PDO $pdo, string $scriptName): array
{
    $debug = [];

    try {
        $attempt = script_run_json_attempt($pdo, $scriptName, 'collect', false, [
            'mode' => 'list-services',
        ], 'list-services');
        $debug[] = $attempt['attempt'];

        if ($attempt['ok']) {
            $services = is_array($attempt['payload']['services'] ?? null) ? $attempt['payload']['services'] : [];
            if (count($services) > 0) {
                return [
                    'services' => $services,
                    'source' => 'list-services',
                    'debug' => $debug,
                ];
            }
        }
    } catch (Throwable $e) {
        $debug[] = [
            'label' => 'list-services-exception',
            'message' => $e->getMessage(),
        ];
    }

    $bundle = script_metadata_bundle($pdo, $scriptName);
    return [
        'services' => script_services_from_metadata($bundle['metadata']),
        'source' => (string) $bundle['source'],
        'debug' => array_merge($debug, $bundle['debug']),
    ];
}

function script_service_catalog(PDO $pdo, string $scriptName): array
{
    $details = script_service_catalog_details($pdo, $scriptName);
    return is_array($details['services'] ?? null) ? $details['services'] : [];
}

function script_service_info_details(PDO $pdo, string $scriptName, string $serviceName): array
{
    $debug = [];

    try {
        $attempt = script_run_json_attempt($pdo, $scriptName, 'collect', false, [
            'mode' => 'describe-service',
            'service' => $serviceName,
        ], 'describe-service');
        $debug[] = $attempt['attempt'];

        if ($attempt['ok']) {
            $service = is_array($attempt['payload']['service'] ?? null) ? $attempt['payload']['service'] : [];
            if (!empty($service)) {
                return [
                    'service' => $service,
                    'source' => 'describe-service',
                    'debug' => $debug,
                ];
            }
        }
    } catch (Throwable $e) {
        $debug[] = [
            'label' => 'describe-service-exception',
            'message' => $e->getMessage(),
        ];
    }

    $bundle = script_metadata_bundle($pdo, $scriptName);
    return [
        'service' => script_service_find_in_metadata($bundle['metadata'], $serviceName),
        'source' => (string) $bundle['source'],
        'debug' => array_merge($debug, $bundle['debug']),
    ];
}

function script_service_info(PDO $pdo, string $scriptName, string $serviceName): array
{
    $details = script_service_info_details($pdo, $scriptName, $serviceName);
    return is_array($details['service'] ?? null) ? $details['service'] : [];
}

function script_service_validate_details(PDO $pdo, string $scriptName, string $serviceName, array $knownParams): array
{
    $debug = [];

    try {
        $params = array_merge($knownParams, [
            'mode' => 'validate-service-input',
            'service' => $serviceName,
        ]);
        $attempt = script_run_json_attempt($pdo, $scriptName, 'collect', false, $params, 'validate-service-input');
        $debug[] = $attempt['attempt'];

        if ($attempt['ok']) {
            $payload = is_array($attempt['payload']) ? $attempt['payload'] : [];
            if (!empty($payload)) {
                return [
                    'validation' => $payload,
                    'source' => 'validate-service-input',
                    'debug' => $debug,
                ];
            }
        }
    } catch (Throwable $e) {
        $debug[] = [
            'label' => 'validate-service-input-exception',
            'message' => $e->getMessage(),
        ];
    }

    $serviceInfo = script_service_info($pdo, $scriptName, $serviceName);
    $requiredParams = is_array($serviceInfo['required_params'] ?? null) ? $serviceInfo['required_params'] : [];
    $optionalParams = is_array($serviceInfo['optional_params'] ?? null) ? $serviceInfo['optional_params'] : [];
    $defaults = is_array($serviceInfo['defaults'] ?? null) ? $serviceInfo['defaults'] : [];
    $exampleParams = is_array($serviceInfo['example_params'] ?? null) ? $serviceInfo['example_params'] : [];
    $ignored = ['mode', 'service', 'output'];
    $known = [];

    foreach ($knownParams as $key => $value) {
        if (in_array((string) $key, $ignored, true)) {
            continue;
        }
        if ($value === '' || $value === null) {
            continue;
        }
        $known[(string) $key] = $value;
    }

    $missingRequired = [];
    foreach ($requiredParams as $param) {
        $paramName = trim((string) $param);
        if ($paramName === '') {
            continue;
        }
        if (!array_key_exists($paramName, $known)) {
            $missingRequired[] = $paramName;
        }
    }

    $optionalMissing = [];
    foreach ($optionalParams as $param) {
        $paramName = trim((string) $param);
        if ($paramName === '') {
            continue;
        }
        if (!array_key_exists($paramName, $known)) {
            $optionalMissing[] = $paramName;
        }
    }

    return [
        'validation' => [
            'ok' => true,
            'mode' => 'validate-service-input',
            'service' => $serviceName,
            'phase' => (string) ($serviceInfo['phase'] ?? ''),
            'confirmed_required' => !empty($serviceInfo['confirmed_required']),
            'known' => $known,
            'missing_required' => $missingRequired,
            'optional_missing' => $optionalMissing,
            'defaults' => $defaults,
            'example_params' => $exampleParams,
            'ready' => count($missingRequired) === 0,
            'summary' => count($missingRequired) === 0
                ? 'Validation calculee localement: champs requis complets.'
                : 'Validation calculee localement: champs requis manquants.',
        ],
        'source' => 'local-fallback',
        'debug' => $debug,
    ];
}

function script_service_validate(PDO $pdo, string $scriptName, string $serviceName, array $knownParams): array
{
    $details = script_service_validate_details($pdo, $scriptName, $serviceName, $knownParams);
    return is_array($details['validation'] ?? null) ? $details['validation'] : [];
}

function registry_all(PDO $pdo): array
{
    $historyAvailable = table_exists($pdo, 'jarvis_script_registry_history');
    $versionAvailable = column_exists($pdo, 'jarvis_script_registry', 'version');
    $versionSelect = $versionAvailable ? "coalesce(r.version,'') as version" : "'' as version";

    if ($historyAvailable) {
        return $pdo->query(
            "select r.script_name,r.file_name,{$versionSelect},coalesce(r.description,'') as description,r.required_env_json,r.is_active,r.updated_at,
                    coalesce((select count(*) from jarvis_script_registry_history h where h.script_name = r.script_name), 0) as history_count,
                    (select max(h.changed_at) from jarvis_script_registry_history h where h.script_name = r.script_name) as last_changed_at
             from jarvis_script_registry r
             order by r.script_name"
        )->fetchAll();
    }

    return $pdo->query(
        "select r.script_name,r.file_name,{$versionSelect},coalesce(r.description,'') as description,r.required_env_json,r.is_active,r.updated_at,
                0 as history_count,
                null::timestamptz as last_changed_at
         from jarvis_script_registry r
         order by r.script_name"
    )->fetchAll();
}

function registry_history(PDO $pdo, ?string $scriptName = null, int $limit = 100): array
{
    if (!table_exists($pdo, 'jarvis_script_registry_history')) {
        return [];
    }

    $limit = max(1, min(500, $limit));

    if ($scriptName === null) {
        $statement = $pdo->prepare(
            'select id,script_name,change_type,coalesce(version,\'\') as version,file_name,coalesce(description,\'\') as description,required_env_json,is_active,changed_at
             from jarvis_script_registry_history
             order by changed_at desc, id desc
             limit :l'
        );
        $statement->bindValue(':l', $limit, PDO::PARAM_INT);
        $statement->execute();

        return $statement->fetchAll();
    }

    $statement = $pdo->prepare(
        'select id,script_name,change_type,coalesce(version,\'\') as version,file_name,coalesce(description,\'\') as description,required_env_json,is_active,changed_at
         from jarvis_script_registry_history
         where script_name=:n
         order by changed_at desc, id desc
         limit :l'
    );
    $statement->bindValue(':n', $scriptName);
    $statement->bindValue(':l', $limit, PDO::PARAM_INT);
    $statement->execute();

    return $statement->fetchAll();
}

function registry_exists(PDO $pdo, string $name): bool
{
    $statement = $pdo->prepare('select 1 from jarvis_script_registry where script_name=:n');
    $statement->execute(['n' => $name]);

    return (bool) $statement->fetchColumn();
}

function registry_add(PDO $pdo, string $name, string $file, string $desc, array $req, bool $active): void
{
    $statement = $pdo->prepare(
        'insert into jarvis_script_registry(script_name,file_name,description,required_env_json,is_active,updated_at) values(:n,:f,:d,cast(:j as jsonb),:a,now())'
    );
    $statement->execute([
        'n' => $name,
        'f' => $file,
        'd' => $desc,
        'j' => json_encode($req, JSON_UNESCAPED_SLASHES),
        'a' => $active,
    ]);
}

function registry_toggle(PDO $pdo, string $name): void
{
    $statement = $pdo->prepare('update jarvis_script_registry set is_active=not is_active, updated_at=now() where script_name=:n');
    $statement->execute(['n' => $name]);
}

function registry_delete(PDO $pdo, string $name): void
{
    $statement = $pdo->prepare('delete from jarvis_script_registry where script_name=:n');
    $statement->execute(['n' => $name]);
}

function registry_script_file_name(): string
{
    return 'jarvis-script-registry.sh';
}

function registry_runner_params(): array
{
    $params = [
        'mode' => '',
        'scripts_root' => scripts_root(),
        'db_host' => env_value('JARVIS_PG_HOST') ?: 'jarvis_postgres',
        'db_port' => env_value('JARVIS_PG_PORT') ?: '5432',
        'db_name' => env_value('JARVIS_PG_DB') ?: 'jarvis_memory',
        'db_user' => env_value('JARVIS_PG_USER') ?: 'n8n',
        'db_password' => env_value('JARVIS_PG_PASSWORD') ?: '',
    ];

    return $params;
}

function registry_script_available(): bool
{
    return is_file(script_abs(registry_script_file_name()));
}

function run_script_process(string $command, array $scriptEnv): array
{
    $env = array_merge(env_all(), $scriptEnv);
    $spec = [
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    $process = proc_open($command, $spec, $pipes, null, $env);

    if (!is_resource($process)) {
        throw new RuntimeException('Impossible de demarrer le script.');
    }

    $stdout = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $exitCode = proc_close($process);

    return [
        'stdout' => trim((string) $stdout),
        'stderr' => trim((string) $stderr),
        'exit_code' => $exitCode,
    ];
}

function build_cmd_from_file(string $fileName, string $phase, bool $confirmed, array $params): string
{
    $parts = [
        'bash',
        escapeshellarg(script_abs($fileName)),
        '--phase',
        escapeshellarg($phase),
        '--confirmed',
        escapeshellarg($confirmed ? 'true' : 'false'),
    ];

    foreach ($params as $key => $value) {
        $parts[] = '--param';
        $parts[] = escapeshellarg((string) $key . '=' . (string) $value);
    }

    return implode(' ', $parts);
}

function registry_run_json(string $mode, string $phase = 'collect', bool $confirmed = false, array $params = []): array
{
    if (!registry_script_available()) {
        throw new RuntimeException(
            'Le script jarvis-script-registry.sh est introuvable dans ' . scripts_root() . '.'
        );
    }

    $runnerParams = registry_runner_params();
    $runnerParams['mode'] = $mode;

    foreach ($params as $key => $value) {
        $runnerParams[$key] = $value;
    }

    $command = build_cmd_from_file(registry_script_file_name(), $phase, $confirmed, $runnerParams);
    $result = run_script_process($command, []);

    if ($result['exit_code'] !== 0) {
        throw new RuntimeException("Le registry script a echoue.\n" . trim($result['stdout'] . "\n" . $result['stderr']));
    }

    $decoded = json_decode($result['stdout'], true);
    if (!is_array($decoded)) {
        throw new RuntimeException('Le registry script n a pas retourne un JSON valide.');
    }

    return $decoded;
}

function scan_scripts(): array
{
    return scan_script_root(scripts_root());
}

function scan_install_catalog_scripts(): array
{
    return scan_script_root(script_install_catalog_root());
}

function install_script_into_runtime(string $relativePath, bool $overwrite = false): array
{
    $relative = safe_script_rel($relativePath);
    $source = script_install_source_abs($relative);
    $target = script_abs($relative);

    if (!is_file($source)) {
        throw new RuntimeException('Le script source a installer est introuvable dans le catalogue.');
    }

    if (is_file($target) && !$overwrite) {
        throw new RuntimeException('Le script existe deja dans le systeme Jarvis. Utilise le mode ecrasement si besoin.');
    }

    $targetDir = dirname($target);
    if (!is_dir($targetDir) && !mkdir($targetDir, 0775, true) && !is_dir($targetDir)) {
        throw new RuntimeException('Impossible de creer le dossier cible pour le script.');
    }

    if (!copy($source, $target)) {
        throw new RuntimeException('La copie du script a echoue.');
    }

    $sourcePerms = @fileperms($source);
    $mode = $sourcePerms !== false ? ($sourcePerms & 0777) : 0755;
    @chmod($target, $mode);

    return [
        'source' => $source,
        'target' => $target,
        'relative_path' => $relative,
        'mode' => substr(sprintf('%o', $mode), -4),
    ];
}

function precheck(PDO $pdo, string $scriptName): array
{
    $versionAvailable = column_exists($pdo, 'jarvis_script_registry', 'version');
    $versionSelect = $versionAvailable ? "coalesce(version,'') as version," : '';
    $statement = $pdo->prepare(
        "select script_name,file_name,{$versionSelect}coalesce(description,'') as description,required_env_json,is_active,updated_at from jarvis_script_registry where script_name=:n"
    );
    $statement->execute(['n' => $scriptName]);
    $row = $statement->fetch();

    if (!$row) {
        throw new RuntimeException('Script introuvable dans la registry.');
    }

    $requiredEnvDefinitions = required_env_definitions(json_decode((string) $row['required_env_json'], true));
    $requiredEnv = required_env_names($requiredEnvDefinitions, true);
    $allEnv = required_env_names($requiredEnvDefinitions, false);
    $allEnv = array_values(array_unique(array_merge($allEnv, script_explicit_fallback_env_names($scriptName))));

    $scriptEnv = script_env_values($pdo, $scriptName);
    foreach ($allEnv as $envName) {
        $name = (string) $envName;
        if ($name === '' || (array_key_exists($name, $scriptEnv) && trim((string) $scriptEnv[$name]) !== '')) {
            continue;
        }

        $fallback = runtime_config_value($pdo, $name, $name);
        if ($fallback !== null && trim($fallback) !== '') {
            $scriptEnv[$name] = $fallback;
        }
    }
    $missing = [];

    foreach ($requiredEnv as $envName) {
        $name = (string) $envName;
        if ($name === '' || !array_key_exists($name, $scriptEnv) || trim((string) $scriptEnv[$name]) === '') {
            $missing[] = $name;
        }
    }

    $active = (string) $row['is_active'] !== '0' && strtolower((string) $row['is_active']) !== 'false';
    $fileFound = is_file(script_abs((string) $row['file_name']));

    return [
        'row' => $row,
        'missing' => $missing,
        'active' => $active,
        'file_found' => $fileFound,
        'required_env' => $requiredEnv,
        'required_env_definitions' => $requiredEnvDefinitions,
        'script_env' => $scriptEnv,
        'script_env_count' => count($scriptEnv),
    ];
}

function build_cmd(string $fileName, string $phase, bool $confirmed, array $params): string
{
    return build_cmd_from_file($fileName, $phase, $confirmed, $params);
}

function run_script_command(string $command, array $scriptEnv): string
{
    $result = run_script_process($command, $scriptEnv);

    if ((int) $result['exit_code'] !== 0) {
        throw new RuntimeException(
            "Le script a echoue avec le code " . (int) $result['exit_code'] . ".\n"
            . trim((string) $result['stdout'] . "\n" . (string) $result['stderr'])
        );
    }

    return (string) $result['stdout'];
}

function jarvis_script_jobs_root(): string
{
    $candidates = [
        env_value('JARVIS_SCRIPT_JOBS_DIR'),
        jarvis_data_path('tmp/script-jobs'),
        jarvis_data_path('logs/script-jobs'),
        rtrim(sys_get_temp_dir(), '/\\') . '/jarvis-script-jobs',
    ];

    foreach ($candidates as $candidate) {
        $path = trim((string) $candidate);
        if ($path === '') {
            continue;
        }

        if (is_dir($path)) {
            return $path;
        }

        $parent = dirname($path);
        if (is_dir($parent) && is_writable($parent)) {
            return $path;
        }
    }

    return rtrim(sys_get_temp_dir(), '/\\') . '/jarvis-script-jobs';
}

function jarvis_ensure_dir(string $path): void
{
    if (is_dir($path)) {
        return;
    }

    if (!mkdir($path, 0775, true) && !is_dir($path)) {
        throw new RuntimeException('Impossible de creer le dossier: ' . $path);
    }
}

function jarvis_script_job_path(string $jobId, string $suffix = ''): string
{
    $base = jarvis_script_jobs_root() . '/' . $jobId;
    return $suffix === '' ? $base : $base . '/' . ltrim($suffix, '/');
}

function jarvis_write_json_file(string $path, array $payload): void
{
    $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (!is_string($json) || file_put_contents($path, $json) === false) {
        throw new RuntimeException('Impossible d ecrire le fichier JSON: ' . $path);
    }
}

function jarvis_read_json_file(string $path): array
{
    if (!is_file($path)) {
        return [];
    }

    $decoded = json_decode((string) file_get_contents($path), true);
    return is_array($decoded) ? $decoded : [];
}

function jarvis_truncate_text(string $text, int $limit = 12000): string
{
    if (strlen($text) <= $limit) {
        return $text;
    }

    return substr($text, 0, $limit) . "\n...[truncated]";
}

function jarvis_is_truncated_text(string $text, int $limit = 12000): bool
{
    return strlen($text) > $limit;
}

function jarvis_start_script_job(string $command, array $scriptEnv, array $meta = []): array
{
    jarvis_ensure_dir(jarvis_script_jobs_root());

    $jobId = bin2hex(random_bytes(16));
    $jobDir = jarvis_script_job_path($jobId);
    jarvis_ensure_dir($jobDir);

    $stdoutFile = jarvis_script_job_path($jobId, 'stdout.log');
    $stderrFile = jarvis_script_job_path($jobId, 'stderr.log');
    $exitFile = jarvis_script_job_path($jobId, 'exit_code.txt');
    $metaFile = jarvis_script_job_path($jobId, 'meta.json');

    $payload = array_merge([
        'job_id' => $jobId,
        'status' => 'running',
        'created_at' => date('c'),
        'command' => $command,
        'pid' => null,
    ], $meta);
    jarvis_write_json_file($metaFile, $payload);

    $runnerScript = "( {$command} ) > " . escapeshellarg($stdoutFile)
        . " 2> " . escapeshellarg($stderrFile)
        . "; printf '%s' \"\\$?\" > " . escapeshellarg($exitFile);
    $shellCommand = "nohup bash -lc " . escapeshellarg($runnerScript) . " >/dev/null 2>&1 & echo $!";

    $spec = [
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    $process = proc_open($shellCommand, $spec, $pipes, null, array_merge(env_all(), $scriptEnv));

    if (!is_resource($process)) {
        throw new RuntimeException('Impossible de demarrer le job async.');
    }

    $pid = trim((string) stream_get_contents($pipes[1]));
    fclose($pipes[1]);
    $stderr = trim((string) stream_get_contents($pipes[2]));
    fclose($pipes[2]);
    $exitCode = proc_close($process);

    if ($exitCode !== 0 || $pid === '') {
        throw new RuntimeException('Impossible de lancer le job async.' . ($stderr !== '' ? "\n" . $stderr : ''));
    }

    $payload['pid'] = $pid;
    jarvis_write_json_file($metaFile, $payload);

    return [
        'job_id' => $jobId,
        'pid' => $pid,
        'status' => 'running',
    ];
}

function jarvis_get_script_job(string $jobId): array
{
    $jobDir = jarvis_script_job_path($jobId);
    if (!is_dir($jobDir)) {
        throw new RuntimeException('Job introuvable.');
    }

    $meta = jarvis_read_json_file(jarvis_script_job_path($jobId, 'meta.json'));
    $stdout = is_file(jarvis_script_job_path($jobId, 'stdout.log'))
        ? (string) file_get_contents(jarvis_script_job_path($jobId, 'stdout.log'))
        : '';
    $stderr = is_file(jarvis_script_job_path($jobId, 'stderr.log'))
        ? (string) file_get_contents(jarvis_script_job_path($jobId, 'stderr.log'))
        : '';
    $exitFile = jarvis_script_job_path($jobId, 'exit_code.txt');

    $status = 'running';
    $exitCode = null;
    if (is_file($exitFile)) {
        $status = 'completed';
        $exitCode = (int) trim((string) file_get_contents($exitFile));
        if ($exitCode !== 0) {
            $status = 'failed';
        }
    } elseif (($meta['status'] ?? '') === 'killed') {
        $status = 'killed';
    } elseif (($meta['pid'] ?? '') !== '') {
        $pid = (int) $meta['pid'];
        if ($pid > 0) {
            $running = false;
            if (function_exists('posix_kill')) {
                $running = @posix_kill($pid, 0);
            } else {
                $probe = [];
                $probeExit = 1;
                @exec('kill -0 ' . $pid . ' >/dev/null 2>&1', $probe, $probeExit);
                $running = $probeExit === 0;
            }

            if (!$running) {
                $status = 'failed';
            }
        }
    }

    return [
        'job_id' => $jobId,
        'status' => $status,
        'created_at' => (string) ($meta['created_at'] ?? ''),
        'script_name' => (string) ($meta['script_name'] ?? ''),
        'service_name' => (string) ($meta['service_name'] ?? ''),
        'phase' => (string) ($meta['phase'] ?? ''),
        'pid' => (string) ($meta['pid'] ?? ''),
        'exit_code' => $exitCode,
        'stdout' => jarvis_truncate_text(trim($stdout)),
        'stderr' => jarvis_truncate_text(trim($stderr)),
        'stdout_truncated' => jarvis_is_truncated_text(trim($stdout)),
        'stderr_truncated' => jarvis_is_truncated_text(trim($stderr)),
        'progress' => jarvis_extract_progress_from_text($stderr),
    ];
}

function jarvis_extract_progress_from_text(string $text): ?array
{
    $lines = preg_split('/\r\n|\r|\n/', $text) ?: [];
    for ($i = count($lines) - 1; $i >= 0; $i--) {
        $line = trim((string) $lines[$i]);
        if ($line === '') {
            continue;
        }

        if (!preg_match('/STEP\s+(\d+)\/(\d+)\s+(START|OK|FAIL):\s*(.+)$/i', $line, $matches)) {
            continue;
        }

        $current = (int) ($matches[1] ?? 0);
        $total = (int) ($matches[2] ?? 0);
        if ($current <= 0 || $total <= 0) {
            continue;
        }

        $state = strtolower((string) ($matches[3] ?? 'unknown'));
        if ($state === 'start') {
            $state = 'running';
        } elseif ($state === 'fail') {
            $state = 'failed';
        }

        return [
            'current' => $current,
            'total' => $total,
            'percent' => max(0, min(100, (int) round(($current / $total) * 100))),
            'label' => trim((string) ($matches[4] ?? '')) ?: null,
            'state' => $state,
            'line' => $line,
        ];
    }

    return null;
}

function jarvis_kill_script_job(string $jobId): array
{
    $job = jarvis_get_script_job($jobId);
    if (($job['status'] ?? '') !== 'running') {
        return $job;
    }

    $pid = (int) ($job['pid'] ?? 0);
    if ($pid <= 0) {
        throw new RuntimeException('PID de job introuvable.');
    }

    $killed = false;
    if (function_exists('posix_kill')) {
        $killed = @posix_kill($pid, SIGTERM);
    } else {
        $output = [];
        $exitCode = 1;
        @exec('kill ' . $pid . ' >/dev/null 2>&1', $output, $exitCode);
        $killed = $exitCode === 0;
    }

    if (!$killed) {
        throw new RuntimeException('Impossible d arreter le job.');
    }

    $metaFile = jarvis_script_job_path($jobId, 'meta.json');
    $meta = jarvis_read_json_file($metaFile);
    $meta['status'] = 'killed';
    $meta['killed_at'] = date('c');
    jarvis_write_json_file($metaFile, $meta);

    return jarvis_get_script_job($jobId);
}

function services_default(): array
{
    return [
        ['name' => 'OpenWebUI', 'url' => 'http://jarvis_openwebui:8080'],
        ['name' => 'Ollama', 'url' => 'http://jarvis_ollama:11434'],
        ['name' => 'MCPO', 'url' => 'http://jarvis_mcpo:8000'],
    ];
}

function http_check(string $url): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_TIMEOUT => 4,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
    ]);

    $start = microtime(true);
    $body = curl_exec($ch);
    $errno = curl_errno($ch);
    $error = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ms = (int) round((microtime(true) - $start) * 1000);
    curl_close($ch);

    return [
        'ok' => $errno === 0 && $code > 0 && $code < 500,
        'code' => $code,
        'ms' => $ms,
        'error' => $error,
        'body' => (string) $body,
    ];
}
