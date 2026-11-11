# Bunny Talks — Architecture technique

**Version : 1.0 — Novembre 2026**

**Statut : architecture de référence initiale**

## 1. Objectifs architecturaux

L'architecture de Bunny Talks doit répondre à plusieurs objectifs fondamentaux :

- Permettre le développement d'une application mobile iOS et Android.
- Préparer une future application web.
- Garantir la confidentialité des communications privées grâce au chiffrement de bout en bout.
- Permettre la gestion de plusieurs appareils par utilisateur.
- Faciliter l'évolution indépendante des fonctionnalités.
- Réutiliser les composants techniques entre les applications.
- Préserver une séparation stricte entre logique métier et infrastructure.
- Éviter les microservices et les abstractions prématurées.
- Concevoir dès le départ du code réutilisable en production.

L'architecture retenue est un **monolithe modulaire organisé en monorepo**, avec une application mobile et des packages partagés.

## 2. Vue d'ensemble

### 2.1. Applications

Le dépôt comporte plusieurs applications ayant des responsabilités distinctes.

| Application       | Responsabilité                                            | Technologie        |
| ----------------- | --------------------------------------------------------- | ------------------ |
| `apps/api`        | API, comptes, relations, communications, espaces partagés | NestJS             |
| `apps/mobile`     | Application principale iOS et Android                     | React Native, Expo |
| `apps/crypto-lab` | Banc d'essai et démonstration cryptographique             | À déterminer       |
| `apps/web`        | Application web future                                    | À déterminer       |

L'application mobile constitue le premier client du produit.

L'application web sera développée ultérieurement, sans imposer de dépendance architecturale au client mobile.

### 2.2. Packages partagés

Les packages contiennent du code réutilisable par plusieurs applications.

| Package          | Responsabilité                                    |
| ---------------- | ------------------------------------------------- |
| `contracts`      | Contrats et types partagés                        |
| `validation`     | Schémas de validation partagés                    |
| `crypto/core`    | Modèle cryptographique indépendant                |
| `crypto/engine`  | Intégration du protocole cryptographique          |
| `crypto/storage` | Stockage local sécurisé                           |
| `crypto/backup`  | Sauvegarde et restauration cryptographiques       |
| `crypto/devices` | Gestion des identités et associations d'appareils |

Le package `config` est reporté tant qu'un besoin réel de partage ne le justifie pas.

Les packages ne doivent pas être créés uniquement pour remplir une arborescence.

## 3. Stack technique retenue

### Backend

- Node.js 24 LTS.
- NestJS.
- TypeScript.
- Prisma.
- PostgreSQL.
- Redis lorsque des besoins concrets le justifieront.

PostgreSQL constitue la source de vérité des données persistantes du serveur.

Redis pourra être introduit pour la présence, le cache, la limitation de débit, les files de traitement et d'autres besoins de performance.

### Mobile

- React Native.
- TypeScript.
- Expo.
- Expo Development Builds.

Expo Go ne constitue pas l'environnement de référence pour les fonctionnalités nécessitant des modules natifs cryptographiques.

### Monorepo

- pnpm Workspaces.
- Organisation `apps/` et `packages/`.
- Turborepo éventuellement plus tard, lorsque le volume de projets justifiera son introduction.

### Qualité et tests

- TypeScript strict.
- ESLint.
- Prettier.
- Vitest pour les packages et le backend.
- Jest avec `jest-expo` envisagé pour les tests spécifiques à Expo.
- Playwright envisagé pour les tests de parcours web.
- Tests sur appareils réels pour les fonctionnalités natives sensibles.

## 4. Organisation du monorepo

```text
bunny-talks/
├── apps/
│   ├── api/
│   ├── mobile/
│   ├── crypto-lab/
│   └── web/                     # futur
│
├── packages/
│   ├── contracts/
│   ├── validation/
│   └── crypto/
│       ├── core/
│       ├── engine/
│       ├── storage/
│       ├── backup/
│       └── devices/
│
├── docs/
│   ├── product/
│   ├── architecture/
│   │   └── decisions/
│   ├── security/
│   └── development/
│
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── eslint.config.mjs
├── tsconfig.base.json
├── tsconfig.node.json
└── tsconfig.bundler.json
```

Les répertoires sont initialisés progressivement, au moment où leurs responsabilités deviennent concrètes.

## 5. Architecture backend

### 5.1. Monolithe modulaire

Le backend sera une application NestJS unique, organisée par domaines fonctionnels.

Les domaines envisagés comprennent notamment :

- Identité et comptes.
- Authentification et sessions.
- Profils.
- Découverte.
- Relations et demandes de contact.
- Lettres.
- Messagerie instantanée.
- Notes éphémères.
- Médias.
- Espaces partagés.
- Modules collaboratifs.
- Notifications.
- Gestion des appareils.
- Sauvegardes cryptographiques.
- Modération.
- Administration.

Ces domaines ne doivent pas devenir automatiquement des services indépendants.

Ils restent des modules d'un même backend tant qu'une raison technique ou opérationnelle ne justifie pas leur séparation.

### 5.2. Clean Architecture

Chaque module backend doit respecter une séparation claire des responsabilités.

**Domain**

Contient :

- Entités métier.
- Value Objects.
- Règles métier.
- Contrats des repositories.
- Invariants du domaine.

Le domaine ne dépend pas de NestJS, Prisma, Redis ou d'un fournisseur externe.

**Application**

Contient :

- Cas d'utilisation.
- Orchestration.
- Ports.
- DTO internes.
- Coordination des opérations métier.

**Infrastructure**

Contient :

- Implémentations Prisma.
- Adaptateurs PostgreSQL.
- Adaptateurs Redis.
- Services externes.
- Implémentations techniques des ports.

**Presentation**

Contient :

- Contrôleurs HTTP.
- Gateways WebSocket.
- Guards.
- Pipes.
- Présentation des réponses de l'API.

Les entités métier internes ne sont jamais exposées directement aux clients.

### 5.3. Communication entre modules

Les modules doivent communiquer au moyen d'interfaces et de contrats explicites.

Il faut éviter :

- Les dépendances circulaires.
- L'accès direct aux repositories internes d'un autre module.
- Les imports incontrôlés d'entités métier.
- Les appels directs à l'infrastructure d'un autre domaine.

Les événements internes pourront être introduits lorsqu'un besoin réel de découplage apparaîtra.

## 6. Architecture des communications

Les communications privées utilisent un chiffrement de bout en bout.

Le backend assure notamment :

- L'authentification des utilisateurs.
- Le routage des messages chiffrés.
- La gestion des appareils.
- La distribution des enveloppes chiffrées.
- La persistance des messages chiffrés selon les règles de conservation.
- Les accusés de réception.
- Les notifications.
- La gestion des pièces jointes chiffrées.

Le backend ne doit pas posséder les clés permettant de déchiffrer les communications privées.

### 6.1. Canaux distincts

Les trois canaux restent séparés :

- Lettres.
- Chat.
- Notes éphémères.

Une boîte de réception globale pourra agréger leurs événements sans fusionner leurs historiques.

### 6.2. Distribution multi-appareils

Les appareils de confiance d'un même compte partagent une identité cryptographique durable. Chaque appareil conserve ses propres identifiants d'enregistrement, sessions, préclés et clés locales de stockage lorsque le protocole l'exige.

Un compte peut disposer au maximum de cinq appareils de confiance.

Un nouvel appareil autorisé accède à l'historique par l'archive chiffrée, indépendante des sessions de transport. La récupération sans ancien appareil utilise un mécanisme distinct du transfert entre appareils.

La distribution des messages doit tenir compte :

- Des appareils du destinataire.
- Des autres appareils autorisés de l'expéditeur.
- Des sessions cryptographiques propres à chaque paire d'appareils.

Le modèle précis de distribution sera défini après sélection du protocole.

### 6.3. Médias

Les médias privés sont chiffrés localement avant leur transmission.

Le serveur conserve uniquement les fichiers chiffrés et les informations techniques nécessaires à leur distribution.

Les URL publiques permanentes ne sont pas autorisées pour les médias privés.

## 7. Architecture mobile

L'application mobile doit séparer les responsabilités de présentation, de logique applicative et d'accès aux services.

Les composants visuels ne doivent pas contenir directement :

- Les règles métier.
- La logique cryptographique.
- Les accès directs à la base locale.
- Les détails de communication avec l'API.

Les fonctionnalités cryptographiques et de stockage sécurisé sont accessibles par des interfaces dédiées.

Cette séparation doit permettre de tester les comportements sans dépendre systématiquement de l'interface graphique.

### 7.1. Stockage local

Le stockage local doit prendre en charge :

- Une base de données chiffrée.
- La protection des clés avec iOS Keychain et Android Keystore.
- La protection des caches temporaires.
- La synchronisation des données.
- La gestion des données après déconnexion.

Aucun contenu privé ne doit être conservé durablement en clair après déconnexion.

Les détails de la stratégie de nettoyage et de restauration restent à définir.

## 8. Packages cryptographiques

La cryptographie est isolée dans des packages réutilisables.

### `crypto/core`

Responsabilité :

- Modèle d'identité cryptographique.
- Modèle d'identité d'appareil.
- Modèle des sessions.
- Types et interfaces indépendants du protocole.
- Invariants de sécurité.
- Contrats des opérations cryptographiques.

Ce package ne doit pas dépendre de NestJS, Prisma, React Native ou d'un SDK cryptographique particulier.

### `crypto/engine`

Responsabilité :

- Adaptation du protocole retenu.
- Gestion des opérations cryptographiques.
- Gestion des sessions.
- Encapsulation du SDK choisi.

Le moteur doit être accessible au travers d'interfaces définies par le cœur cryptographique.

OpenE2EE Signal Protocol SDK 14.4.0 est un candidat en évaluation ; son utilisation en production n'est pas encore validée.

### `crypto/storage`

Responsabilité :

- Persistance des données cryptographiques.
- Stockage sécurisé des clés.
- Gestion des sessions locales.
- Intégration des mécanismes natifs iOS et Android.

### `crypto/backup`

Responsabilité :

- Création des sauvegardes chiffrées.
- Restauration.
- Gestion des versions du format.
- Gestion des suppressions et des snapshots.

### `crypto/devices`

Responsabilité :

- Association d'un nouvel appareil.
- Approbation cryptographique.
- Révocation.
- Gestion des identités d'appareils.
- Coordination des opérations multi-appareils.

Les frontières exactes entre ces packages pourront évoluer après validation du protocole.

### 8.1. Laboratoire cryptographique

`apps/crypto-lab` est un banc d'essai.

Il permet de tester :

- Les identités.
- Les échanges entre utilisateurs.
- Les sessions.
- La distribution multi-appareils.
- Les sauvegardes.
- La restauration.
- Les révocations.
- Les cas de panne.

Il ne doit pas contenir d'implémentation cryptographique de production jetable.

Toute logique réutilisable doit être développée directement dans les packages cryptographiques appropriés.

## 9. Contrats et validation

### Contracts

Le package `contracts` contient les structures échangées entre applications.

Exemples :

- Requêtes API.
- Réponses API.
- Événements temps réel.
- Notifications.
- Formats d'échange.

Il ne contient pas les entités internes du domaine ni les modèles Prisma.

### Validation

Le package `validation` utilise Zod.

Il contient les schémas de validation partagés entre le backend et le mobile.

Les validations de format et de structure sont distinctes des règles métier.

Une donnée valide syntaxiquement n'est pas nécessairement autorisée fonctionnellement.

## 10. Notifications et temps réel

Les communications temps réel devront prendre en charge :

- Distribution des messages.
- Présence, si activée.
- Accusés de réception.
- Synchronisation multi-appareils.
- Mise à jour des états de lecture.
- Événements des espaces partagés.

Les notifications push utilisent APNs et FCM.

Les contenus privés doivent être transmis sous forme d'enveloppes chiffrées et déchiffrés localement.

Le protocole précis de transport temps réel reste à définir.

## 11. Données et persistance

PostgreSQL constitue la source de vérité du serveur.

Les données sont organisées selon les responsabilités métier.

Le serveur doit distinguer :

- Données de compte.
- Profils et relations.
- Métadonnées de distribution.
- Messages chiffrés.
- Médias chiffrés.
- Appareils et clés publiques.
- Données des espaces partagés.
- Données de modération.
- Préférences et notifications.

Les informations sensibles ne doivent pas être exposées dans les logs.

Le schéma Prisma sera construit progressivement, après stabilisation des modèles fonctionnels et cryptographiques nécessaires.

## 12. Internationalisation

L'architecture prévoit dès le départ :

- Français et anglais.
- Langue d'interface indépendante de la langue des contenus.
- Préférence linguistique synchronisée.
- Langue de repli.
- Traduction des textes système, notifications et communications officielles.
- Déclaration des langues parlées ou comprises.

Les contenus des utilisateurs ne sont pas traduits automatiquement sans consentement.

## 13. Tests et qualité

Les tests doivent couvrir plusieurs niveaux.

**Tests unitaires**

- Logique métier.
- Validation.
- Règles de domaine.
- Comportements cryptographiques isolés.

**Tests d'intégration**

- Persistance.
- API.
- Interactions entre modules.
- Gestion des appareils.
- Distribution des messages.

**Tests natifs**

- Keychain.
- Keystore.
- Stockage chiffré.
- Modules cryptographiques natifs.
- Comportement sur iOS et Android.

**Tests de bout en bout**

- Parcours utilisateurs.
- Inscription.
- Relations.
- Correspondance.
- Espaces partagés.
- Récupération de compte.

**Tests cryptographiques spécifiques**

- Vecteurs de tests officiels.
- Interopérabilité.
- Tests de rejeu.
- Messages désordonnés.
- Perte et restauration de sessions.
- Ajout et révocation d'appareils.
- Tests de charge et de mémoire.

Les tests doivent être conservés et réutilisables dans le produit final.

## 14. Déploiement et exploitation

Les principes retenus :

- CI avec GitHub Actions.
- Vérification du formatage.
- Analyse ESLint.
- Vérification TypeScript.
- Exécution des tests.
- Construction des applications.

L'infrastructure de production, l'hébergement, les environnements et la stratégie de déploiement restent à définir.

Aucune dépendance à Kubernetes ou à une architecture distribuée n'est introduite sans justification.

## 15. Décisions ouvertes

Les points suivants ne sont pas encore définitivement définis :

- Organisation détaillée des modules NestJS.
- Modèle de données PostgreSQL.
- Protocole WebSocket.
- Choix du fournisseur de stockage média.
- Choix du SDK cryptographique.
- Modèle exact des identités et délégations cryptographiques.
- Détails du stockage local mobile.
- Infrastructure et hébergement.
- Stratégie CI/CD.
- Architecture détaillée de l'application web.

Ces décisions doivent être documentées au moment de leur validation.

## 16. Principes architecturaux non négociables

1. Monolithe modulaire avant microservices.
2. Clean Architecture et indépendance du domaine.
3. Pas de logique métier dans les contrôleurs ou composants visuels.
4. Pas de dépendance du domaine envers les frameworks.
5. Pas de secrets serveur dans l'application mobile.
6. Pas d'accès serveur global aux contenus privés chiffrés.
7. Pas de cryptographie maison.
8. Code de laboratoire réutilisable en production.
9. Tests conservés et automatisés.
10. Évolution progressive sans complexité prématurée.
