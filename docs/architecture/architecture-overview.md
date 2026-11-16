# Bunny Talks — Architecture technique

**Version : 1.1 — Novembre 2026**

**Statut : architecture de référence, harmonisée en 4.4C1 bis**

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

Les applications suivantes ont des responsabilités distinctes. `apps/mobile` contient une fondation Expo de diagnostic partiellement qualifiée sur un émulateur Android ; `apps/api` contient la persistance Prisma/PostgreSQL et la fondation HTTP NestJS limitée aux sessions et à la liveness ; `apps/crypto-lab` reste vide. La qualification iOS et celle des appareils physiques restent ouvertes.

| Application       | Responsabilité                                            | Technologie                | Statut                                                                         |
| ----------------- | --------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `apps/api`        | API, comptes, relations, communications, espaces partagés | NestJS ; Prisma/PostgreSQL | HTTP expérimental : liveness et session courante ; services sensibles internes |
| `apps/mobile`     | Application principale iOS et Android                     | React Native, Expo         | Fondation expérimentale ; qualification Android partielle                      |
| `apps/crypto-lab` | Banc d'essai et démonstration cryptographique             | À déterminer               | Prévu, non implémenté                                                          |
| `apps/web`        | Application web future                                    | À déterminer               | Différée                                                                       |

L'application mobile est prévue comme premier client du produit.

L'application web sera développée ultérieurement, sans imposer de dépendance architecturale au client mobile.

### 2.2. Packages partagés

Les packages ont vocation à contenir du code réutilisable par plusieurs applications. Les packages indiqués comme présents existent déjà, mais leurs responsabilités ci-dessous décrivent aussi des capacités futures.

| Package          | Responsabilité                                    | Statut                                      |
| ---------------- | ------------------------------------------------- | ------------------------------------------- |
| `contracts`      | Contrats et types partagés                        | Présent ; contrats de publication du coffre |
| `validation`     | Schémas de validation partagés                    | Présent ; e-mail et publication du coffre   |
| `crypto/core`    | Modèle cryptographique indépendant                | Présent ; fondations                        |
| `crypto/engine`  | Intégration du protocole cryptographique          | Présent ; évaluation expérimentale          |
| `crypto/storage` | Stockage local sécurisé                           | Prévu ; répertoire local vide               |
| `crypto/backup`  | Sauvegarde et restauration cryptographiques       | Présent ; composants expérimentaux          |
| `crypto/devices` | Gestion des identités et associations d'appareils | Prévu ; répertoire local vide               |

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

Le [jalon 4.4A](../development/email-registration.md) ajoute une identité e-mail vérifiée distincte de l’identifiant stable du compte et une intention temporaire de vérification, finalisée atomiquement avec le vérificateur serveur. Cette primitive interne ne crée ni session, ni coffre, ni autorisation d’appareil ; les parcours publics restent à réaliser. Le [jalon 4.4B](../development/initial-device-bootstrap.md) ajoute une composition interne pour publier le premier coffre et autoriser son appareil dans un commit PostgreSQL unique, avec mot de passe vérifié et association durable aux reçus.

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

L'arborescence ci-dessous présente la cible, avec les statuts actuels. Un répertoire local vide ne constitue pas une application ou un package implémenté ; sa présence n'est pas garantie dans un nouveau checkout Git.

```text
bunny-talks/
├── apps/
│   ├── api/                     # NestJS HTTP et persistance interne Prisma/PostgreSQL
│   ├── mobile/                  # diagnostics Expo/Hermes ; Android partiellement qualifié
│   ├── crypto-lab/              # prévu ; répertoire local vide
│   └── web/                     # différé
│
├── packages/
│   ├── contracts/               # présent ; contrats de publication du coffre
│   ├── validation/              # présent
│   └── crypto/
│       ├── core/                # présent ; fondations
│       ├── engine/              # présent ; expérimental
│       ├── storage/             # prévu ; répertoire local vide
│       ├── backup/              # présent ; expérimental
│       └── devices/             # prévu ; répertoire local vide
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

Le backend est une application NestJS unique, organisée par domaines fonctionnels. La [fondation HTTP 4.4C1](../development/http-sessions.md) compose un module principal, un module de sessions, un guard global avec exemption publique explicite et un filtre d’erreurs assaini. Seuls `GET /health/live`, `GET /v1/session` et `DELETE /v1/session` sont exposés. Les contrôleurs dépendent d’une capacité de session étroite, sans accès à Prisma ni aux mutations privilégiées du coffre. Les exigences TLS public, d’anti-abus et d’autorisation E2EE restent à qualifier avant production.

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

### 5.2. Clean Architecture pragmatique

Domain, Application, Infrastructure et Presentation désignent des **responsabilités et des règles de dépendance**, pas quatre dossiers obligatoires dans chaque fonctionnalité.

- **Domain** : règles pures, invariants et types métier, indépendants de NestJS, Express, Prisma et des fournisseurs extérieurs.
- **Application** : orchestration des opérations, préconditions d’authentification et d’autorisation, coordination des capacités nécessaires.
- **Infrastructure** : transactions, repositories PostgreSQL, client Prisma, pools et adaptateurs de services externes.
- **Presentation** : contrôleurs, guards, parsing et validation HTTP, projection des réponses et traitement assaini des erreurs.

Une classe peut combiner explicitement orchestration et transaction lorsque les séparer n’apporterait aucune frontière utile : les compositions internes `PostgresReauthentication` et `PostgresInitialDeviceBootstrap` conservent ainsi leurs garanties atomiques. Elles sont du code applicatif dépendant de PostgreSQL, et ne sont pas présentées comme un domaine pur.

Les fonctions pures restent des fonctions. Les contrôleurs reçoivent des capacités applicatives étroites et ne consultent ni Prisma ni les repositories privilégiés. Les entités internes ne sont pas retournées directement : le DTO de session est projeté explicitement.

### 5.3. Organisation effective et composition NestJS

```text
apps/api/
├── src/
│   ├── app.module.ts, application.ts, config.ts, main.ts
│   ├── auth/
│   │   ├── password-verifier.ts
│   │   ├── registration/        # identité e-mail, politique de mot de passe
│   │   ├── sessions/            # jetons, règles, repository et transport de session
│   │   ├── reauthentication/    # intention et composition transactionnelle
│   │   └── bootstrap/           # amorçage unique du premier appareil
│   ├── vault/                   # persistance, empreinte, digest et préparation
│   └── shared/
│       ├── database/            # propriétaire Prisma/pool et module de composition
│       └── http/                # transport, erreurs et contrôle de politique d’entrée
├── tests/
│   ├── unit/{auth,vault,shared}/
│   ├── persistence/{auth,vault,shared}/
│   ├── http/                    # Nest/PostgreSQL réels et qualification ESM
│   └── support/                 # base de test dédiée et contrôleur JSON de qualification
├── generated/prisma/            # client généré, ignoré par Git
└── prisma/                      # schéma et migrations existantes
```

Le [rapport 4.4C1 bis](../development/backend-architecture-harmonization.md) détaille l’inventaire, les déplacements et les vérifications. Les sous-dossiers d’authentification regroupent des responsabilités déjà implémentées ; `password-verifier.ts` reste directement dans `auth` car un dossier pour ce seul fichier serait superflu. Un dossier `vault` ne suppose pas l’existence d’un module NestJS de coffre.

`AppModule` compose une unique instance dynamique de `DatabaseModule`, la transmet explicitement à `SessionModule`, puis enregistre les guards globaux d’entrée et d’authentification. `DatabaseModule` possède le seul fournisseur `Database`, lequel ferme le client Prisma et son pool via le cycle de vie Nest. Aucun module global, singleton de base caché ou client créé par contrôleur. `SessionModule` exporte uniquement `SessionHttpService`, jamais `Database` ; sa factory limite le repository aux opérations nécessaires au transport. Les modules Nest organisent l’injection et les politiques HTTP, sans imposer Nest aux fonctions internes ni aux packages.

Les noms de fichiers restent en kebab-case, les classes en PascalCase, les fonctions et variables en camelCase. Les suffixes `.controller.ts`, `.module.ts` et `.guard.ts` identifient les composants Nest ; `postgres-` distingue le code lié à PostgreSQL. Les imports relatifs NodeNext utilisent `.js` et `import type` distingue les dépendances de types. Aucun barrel `index.ts` n’est ajouté au backend ; les entrées publiques existantes des packages partagés sont conservées.

### 5.4. Dépendances et abstractions

Une interface ou un port se justifie pour une dépendance extérieure, une frontière de confiance ou un besoin de test significatif. Les ports existants de transport e-mail, liste de compromission, aléa et KDF remplissent ce rôle. Il n’existe aucune obligation d’ajouter une interface devant chaque repository ou une classe injectable devant chaque règle pure. Le service de session reçoit un `Pick` de deux opérations du repository ; le type structurel de durée de session ne dépend plus du modèle Prisma. Le type `PreparedPasswordChange`, partagé avec la réauthentification, est défini indépendamment du repository et y reste réexporté pour conserver son contrat.

Dépendances effectives des workspaces :

```text
api ────────> contracts, validation, crypto-backup
mobile ─────> crypto-engine, crypto-backup
crypto-engine ──> crypto-core, SDK OpenE2EE
validation ──> Zod
crypto-backup ──> bibliothèques cryptographiques et de sérialisation
contracts, crypto-core ──> aucun autre workspace
```

Les packages ne dépendent pas des applications ni de Nest, Express ou Prisma. `crypto/core` ne dépend pas du SDK. Le mobile de diagnostic utilise encore directement certaines entrées publiques du SDK et des vecteurs JSON de qualification des packages ; cela décrit une fondation expérimentale, pas un parcours produit terminé. Cette exception existante n’est pas étendue par ce jalon.

Au sein de l’API, les compositions d’amorçage et de réauthentification dépendent explicitement des sessions et du coffre ; le coffre ne dépend pas de l’authentification. Le filtre HTTP traduit l’erreur publique de session, sans importer son repository. Les modules fonctionnels utilisent `shared/database` ; la base partagée ne dépend ni d’un domaine ni de la configuration HTTP. Les cycles sont interdits et contrôlés par un test du graphe des imports locaux, types et entrées des packages compris. Les appels directs à une capacité transactionnelle d’un autre domaine sont réservés aux compositions internes déjà identifiées, avec préconditions d’autorisation explicites ; les contrôleurs n’en héritent pas.

### 5.5. Tests et extension

- `pnpm test` : tests rapides des packages et du mobile, et `tests/unit` de l’API, sans connexion PostgreSQL. La suite API contrôle aussi les frontières d’import et l’affectation de chaque fichier de test à une seule suite.
- `test:persistence` de l’API : `tests/persistence`, PostgreSQL 18.7 réel, migrations historiques, concurrence, rollback et idempotence.
- `test:http` de l’API : build propre puis `tests/http`, serveur Nest réel, PostgreSQL réel, import de tous les modules ESM émis, démarrage et arrêt par SIGTERM.
- `tests/support` : support partagé, pas une suite autonome. Les vecteurs cryptographiques restent à leur emplacement d’origine.

Les schémas aléatoires sont créés uniquement dans la base locale dédiée `bunny_talks_test`, puis supprimés. Les garde-fous existants restent en place. Le build nettoie seulement `apps/api/dist` avant compilation afin de retirer les anciens chemins ; il émet `dist/src` et `dist/generated/prisma`, sans tests.

Pour une nouvelle route, composer explicitement dans le module fonctionnel les méthodes, le parseur borné et la politique corps/query, puis valider les données avec les schémas Zod et les pipes natifs Nest. Les protections globales restent indépendantes : en-têtes sûrs, refus des en-têtes ambigus, timeouts, erreurs et politique proxy. Les routes actuelles utilisent `jsonBodyPolicy()` puis `noInputPolicy(...)`, avant authentification, avec 8 Kio et les mêmes statuts qu’en 4.4C1. Le guard global `HttpInputGuard` refuse un handler dont aucun middleware d’entrée n’a accepté la requête, même public. `acceptHttpInput` constate ce passage ; il ne valide aucun schéma et n’accorde aucune identité. Pour une route avec corps, il ne remplace jamais un schéma et un pipe de validation. Le contrôle de schéma reste à examiner dans chaque nouvelle route.

La comparaison du build 4.4C1 révèle des variantes de casse et de slash final déjà acceptées par le routeur, malgré les réglages Express explicites. Leurs statuts et méthodes restent caractérisés sans changement dans ce jalon ; les contrôles de méthodes ci-dessus concernent les chemins canoniques. Voir l’[écart préexistant et sa qualification](../development/backend-architecture-harmonization.md#écart-de-routage-préexistant-découvert). Un durcissement sera une décision distincte.

Une fixture non émise dans le build démontre `@Body({ schema, pipes: [new StandardSchemaValidationPipe()] })` avec un schéma Zod partagé, une limite de 16 Kio et un refus de query. Il n’existe ni registre de routes maison ni moteur de validation supplémentaire. Une limite de publication E2EE sera décidée avec son endpoint et ses contraintes, sans modifier silencieusement celles des sessions. Aucune route d’inscription ni de connexion n’est ajoutée ici.

Restent différés : nouveaux modules Nest d’inscription/coffre/messagerie, organisation plus fine justifiée par leur volume futur, événements internes, infrastructure générique de ports, limites des publications, quotas et budgets Argon2id/anti-abus de 4.4C2. Les exigences TLS, qualification mobile et sécurité E2EE existantes demeurent ouvertes.

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

Un appareil supplémentaire s'authentifie puis obtient une autorisation individuelle par lien e-mail à usage unique lié à sa demande, avant tout accès aux données protégées. Il peut ensuite déverrouiller localement le coffre avec le mot de passe et restaurer l'identité sans ancien appareil. Une archive chiffrée indépendante des sessions de transport est à étudier pour l'historique ; sa conception et sa récupération ne sont pas démontrées. Le transfert par QR code est facultatif et reporté. Le premier appareil d’un compte jamais initialisé suit l’amorçage 4.4B : e-mail déjà vérifié à l’inscription, session valide et mot de passe récent, sans seconde preuve e-mail automatique. Une perte totale d’appareils ne réouvre jamais cet amorçage.

La distribution des messages doit tenir compte :

- Des appareils du destinataire.
- Des autres appareils autorisés de l'expéditeur.
- Des sessions cryptographiques propres à chaque paire d'appareils.

Le modèle précis de distribution reste à définir et à valider avec le moteur évalué ; aucun choix de protocole pour la production n'est définitif.

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

Les listes suivantes décrivent les responsabilités visées. Elles ne signifient pas que toutes ces capacités sont déjà implémentées ; les statuts actuels figurent dans la section 2.2.

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

OpenE2EE Signal Protocol SDK 14.5.0 est un candidat en évaluation ; son utilisation en production n'est pas encore validée.

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

La racine de `@bunny-talks/crypto-backup` expose les primitives et [enveloppes de clé maîtresse V1](../security/key-envelopes-v1.md), ainsi que la [composition authentifiée V1](../security/account-vault-v1.md) et son réenveloppement local, sans restauration de compte. Son entrée explicite `@bunny-talks/crypto-backup/experimental` conserve la validation structurelle, le contrat d'aléa, la création et l'ouverture du coffre direct V1 et la sérialisation candidate de charge de récupération. Ces formats expérimentaux ne définissent pas la cible à deux enveloppes. Leurs contrôles de structure et de bornes sont des pistes réutilisables, sans préjuger du futur format ni des secrets d'archive. L'ouverture authentifiée ne prouve ni contexte de compte attendu, ni fraîcheur, ni autorisation. Les dépendances et leur compatibilité mobile ne sont pas validées pour la production ; aucun parcours complet de restauration n'est implémenté. Voir [l'architecture cible du coffre](../security/recovery-vault-architecture.md).

### `crypto/devices`

Responsabilité :

- Association d'un nouvel appareil.
- Autorisation individuelle des appareils.
- Révocation.
- Gestion des identités d'appareils.
- Coordination des opérations multi-appareils.

Les frontières exactes entre ces packages pourront évoluer après validation du protocole.

### 8.1. Laboratoire cryptographique

`apps/crypto-lab` est prévu comme banc d'essai ; son répertoire local est actuellement vide.

Il pourra permettre de tester :

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

Le schéma Prisma est construit progressivement, après stabilisation des modèles fonctionnels et cryptographiques nécessaires. La [fondation 4.2A](../development/postgresql-prisma-foundation.md) et le [repository transactionnel 4.2B](../development/transactional-vault-repository.md) couvrent le stockage du coffre, les révisions et reçus ; les règles pures restent dans les packages indépendants de Prisma et NestJS. Les services d'authentification et d'autorisation devront imposer leurs préconditions avant toute exposition.

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
- Choix définitif du SDK cryptographique pour la production.
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
