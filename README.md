# Jarvis MCP Tools

Base propre pour les outils MCP Jarvis, l'interface web de configuration/test, et les executants systeme.

Le projet n'essaie plus d'etre un starter template generaliste. Il sert a preparer un socle maintenable avant l'ajout d'un futur point d'entree orchestrateur `jarvis_request`.

## Objectif

- exposer des outils MCP utilisables depuis OpenWebUI ou tout client MCP
- fournir une interface web pour piloter, tester et observer le runtime
- centraliser la logique metier Jarvis dans un coeur clair
- isoler l'execution shell, git, docker et ssh dans une couche dediee

## Structure V1

```text
apps/
  config-web/          Interface PHP de test/admin
docs/
  refactor-v1.md       Audit, architecture cible et plan de migration
src/
  jarvis/
    core/              Services metier Jarvis en cours d'extraction
    executors/         Adaptateurs shell/http
  modules/             Legacy metier encore a migrer
  tools/               Wrappers MCP
tools/
  scripts/             Executants shell historiques
```

## Composants

### Coeur Jarvis

- `src/jarvis/core/deploy/jarvis-sync-build-redeploy-service.ts`
  - workflow de sync/build/deploy centralise en TypeScript

### Couche d'execution

- `src/jarvis/executors/process/command-runner.ts`
- `src/jarvis/executors/http/fetch-runner.ts`

### MCP

- `src/server/`
  - boot du serveur MCP et transport HTTP/stdio
- `src/tools/`
  - outils exposes aux clients MCP

### Interface web

- `apps/config-web/`
  - UI PHP de pilotage et d'observation

## Commandes utiles

```bash
npm install
npm run build
npm test
npm run lint
npm run typecheck
npm run serve:stdio
npm run serve:http
```

## Variables d'environnement

- `JARVIS_MCP_TRANSPORT`
  - `stdio` ou `http`
- `PORT`
  - port HTTP si transport `http`
- `CORS_ORIGIN`
  - origine CORS acceptee

Compatibilite temporaire:

- `STARTER_TRANSPORT` reste accepte en fallback pour ne pas casser l'existant

## Documentation

- voir `docs/refactor-v1.md` pour l'audit, l'architecture cible et le plan de migration
