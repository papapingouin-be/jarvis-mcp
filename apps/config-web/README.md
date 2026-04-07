# Config Web

Interface PHP de pilotage, test et observation pour les outils Jarvis.

## Role

- piloter les outils et scripts depuis une interface humaine
- observer l'etat du runtime, des variables et des jobs
- administrer la configuration technique des scripts

## Frontiere voulue

- l'interface web ne doit pas porter la logique metier centrale
- les decisions applicatives doivent vivre dans le coeur Jarvis
- l'execution shell doit rester dans une couche dediee

## Etat V1

- le code PHP a ete deplace sous `apps/config-web`
- `html/inc/bootstrap.php` reste encore trop large et melange rendu, DB, jobs async et logique de test
- la prochaine etape consistera a remplacer progressivement ces fonctions par des appels vers un backend Jarvis plus propre
