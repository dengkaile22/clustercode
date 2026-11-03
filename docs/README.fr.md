# clustercode

**Un cluster d'agents longue durée pour [OpenCode](https://github.com/anomalyco/opencode).**
Le modèle écrit lui-même son DAG de tâches, le plugin rend la main à la fin de chaque tour,
les membres de l'équipe tournent de siège en siège, et la file s'exécute jusqu'à épuisement.

[English](../README.md) · [简体中文](README.zh-CN.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português](README.pt-BR.md)

[![check](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml/badge.svg)](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml)

---

## Pourquoi

OpenCode V2 (API de plugins 2.x, `Plugin.define`) a réécrit la surface des plugins : ceux écrits
pour la 1.x ne se chargent plus. La V2 fournit les sous-agents en arrière-plan, la compaction et
le préchauffage, mais pas les deux briques indispensables à une exécution sans surveillance :

1. **La continuation** — à la fin d'un tour, rien ne lance le suivant. Il faut appuyer sur Entrée.
2. **La rotation des rôles** — un seul agent fait tout, au lieu d'un planificateur, d'un développeur,
   d'un relecteur et d'un testeur qui se relaient.

`clustercode` apporte ces deux briques, plus les garde-fous qui rendent raisonnable l'idée de
laisser tourner un run pendant 24 heures.

## Fonctionnalités

| Fonction | Rôle |
|---|---|
| **DAG de tâches** | `dependsOn` entre tâches. Une tâche n'est exécutable que si toutes ses dépendances sont `done`. |
| **Planification automatique** | `cluster_auto({ goal })` appelle le modèle une fois, hors session, pour transformer un objectif en DAG. |
| **Rotation des sièges** | Les membres sont de vrais fichiers d'agent (`clustercode-<id>.md`). Le plugin change de siège avec `switchAgent` entre deux tours. Une tâche peut épingler un membre. |
| **Porte de vérification** | Marquer `done` exécute réellement la commande `verify`. Un code de sortie non nul refuse la mise à jour et renvoie la sortie. |
| **Battement 24 h** | Avec `heartbeat: true`, une session inactive est réveillée après un délai de refroidissement : un run interrompu repart seul. |
| **Garde-fous** | Travail en arrière-plan, file terminée, interblocage, plafond de tours, stagnation : un seul endroit, un seul ordre. |
| **Trois points d'entrée** | Serveur (hooks, outils, RPC), TUI (statut + panneau `/cluster`), Desktop (panneau latéral + pastille + menus). |
| **Ajout et reprise** | `cluster_plan({ append: true })` allonge une file en cours. `cluster_retry` remet les tâches échouées dans la file. |

## Installation

Clonez, puis pointez OpenCode vers le **répertoire** (pas un fichier) dans
`~/.config/opencode/opencode.json` :

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/you/Desktop/clustercode"]
}
```

L'hôte trouve chaque moitié via `package.json` → `exports` :

| exports | Moitié | Contenu |
|---|---|---|
| `.` | serveur | outils, hooks, commandes, RPC, battement |
| `./tui` | terminal | segment de statut, panneau `/cluster` |
| `./gui-experimental` | desktop | panneau latéral, pastille, menus (`dist/*.cjs`) |

Deux règles d'exploitation :

- La moitié desktop est **précompilée**. Lancez `npm run build` après un clone, sinon le panneau
  desktop n'a aucun point d'entrée.
- L'hôte ne sonde les `exports` **qu'au démarrage**. Après un changement d'`exports` ou une
  recompilation de l'interface, redémarrez le serveur et l'application desktop.
  `opencode reload` ne relit que la configuration. `npm run check:entry` vérifie la sonde avant.

Nécessite l'hôte de plugins OpenCode 2.x (`@opencode/plugin >= 2.0.27 < 3`). Les scripts de
développement demandent Node 22.18+.

## Démarrage rapide

1. Redémarrez OpenCode pour charger le plugin.
2. Appuyez sur **Maj+Tab** jusqu'à l'agent `clustercode`. Ce mode existe pour ça : il demande au
   modèle de confier le travail à la file au lieu de tout faire seul.
3. Demandez quelque chose, ou pilotez les outils :

```
cluster_auto({ "goal": "ajouter une option --json au chargeur de config, avec tests et docs" })
```

```
cluster_plan({
  "goal": "durcir l'importateur",
  "tasks": [
    { "id": "t1", "title": "refuser les fichiers de plus de 10 Mo", "verify": "node test/import.test.ts" },
    { "id": "t2", "title": "documenter la limite", "dependsOn": ["t1"] }
  ],
  "maxRounds": 5
})
```

4. Suivez le run : `/cluster` ouvre le panneau. En TUI, le pied de page affiche
   `cluster 2/5 · turn 3 · coder` ; sur le desktop, une pastille au-dessus du champ de saisie
   affiche la même progression.
5. Arrêtez avec `/cluster-stop`, reprenez avec `/cluster-resume`.

Conseil pour un premier run : gardez `maxRounds: 5` jusqu'à ce que le plan inspire confiance.
`maxRounds: null` avec des permissions grandes ouvertes tourne vraiment jusqu'à vider la file.

## Outils

| Outil | Rôle |
|---|---|
| `cluster_auto` | Un objectif en entrée, un DAG généré, le run démarre. Crée l'équipe par défaut s'il n'y en a pas. |
| `cluster_plan` | File explicite : `dependsOn`, `verify`, `member`, `maxRounds`, `maxStagnant`, `heartbeat`, `append`. |
| `cluster_update` | Déclare `pending` / `running` / `done` / `failed`. `done` passe par la porte de vérification. |
| `cluster_status` | Tour, file, siège suivant, tâches bloquées, battement, raison d'arrêt. |
| `cluster_team` | Crée ou remplace l'équipe. `adoptCluster: true` reprend un `clustercode.md` écrit à la main. |
| `cluster_retry` | Remet les tâches échouées à `pending`, efface la raison d'arrêt et repart. |

Commandes : `/cluster-stop`, `/cluster-resume`, `/cluster` (panneau).

## Équipe intégrée

Remplacez-la avec `cluster_team({ members: [...] })`. Chaque membre accepte `id`, `role`, `color`,
`extra` et `model`.

| id | Rôle | Remarque |
|---|---|---|
| `architect` | Découpe, fixe les interfaces, écrit le plan | n'écrit pas de code de production |
| `coder` | Implémente le plan | vérifie son propre changement |
| `reviewer` | Relecture en lecture seule | le frontmatter refuse les appels `edit:*` |
| `tester` | Lance les tests, reproduit les bugs, prouve les critères | ne croit que la sortie réelle |

Le siège `reviewer` est une restriction de **politique**, pas un bac à sable. Pour qu'un agent ne
puisse pas toucher au système de fichiers, il faut le limiter au niveau de l'OS.

## Un tour, concrètement

```
experimental.idle
   ├─ du travail tourne encore en arrière-plan ? → attendre (il nous réveillera)
   ├─ la file est terminée ?                     → arrêt (finished)
   ├─ le graphe est bloqué ?                     → arrêt (deadlock)
   ├─ plafond de tours atteint ?                 → arrêt (max-rounds)
   ├─ le prochain tour stagnerait ?              → arrêt (stagnant)
   └─ sinon
        switchAgent(siège suivant)  → le curseur n'avance qu'en cas de succès
        round += 1, sauvegarde, publication de l'instantané
        synthetic({ resume: true, text: "tour N, tâche tX, rapport via cluster_update" })
```

`resume: true` est le détail porteur. Sans lui, le texte injecté attend un réveil futur qu'une
session inactive ne recevra jamais : le run s'arrête en silence. Le battement appelle la même
fonction `decide()`, donc un cluster ayant atteint son plafond est arrêté là aussi, au lieu d'être
réveillé pour un tour de plus.

## Architecture

```
core (pur, testable)
  state.ts      DAG, rotation, compteurs, empreinte d'état
  scheduler.ts  decide() + commit() : l'ordre des garde-fous, une seule fois
  plan.ts       objectif → DAG, réparation JSON, détection de cycle
  store.ts      persistance avec cache et écritures sérialisées + FileStorage
        │
serveur (src/index.ts)
  hook idle · carte système · commandes · outils · battement · RPC d'instantané
        │  clustercode.snapshot { get } → SnapshotView
        ├──────────────┬─────────────────────────┐
   TUI (src/tui.tsx)                 Desktop (dist/gui-experimental.cjs)
   statut + panneau /cluster          panneau latéral + pastille + commandes
```

Les deux moitiés d'interface ne lisent que le RPC. Elles ne touchent ni à la mémoire ni au disque
du serveur : un desktop connecté à un serveur distant se comporte comme en local. Elles partagent
les libellés de `status.ts`, donc le pied de page et le panneau ne peuvent pas se contredire.

## Garde-fous et coût

- **Stagnation** : 12 tours sans changement de statut par défaut. `maxStagnant: 0` la désactive ;
  `maxRounds` devient alors le seul filet.
- **Plafond de tours** : `null` par défaut. À renseigner pour les premiers runs.
- **Interblocage** : un cycle ou une dépendance en échec arrête immédiatement le run avec une
  explication, au lieu de tourner jusqu'au compteur de stagnation.
- **Battement** : activé par défaut dans `cluster_auto`, désactivé dans `cluster_plan`.
  Intervalle minimum 15 s, défaut 60 s. Il respecte le plafond et la stagnation.

Tout est évalué dans `decide()` ; il n'existe pas de seconde copie des règles.

## Vérifié

```
npm run check
  typecheck (tsc --noEmit, TSX inclus)
  169 assertions (node --test, sans modèle, sans réseau)
  build : dist/gui-experimental.cjs + vérification de compilation TUI
  sonde d'entrées : serveur / tui / desktop résolus
  câblage TUI + câblage desktop
```

Ce que ces vérifications **ne prouvent pas** : le rendu réel (il faut une TUI ou l'application
desktop) et un run complet sans surveillance face à un vrai modèle (il faut des tokens).

## Développement

```powershell
npm install
npm run check        # tout ce qui précède, dans l'ordre
npm run test         # assertions seules
npm run typecheck
npm run build        # bundle desktop + vérification de compilation TUI
npm run check:entry  # reproduit la sonde d'exports de l'hôte
```

Les tests redirigent le répertoire d'agents avec `CLUSTERCODE_AGENTS_DIR` : ils n'écrivent jamais
dans votre `~/.config/opencode/agents`.

`docs/development.md` explique la copie de référence du code source OpenCode dans `opencode/` et
comment revérifier l'API de l'hôte.

## Limites connues

- **Séquentiel, une voie par session.** Le cluster exécute un tour à la fois ; le parallélisme est
  celui des sous-agents en arrière-plan, auxquels le hook idle cède la place.
- **`cluster_plan` remplace la file** sauf avec `append: true`.
- **`experimental.idle` est expérimental.** Une montée de version de l'hôte peut changer sa forme ;
  lancez `npm run check` après chaque mise à jour.
- **La porte de vérification est une politique**, pas un bac à sable : elle exécute une commande shell.
- **Le schéma de sortie RPC doit lister chaque champ de l'instantané.** L'hôte décode en objet clos :
  un champ manquant donne `rpc.invalid_output` et des panneaux vides. `test/rpc.test.ts` compare la
  charge utile au schéma.
- **Une chaîne vide signifie « aucun »** : `currentMember`, `stoppedReason`, `member`, `color`,
  `verify` valent `""`, jamais `null`.
- **Le rendu exige un redémarrage** : l'hôte ne sonde les entrées qu'au démarrage.

## Filiation

`clustercode` est une réécriture indépendante des idées de **无限制 agent 群**
(`unlimited-agent-cluster`), un plugin OpenCode V2 écrit en chinois. Ce qui change ici :

- Textes, commentaires et documentation en anglais.
- Noms de fichiers `clustercode` / `clustercode-<id>` : les deux plugins peuvent cohabiter.
- Un seul `decide()` pour le hook idle et le battement, au lieu de deux copies de l'ordre.
- Un `stoppedCode` lisible par machine à côté de la raison humaine.
- `append` incrémental et `cluster_retry`.
- Un test de couverture du schéma RPC, qui était précisément le bug vidant les deux panneaux.

## Licence

MIT. Voir [LICENSE](../LICENSE).
