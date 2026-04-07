CREATE TABLE IF NOT EXISTS jarvis_app_config (
    config_key TEXT PRIMARY KEY,
    config_value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jarvis_script_registry (
    script_name TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    required_env_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
