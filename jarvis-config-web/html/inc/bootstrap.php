<?php

declare(strict_types=1);

if (session_status() !== PHP_SESSION_ACTIVE) {
    @session_start();
}

function h(mixed $v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
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
    return '/var/www/data/scripts';
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

    foreach ($decoded as $value) {
        if (!is_string($value) || $value === '') {
            throw new RuntimeException('required_env_json doit contenir des chaines non vides.');
        }
    }

    return array_values($decoded);
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

function script_test_example_payload(string $scriptName, string $phase): array
{
    $normalizedPhase = trim($phase) === '' ? 'collect' : trim($phase);
    $example = [
        'script_name' => $scriptName,
        'phase' => $normalizedPhase,
        'confirmed' => $normalizedPhase === 'execute',
        'summary' => 'Exemple generique de params JSON.',
        'notes' => [
            'Adapte les valeurs a ton environnement avant execution reelle.',
        ],
        'params' => [],
    ];

    if ($scriptName === 'proxmox-diagnose.sh') {
        if ($normalizedPhase === 'execute') {
            $example['summary'] = 'Exemple de preflight pour la nouvelle version Proxmox.';
            $example['params'] = [
                'mode' => 'preflight-create',
                'host' => '192.168.11.248',
                'user' => 'root',
                'password' => 'change-me',
                'sudo' => true,
                'type' => 'ct',
                'template' => 'debian-12-standard_12.7-1_amd64.tar.zst',
                'storage' => 'local-lvm',
                'bridge' => 'vmbr0',
                'vmid' => '9100',
                'hostname' => 'ctdev',
                'cores' => '2',
                'memory' => '2048',
                'disk' => '8',
                'install_ssh' => true,
            ];
            $example['notes'] = [
                'Cet exemple reste non destructif car il utilise mode=preflight-create.',
                'Pour creer reellement un CT, remplace mode par create-ct.',
                'Les autres modes utiles sont get-ct-info, stop-ct, destroy-ct et ensure-ct.',
            ];
        } else {
            $example['summary'] = 'Exemple de collecte pour la nouvelle version Proxmox.';
            $example['confirmed'] = false;
            $example['params'] = [
                'mode' => 'collect',
                'host' => '192.168.11.248',
                'user' => 'root',
                'password' => 'change-me',
                'sudo' => true,
            ];
            $example['notes'] = [
                'Tu peux remplacer mode=collect par diagnose ou self-doc pour des tests plus simples.',
                'Les variables host, user et password peuvent aussi venir de la DB si tu les stockes comme variables de script.',
            ];
        }
    } elseif ($scriptName === 'proxmox-CTDEV.sh') {
        if ($normalizedPhase === 'execute') {
            $example['summary'] = 'Exemple historique pour proxmox-CTDEV.sh.';
            $example['params'] = [
                'vmid' => '9100',
                'hostname' => 'ctdev',
                'template' => 'debian-12-standard_12.7-1_amd64.tar.zst',
                'cores' => '2',
                'memory' => '2048',
                'storage' => 'local-lvm',
                'disk' => '8',
                'bridge' => 'vmbr0',
            ];
            $example['notes'] = [
                'Ce script est le point de depart historique.',
                'Pour la nouvelle logique de dev et diagnostic, prefere proxmox-diagnose.sh.',
            ];
        } else {
            $example['summary'] = 'La phase collect historique n utilise generalement pas de params.';
            $example['confirmed'] = false;
            $example['params'] = [];
            $example['notes'] = [
                'La collecte depend surtout des variables Proxmox chargees depuis la DB.',
                'Pour les nouveaux tests orientes dev, prefere proxmox-diagnose.sh.',
            ];
        }
    }

    $example['pretty_params_json'] = json_encode(
        $example['params'],
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
    );

    return $example;
}

function registry_all(PDO $pdo): array
{
    return $pdo->query(
        "select script_name,file_name,coalesce(description,'') as description,required_env_json,is_active,updated_at from jarvis_script_registry order by script_name"
    )->fetchAll();
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

function scan_scripts(): array
{
    $root = scripts_root();
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

        $relative = str_replace($root . '/', '', $file->getPathname());
        if (preg_match('#^[a-zA-Z0-9._/-]+$#', $relative)) {
            $out[] = $relative;
        }
    }

    sort($out);
    return $out;
}

function precheck(PDO $pdo, string $scriptName): array
{
    $statement = $pdo->prepare(
        "select script_name,file_name,coalesce(description,'') as description,required_env_json,is_active,updated_at from jarvis_script_registry where script_name=:n"
    );
    $statement->execute(['n' => $scriptName]);
    $row = $statement->fetch();

    if (!$row) {
        throw new RuntimeException('Script introuvable dans la registry.');
    }

    $requiredEnv = json_decode((string) $row['required_env_json'], true);
    if (!is_array($requiredEnv)) {
        $requiredEnv = [];
    }

    $scriptEnv = script_env_values($pdo, $scriptName);
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
        'script_env' => $scriptEnv,
        'script_env_count' => count($scriptEnv),
    ];
}

function build_cmd(string $fileName, string $phase, bool $confirmed, array $params): string
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

function run_script_command(string $command, array $scriptEnv): string
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
    $output = (string) $stdout . (string) $stderr;

    if ($exitCode !== 0) {
        throw new RuntimeException("Le script a echoue avec le code $exitCode.\n" . $output);
    }

    return $output;
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
