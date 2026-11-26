# Amorçage initial E2EE par HTTP — jalon 4.4C3

Statut de l’implémentation 4.4C3. Activation indépendante, désactivée par défaut et interdite en production. Les appareils supplémentaires, la reconnexion à un appareil historique, le transfert d’identité et la récupération de compte restent hors périmètre. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants pour la production.

## Audit et organisation

Le service réel est `auth/bootstrap/postgres-initial-device-bootstrap.ts`, et non dans `vault/`. Les signatures sont exactement `activate(sessionToken: unknown, password: string, request: unknown, candidateDigest: unknown)` et `recoverReceipt(sessionToken: unknown, request: unknown, candidateDigest: unknown)`. Elles restent inchangées. Le premier retourne un résultat terminal dans ses chemins actuels ; le second peut retourner `unknown`.

L’audit inclut `PostgresVaultRepository`, ses validations V1, digest et HMAC, les erreurs d’amorçage, le guard et son contexte privé, `SessionModule`, `LoginModule`, les politiques HTTP, `DatabaseModule`, `AppModule`, la configuration, les contrats/schémas partagés et les tests historiques PostgreSQL/HTTP. Les documents produit, architecture, archive/récupération, menaces restent les références des décisions existantes.

`VaultModule` compose les objets existants avec le même `DatabaseModule` que les autres domaines et n’exporte aucun fournisseur. Le contrôleur valide les enveloppes Zod puis appelle `BootstrapHttpService`, qui compare le compte à celui du guard, applique l’admission et choisit exclusivement la primitive correspondant à la route. Aucun pool, package ou repository métier supplémentaire. Aucune dépendance vers l’implémentation de connexion ou `SessionModule` ; graphe de dépendances testé.

Alternatives écartées : déplacer le service 4.4B, le convertir en fournisseur NestJS, réécrire sa transaction, exposer le repository privilégié ou créer un moteur générique de quotas. La migration additive `20261117010000_bootstrap_http_limits` crée uniquement `BootstrapBudget` et `BootstrapLease`. Aucune ancienne migration ni aucun trigger d’irréversibilité ne change. Aucune dépendance installée.

## Éligibilité et association persistée

L’amorçage exige un compte à e-mail vérifié, une session active et un appareil non révoqué. Le mot de passe est vérifié hors transaction. Sous verrou de compte, le service revalide session, appareil, adresse, vérificateur exact et sa révision, avec une fenêtre maximale exclusive de cinq minutes incluant l’attente et sans recul d’horloge. Un compte initialisé reste inéligible après perte ou révocation de tous ses appareils. Une preuve de succès, un coffre, une publication ou une autorisation d’origine ambiguë entraîne `HISTORICAL_STATE` sans réparation automatique.

La migration additive `20261115050000_initial_device_bootstrap` relie chaque tentative examinée, y compris les rejets, à son appareil et à son reçu de publication initiale. Les clés étrangères composites et les triggers garantissent même compte, immuabilité et unicité du premier succès. Le statut appartient à `VaultOperation` et l’autorisation à `Device.authorizedAt`. Le service publie le coffre, crée le reçu et autorise le premier appareil dans le même commit. La migration laisse les comptes historiques sans association telle qu’elle les trouve.

L’adresse a déjà été vérifiée à l’inscription. Un attaquant disposant des identifiants avant la première activation peut publier en premier un coffre structurellement valide. L’autorisation serveur ne démontre ni la possession de l’identité E2EE ni la réouverture du coffre. Les règles de récupération des appareils ultérieurs restent distinctes. Le jalon interne 4.4B a observé 135 tests de persistance réussis sur PostgreSQL 18.7.

## Contrat HTTP

Les deux routes privées exigent `Authorization: Bearer s1.<uuid>.<secret>`, une session active et un appareil non révoqué. Aucune annotation `PublicRoute`. `authenticatedSession(request)` restitue le contexte privé établi par le guard : aucune copie du Bearer dans les propriétés de la requête. Le compte V1 doit être celui de cette session ; aucun identifiant d’appareil, de session, ni date d’autorisation client n’est accepté.

`POST /v1/vault/bootstrap` accepte exactement :

```json
{
  "password": "<mot de passe actuel exact>",
  "request": {
    "transportVersion": 1,
    "operationId": "<uuid canonique en minuscules>",
    "account": "<compte de la session>",
    "vaultId": "<identifiant V1>",
    "expectedCredentialRevision": "1",
    "expectedStorageRevision": null,
    "publicationBase64Url": "<publication V1 cliente>"
  },
  "candidateDigest": "<SHA-256 base64url sur les octets exacts>"
}
```

`POST /v1/vault/bootstrap/receipt` accepte la même enveloppe **sans** `password` ; fournir ce champ est une erreur. La requête V1 originale et son digest restent nécessaires. Aucun GET par UUID. La récupération appelle exclusivement `recoverReceipt()`, sans activation de secours.

Les réponses suivent directement `vaultOperationResultSchema`, sans booléen de succès :

| HTTP | Corps                                                                                                                                                             | Sens                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 200  | `{ "transportVersion": 1, "status": "committed", "identity": { ... }, "cas": { "storageRevision": "1", "credentialRevision": "1" }, "publicationDigest": "..." }` | Publication durable ou rejeu exact.                                |
| 200  | `{ "transportVersion": 1, "status": "rejected", "identity": { ... }, "code": "VERSION_CONFLICT" }`                                                                | Rejet métier terminal, sans autorisation.                          |
| 202  | `{ "transportVersion": 1, "status": "unknown" }`                                                                                                                  | Relecture sans résultat durable retrouvé, sans preuve de rollback. |

`identity` contient `account`, `operationId`, `kind: "initial-publication"`, `expectedStorageRevision: null` et `expectedCredentialRevision`. L’empreinte HMAC privée n’est jamais retournée. Les codes métier du repository sont conservés : `INVALID_INPUT`, `INVALID_PUBLICATION`, `ALREADY_EXISTS`, `VERSION_CONFLICT`, `INVALID_TRANSITION`, `IDEMPOTENCY_MISMATCH`.

Nuance héritée : `IDEMPOTENCY_MISMATCH` constate une divergence avec un reçu existant ; il ne crée pas un nouveau rejet durable et ne remplace jamais le reçu original. Conserver les données originales permet d’en retrouver le résultat terminal.

Les erreurs sont uniquement `{ "error": { "code": "..." } }` :

| HTTP      | Code                                           | Cas                                                                                                                        |
| --------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 400       | `BAD_REQUEST`                                  | Enveloppe, publication, digest ou contexte invalides ; query.                                                              |
| 401       | `UNAUTHORIZED`                                 | Bearer invalide, session expirée/révoquée, appareil révoqué, compte différent, mauvais mot de passe ou e-mail non vérifié. |
| 403       | `FORBIDDEN`                                    | Compte non éligible, historique ambigu, opération d’un autre appareil.                                                     |
| 404 / 405 | `NOT_FOUND` / `METHOD_NOT_ALLOWED`             | Chemin non canonique / méthode interdite ; `Allow: POST` sur 405.                                                          |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | Corps excessif / type ou encodage refusé.                                                                                  |
| 429       | `TOO_MANY_REQUESTS`                            | Budget épuisé ou refus local de concurrence du fournisseur de mot de passe, selon sa politique existante.                  |
| 503       | `SERVICE_UNAVAILABLE`                          | Désactivation, saturation des baux, PostgreSQL/cryptographie indisponible ou clé historique absente.                       |
| 503       | `OUTCOME_UNKNOWN`                              | Défaillance autour d’une transaction dont l’issue ne peut être affirmée ; relire le reçu exact.                            |

Les réponses sont `no-store`. Les erreurs ne reflètent ni message du pilote, ni données entrantes, ni secret. Aucune journalisation des requêtes n’est introduite.

## Tailles et validation

Le parseur JSON est limité à **196 608 octets (192 Kio)** uniquement sur ces deux routes. Les autres conservent **8 192 octets**. Il borne les corps déclarés et diffusés, refuse la compression et conserve `application/json`, éventuellement `charset=utf-8`. Queries, méthodes et variantes de chemin sont refusées avant le handler.

Les schémas partagés réutilisent `initialVaultPublicationSchema` et `publicationDigestSchema`. Le mot de passe reprend la représentation de connexion : chaîne Unicode valide non vide, au plus 1 024 octets UTF-8, sans normalisation. Objets stricts à tous les niveaux, UUID canonique, bigint décimal positif, base64url sans padding et bits finaux canoniques sont contrôlés par les schémas existants. Structure cryptographique et digest sont vérifiés par `prepareInitialPublication()`, avant Argon2id. Aucun second parseur cryptographique HTTP.

Le plafond externe V1 est **131 072 octets**, soit **174 763 caractères** base64url. Le test valide cette borne et rejette 131 073 octets. Une enveloppe compacte avec les champs maximaux et un mot de passe de 1 024 caractères nécessitant chacun six caractères d’échappement JSON tient sous 192 Kio. Les représentations JSON inutilement gonflées restent soumises à la limite totale.

Ce plafond externe ne promet pas qu’un coffre canonique valide peut atteindre exactement 131 072 octets : le contenu chiffré est limité à 65 552 octets, son JSON interne à 88 000 octets et chaque enveloppe à 2 048 octets. La fixture HTTP chiffre réellement la charge maximale de **65 536 octets** avec les primitives V1, le profil Argon2id public exact et de l’aléa système ; elle publie et compare les octets stockés. Le candidat artificiel de 131 072 octets passe la borne externe puis échoue structurellement avant Argon2id. Les tests vérifient aussi le corps HTTP exactement à 192 Kio et un octet au-dessus sur chaque route.

## Transaction et reprise

Le guard ne remplace aucune revalidation 4.4B. `activate()` relit la session et vérifie réellement le mot de passe **hors transaction**, puis sous `Account FOR UPDATE` revalide session, appareil, e-mail, PHC exact, révision et fraîcheur strictement inférieure à cinq minutes depuis le début du contrôle. Le recul d’horloge est refusé. Aucun `VerifiedLogin` ni grant artificiel.

Dans la même transaction : recherche du reçu lié à l’appareil, éligibilité irréversible, `executeInTransaction`, reçu durable, autorisation uniquement pour `COMMITTED`, association immuable compte/appareil/opération, puis commit. Un rejet métier durable garde son reçu et son association, sans autorisation. Une faute avant commit annule les écritures de ce chemin ; une faute après commit ne signifie pas annulation. Les tests de panne enveloppent de vraies transactions PostgreSQL.

Un succès interdit tout nouvel amorçage, même après révocation de tous les appareils. L’historique ambigu échoue fermé. Un autre appareil du même compte ne récupère pas l’ancien reçu : chaque login HTTP crée un **nouvel** appareil `pending`. La reconnexion sécurisée à l’appareil d’origine reste un parcours distinct, absent ici.

Après réponse perdue, conserver dans le stockage client approprié l’UUID, le DTO V1, les octets exacts, le digest et la session d’origine. Relire `/receipt` avec une session actuellement valide du même appareil. `unknown` ne prouve pas l’annulation et ne justifie pas de jeter l’opération originale. Le rejeu exact d’activation retrouve le résultat avec le mot de passe actuel vérifié ; il ne crée ni deuxième coffre ni session supplémentaire. La relecture n’exige pas le mot de passe et ne modifie ni coffre, ni reçu, ni association, ni autorisation.

**Écritures HTTP existantes :** le guard avance normalement `Session.lastSeenAt`, et l’admission écrit ses budgets/baux, même en relecture. La session d’origine, son secret et son expiration absolue sont conservés. « Récupération sans création » décrit les écritures d’amorçage, pas une absence totale d’écriture HTTP.

Les associations/reçus ne sont jamais purgés par le module. Leur conservation, ainsi que les identifiants et clés HMAC historiques, est indispensable à l’irréversibilité, à l’idempotence et à la reprise. Aucune suppression ni réaffectation d’UUID n’est introduite.

## Admission et ressources

`PostgresBootstrapLimits` réutilise uniquement `takePostgresBudget`, avec une table fixe ajoutée à son allowlist. Ses clés sont des HMAC séparés par domaine et portée : IP, compte et appareil ne figurent pas en clair dans les budgets. La source est l’adresse du socket ; `trust proxy` reste désactivé.

| Variable                               | Défaut | Bornes       |
| -------------------------------------- | ------ | ------------ |
| `VAULT_BOOTSTRAP_WINDOW_MS`            | 60000  | 1000–3600000 |
| `VAULT_BOOTSTRAP_LEASE_MS`             | 60000  | 10000–120000 |
| `VAULT_BOOTSTRAP_REQUESTS_GLOBALLY`    | 120    | 1–10000      |
| `VAULT_BOOTSTRAP_REQUESTS_PER_SOURCE`  | 20     | 1–1000       |
| `VAULT_BOOTSTRAP_REQUESTS_PER_ACCOUNT` | 10     | 1–100        |
| `VAULT_BOOTSTRAP_REQUESTS_PER_DEVICE`  | 10     | 1–100        |
| `VAULT_BOOTSTRAP_HASHES_PER_WINDOW`    | 20     | 1–120        |
| `VAULT_BOOTSTRAP_CONCURRENCY`          | 2      | 1–2          |

Activation et relecture partagent les quatre budgets de requêtes, ce qui limite aussi les relectures de publications volumineuses. L’activation réserve en plus un budget global de vérifications de mot de passe pour ce domaine ; un candidat invalide ne déclenche pas le KDF. Connexion et inscription gardent leurs budgets indépendants. Le fournisseur natif conserve son plafond local commun de deux KDF serveur par processus.

Le budget global précède toute allocation de clés par source/compte/appareil. La consommation partielle survit au refus d’une portée suivante. Un verrou consultatif PostgreSQL sérialise l’acquisition des baux entre instances. Le bail couvre activation et relecture, avec libération en `finally` et expiration en secours. L’échec de libération ne remplace pas un résultat métier acquis. Nettoyage borné à cent anciennes lignes par table et par admission, sans accès aux reçus métier.

Toutes les instances doivent utiliser les mêmes limites et la même clé stable de quotas. Sa rotation redémarre de fait les compteurs et nécessite une gestion opérationnelle. Les baux expirants **ne garantissent pas de plafond physique strict après suspension prolongée d’un processus**. Le dimensionnement et les admissions cumulées des domaines restent à qualifier avant production. Les quotas ne confèrent aucune éligibilité et ne suppriment aucun reçu durable.

## Configuration et clés

`VAULT_BOOTSTRAP_ENABLED=true` active indépendamment l’amorçage ; absent ou `false`, le service authentifié répond 503. Une autre valeur est refusée. `NODE_ENV=production` interdit l’activation lors de la lecture de configuration ; `AppModule` bloque aussi une activation programmatique en production.

Variables obligatoires lorsque le domaine est activé :

- `VAULT_BOOTSTRAP_QUOTA_KEY` : 32 octets en hexadécimal minuscule, stables entre instances.
- `VAULT_RECEIPT_ACTIVE_KEY_ID` : identifiant actif présent dans le trousseau.
- `VAULT_RECEIPT_KEYS` : tableau JSON de 1 à 32 objets stricts `{ "id": "<identifiant>", "key": "<32 octets hexadécimaux minuscules>" }`. Identifiants uniques, ASCII imprimable de 1 à 128 caractères. Conserver toutes les clés historiques requises.

Les clés de reçus deviennent des `KeyObject` serveur ; aucune génération automatique au démarrage. Elles doivent être indépendantes de la clé de quotas et des clés de connexion/inscription ; leur réutilisation directe est refusée, même pour une clé historique. Les erreurs ne reproduisent pas les valeurs de configuration. L’exploitation devra fournir et sauvegarder ces clés via un gestionnaire de secrets ; les valeurs de fixtures ne sont pas des clés de déploiement.

Pour tourner : ajouter une nouvelle entrée et changer l’identifiant actif, en conservant les anciennes. La relecture utilise l’identifiant enregistré dans le reçu. Retirer une clé encore requise produit 503, jamais une réinitialisation ou un nouveau reçu. Un test HTTP vérifie cette rotation après création réelle du reçu, ainsi que le refus en l’absence de la clé historique.

## Garanties et intégration mobile

Le backend reçoit temporairement mot de passe, Bearer, métadonnées, coffre chiffré client et digest. Il ne reçoit ni clé maîtresse, ni récupération indépendante, ni clé privée E2EE en clair. Aucune identité OpenE2EE n’est générée côté serveur. La dérivation cliente du coffre est distincte de celle du vérificateur ; recevoir le même mot de passe empêche de prétendre que le serveur est incapable par construction de l’exploiter. Les chaînes JavaScript n’offrent pas de garantie d’effacement mémoire.

Structure, contexte, digest et invariants persistés ne prouvent ni authenticité du manifest client, ni déchiffrement, ni possession des clés privées. `authorizedAt` reste une décision serveur. Il n’ouvre ici aucune route de téléchargement, transfert ou ajout d’appareil. Un attaquant détenteur des identifiants peut gagner la première activation. Aucun booléen client n’est présenté comme preuve de sauvegarde de récupération.

Avant intégration mobile : qualifier React Native/Hermes, iOS et appareils physiques ; produire/persister l’identité cliente et son coffre ; stocker sûrement session et données exactes de reprise ; organiser une sauvegarde indépendante réelle de récupération et sa vérification locale ; traiter résultats terminaux et incertains ; qualifier reprise après arrêt et erreurs réseau. SEC-CRYPTO-002 (restauration/transfert) et SEC-CRYPTO-003 (autorisation complète des appareils) restent ouverts.

Avant production : revue critique, qualification SDK/KDF, maîtrise TLS/logs, dimensionnement global, rétention/suppression compatible avec l’irréversibilité, gestion stable et sauvegarde des clés HMAC, garanties d’admission après suspension et audit de sécurité. Ce jalon n’autorise pas le déploiement.

## Qualification et revue

Les suites unitaires couvrent schémas, champs interdits, mots de passe, révisions/UUID/base64url, bornes, configuration, erreurs fixes, routes privées, modules et récupération exclusive. Les échanges HTTP utilisent Nest réel, PostgreSQL 18.7 et la création cliente V1 réelle. Les courses emploient plusieurs connexions ; les barrières exécutent d’abord Argon2id réel. Le test de révocation observe l’attente de verrou PostgreSQL avant de libérer la transaction concurrente.

Les suites historiques restent présentes, notamment les scénarios 4.4B de fraîcheur, changement PHC/révision, historiques, concurrence, rollback et issue inconnue. Les assertions HTTP de conservation excluent seulement `lastSeenAt`, normalement avancé par le guard.

Vérifications finales du 17 novembre 2026, Node 24.22.2 et pnpm 10.34.9 :

| Vérification                           | Résultat                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                            | Réussi dans tous les workspaces ayant une suite.                                                                   |
| `pnpm typecheck`                       | Réussi, tests TypeScript et mobile inclus.                                                                         |
| `pnpm lint`                            | Réussi.                                                                                                            |
| `pnpm format:check`                    | Réussi.                                                                                                            |
| `pnpm -r --if-present build`           | Réussi.                                                                                                            |
| `git diff --check`                     | Réussi.                                                                                                            |
| `prisma:generate` et `prisma:validate` | Client généré et schéma valide.                                                                                    |
| `test:persistence`                     | 172 tests réussis dans les 11 suites historiques sur PostgreSQL 18.7.                                              |
| `test:http`                            | 144 tests réussis dans 6 suites, dont 30 nouveaux tests HTTP d’amorçage ; les 114 tests antérieurs sont conservés. |
| ESM compilé                            | Import de tous les modules, activation/relecture HTTP réelles, sortie silencieuse et arrêt par SIGTERM réussis.    |
| Connexions et schémas                  | Zéro connexion `bunny-talks-http` et zéro schéma `test_*` après les suites ; pools contrôlés à la fermeture.       |

Base dédiée : instance PostgreSQL 18.7 temporaire créée pour ce jalon sur `127.0.0.1:55441`, schémas aléatoires `test_*` exclusivement. Les restrictions réseau ont nécessité une exécution des tests réels hors sandbox. Aucune donnée applicative ni aucun `.env` privé modifié, aucune ancienne migration réécrite.

Premiers passages : fixtures corrigées pour tenir compte du `lastSeenAt` du guard et respecter les contraintes SQL de dates d’expiration. Un premier `pnpm test` a échoué dans `crypto-backup` sans diagnostic détaillé dans la sortie pnpm ; les 116 tests du package seul puis la commande globale ont réussi. Une première suite HTTP complète a trouvé deux connexions encore visibles dans l’assertion immédiate historique de fermeture du pool de connexion ; la relance complète passe et le contrôle PostgreSQL final confirme zéro connexion. Ce contrôle immédiat peut être sensible au délai de disparition des backends ; aucune exigence ni aucun test historique n’a été retiré ou assoupli. Aucun échec final restant.

Fichiers créés :

- `apps/api/src/vault/bootstrap.controller.ts`, `bootstrap-http.service.ts`, `bootstrap-config.ts`, `postgres-bootstrap-limits.ts` et `vault.module.ts`.
- `apps/api/prisma/migrations/20261117010000_bootstrap_http_limits/migration.sql`.
- `packages/validation/src/schemas/vault-bootstrap.schema.ts`.
- `apps/api/tests/http/bootstrap-postgres.test.ts`, `apps/api/tests/support/bootstrap-fixture.ts` et `apps/api/tests/unit/vault/bootstrap-http.test.ts`.
- Le présent document.

Fichiers modifiés :

- `apps/api/src/app.module.ts`, `apps/api/src/config.ts` et `apps/api/prisma/schema.prisma`.
- `apps/api/src/shared/database/postgres-budget.ts` et `apps/api/src/shared/http/http-error-filter.ts`.
- `packages/validation/src/index.ts` et `apps/api/tests/unit/shared/architecture.test.ts`.
- `docs/development/current-milestone.md`.

Attention pendant la revue : dispatch de `/receipt`, absence d’export privilégié, limites propres aux routes, erreurs sans fuite, conservation des clés, séparation des budgets, portée exacte des baux et invariants transactionnels 4.4B inchangés.

Commit proposé après revue : `feat(api): expose authenticated initial vault bootstrap and receipt recovery`.
