# Jalon 4.4C1 bis — Harmonisation architecturale

État local pour revue critique, le 16 novembre 2026. Aucun commit créé ; 4.4C2 n’est pas commencé. Ce jalon conserve les opérations existantes et prépare leur composition, sans endpoint métier supplémentaire.

## Audit initial du monorepo

L’audit précède les déplacements. Le dépôt était propre, au commit `8967823` de la fondation HTTP. Les sources, imports, manifests, tests et sorties compilées ont été inventoriés avant modification.

| Périmètre                 | Responsabilités constatées                                                                                                                                               | Décision                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                | 26 sources : primitives de mot de passe, inscription e-mail, sessions/appareils, réauthentification, coffre, premier amorçage et 11 fichiers HTTP ; 21 fichiers de tests | Regrouper les domaines et séparer les suites ; conserver les compositions transactionnelles                                     |
| `apps/mobile`             | 13 sources, entrée Expo et configuration Metro ; diagnostics SDK/coffre, aléa, coordination Argon2id et témoins de reprise ; 6 fichiers de tests                         | Conserver le code et les tests ; corriger le statut documentaire de répertoire vide                                             |
| `packages/contracts`      | Types de publication, transitions/reçus et révisions, sans dépendance d’exécution                                                                                        | Aucun déplacement ni changement d’export                                                                                        |
| `packages/validation`     | Schémas Zod d’e-mail et de publication                                                                                                                                   | Conserver leur indépendance de Nest/Express/Prisma                                                                              |
| `packages/crypto/core`    | Identifiants, descripteurs, fabrique d’identité et erreurs sans SDK                                                                                                      | Aucun changement                                                                                                                |
| `packages/crypto/engine`  | Validation et import de l’identité via les API publiques du SDK ; qualifications Node et fixtures relay/SQLCipher                                                        | Aucun changement ; SDK toujours expérimental                                                                                    |
| `packages/crypto/backup`  | Enveloppes, coffre authentifié, KDF explicite, transitions pures et entrée expérimentale                                                                                 | Aucun changement des formats, primitives, exports ou vecteurs                                                                   |
| Configurations et scripts | TypeScript strict commun ; NodeNext pour l’API/packages, Bundler pour Expo ; tri des imports ESLint ; suites Vitest explicites                                           | Conserver les tsconfig ; remplacer les longues listes API par des répertoires de suites disjoints et vérifier leur exhaustivité |
| Documentation             | Architecture Clean, décisions d’identité et de récupération, modèle de menaces, rapports des jalons et qualifications mobiles                                            | Clarifier les responsabilités, les statuts réels et les limites sans réécrire l’historique                                      |

Arborescence initiale :

```text
apps/api/
├── src/
│   ├── password-verifier.ts, registration-policy.ts, session-*.ts
│   ├── reauthentication-intent.ts, initial-bootstrap-error.ts
│   ├── postgres-{email-registration,session-repository,reauthentication,
│   │             initial-device-bootstrap,vault-repository}.ts
│   ├── publication-digest.ts, vault-{request-fingerprint,repository-error}.ts
│   └── http/                    # 11 fichiers ; sessions et infrastructure mélangées
├── tests/                       # unitaires, PostgreSQL et HTTP au même niveau
├── generated/prisma/
└── prisma/
```

Problèmes concrets :

- Le fournisseur `Database` est créé et exporté par `SessionModule`, et dépend de `HttpConfig` : un futur consommateur PostgreSQL devrait dépendre des sessions ou du transport.
- Le service de session construit lui-même son repository depuis `Database`, alors que ses besoins se limitent à deux opérations.
- `noInputPolicy` est globale et contient une table de chemins : les futures routes avec corps ne peuvent pas être composées indépendamment.
- La racine `src` juxtapose les domaines ; la racine `tests` mélange les qualifications. Les scripts énumèrent manuellement les fichiers.
- La règle pure de durée de session importe le type Prisma `Session` ; l’intention pure de réauthentification importe son type de préparation depuis le repository de coffre.
- `tsc` conserve les anciens fichiers émis après un déplacement.
- L’arbre documentaire décrit encore `apps/mobile` comme vide malgré la fondation Expo et les qualifications Android existantes.

Aucun cycle d’import local n’est trouvé dans l’inventaire initial, types compris. Le test architectural ajouté contrôle ensuite les sources API, mobile et packages, y compris les dépendances via leurs points d’entrée.

## Organisation retenue et déplacements

La structure complète et ses conventions sont décrites dans l’[architecture de référence](../architecture/architecture-overview.md#53-organisation-effective-et-composition-nestjs).

| Ancien emplacement, relatif à `apps/api/src`                                                                         | Emplacement retenu            | Motif                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `password-verifier.ts`                                                                                               | `auth/password-verifier.ts`   | Primitive d’authentification partagée ; pas de dossier pour un seul fichier |
| `registration-policy.ts`, `postgres-email-registration.ts`                                                           | `auth/registration/`          | Politique d’inscription et identité e-mail vérifiée                         |
| `session-token.ts`, `session-lifecycle.ts`, `session-authentication.ts`, `postgres-session-repository.ts`            | `auth/sessions/`              | Jetons, durée de vie, validation sous transaction, sessions/appareils       |
| `http/session.controller.ts`, `session-http.service.ts`, `session.guard.ts`, `session.module.ts`                     | `auth/sessions/`              | Transport et composition de la même capacité fonctionnelle                  |
| `reauthentication-intent.ts`, `postgres-reauthentication.ts`                                                         | `auth/reauthentication/`      | Intention et orchestration transactionnelle des grants                      |
| `initial-bootstrap-error.ts`, `postgres-initial-device-bootstrap.ts`                                                 | `auth/bootstrap/`             | Première autorisation et publication atomiques                              |
| `postgres-vault-repository.ts`, `publication-digest.ts`, `vault-request-fingerprint.ts`, `vault-repository-error.ts` | `vault/`                      | Coffre, persistance, idempotence et erreurs                                 |
| `http/database.ts`                                                                                                   | `shared/database/database.ts` | Infrastructure PostgreSQL sans propriétaire fonctionnel                     |
| `http/http-policy.ts`, `http/http-error-filter.ts`                                                                   | `shared/http/`                | Politiques et traduction des erreurs du transport                           |
| `http/app.module.ts`, `application.ts`, `config.ts`, `main.ts`                                                       | Racine de `src`               | Composition et démarrage de l’application                                   |

Les imports relatifs et les URL de fixtures/migrations ont été adaptés, y compris les chemins interpolés des migrations historiques. Les noms des fichiers de test sont conservés. Aucun barrel backend n’est créé. Le client généré, le schéma et les six migrations restent à leurs emplacements existants.

Fichiers supplémentaires avec responsabilité effective :

- `shared/database/database.module.ts` : propriété et export du fournisseur PostgreSQL.
- `shared/http/http-transport.ts` : configuration globale utilisée par l’application et sa qualification HTTP.
- `shared/http/http-input.guard.ts` : refus d’un handler sans politique d’entrée appliquée.
- `vault/prepared-password-change.ts` : type de préparation partagé, indépendant du repository.
- `build.mjs` : nettoyage du seul répertoire de sortie API puis compilation TypeScript.
- `tests/unit/shared/architecture.test.ts` : frontières, cycles, composition et exhaustivité des suites.
- `tests/support/http-input-fixture.ts` : routes de qualification JSON, jamais émises ni montées par l’application livrée.
- `tests/http/compiled-esm.test.mjs` : correspondance sources/sorties et imports par Node ESM réel.
- Ce rapport. Les documents d’architecture, jalon courant et introduction du rapport HTTP historique sont actualisés.

Les autres modifications concernent `apps/api/package.json`, `server.mjs` et le lockfile. Le seul ajout au graphe de dépendances déclaré est `express: 5.3.0`, déjà installé transitivement par Nest, pour importer son parseur public. Installation hors ligne, scripts d’installation désactivés ; aucune version existante n’est changée. Le diff du lockfile se limite aux trois lignes de l’importer API.

## Graphes avant et après

Le graphe des workspaces reste identique :

```text
api ───────────> contracts, validation, crypto-backup
mobile ────────> crypto-engine, crypto-backup
crypto-engine ─> crypto-core
```

`validation` dépend de Zod ; `crypto-engine` du SDK et de Noble ; `crypto-backup` de Noble et des bibliothèques de sérialisation. `contracts` et `crypto-core` n’ont aucune dépendance extérieure d’exécution. Les diagnostics mobiles importent également directement le SDK et des vecteurs JSON de qualification ; cette exception expérimentale existante n’est pas étendue.

Avant, composition HTTP :

```text
application -> AppModule -> SessionModule -> Database -> PrismaPg/pool
                            ├─ export Database
                            ├─ fournit SessionHttpService -> construit PostgresSessionRepository
                            └─ enregistre SessionGuard global
application -> parseur JSON et noInputPolicy globaux -> table de chemins
```

Après :

```text
application -> AppModule -> DatabaseModule -> Database -> PrismaPg/pool
                 ├────────> SessionModule -- importe la même instance DatabaseModule
                 │              ├─ factory -> repository -> capacité étroite de session
                 │              └─ SessionController -> SessionHttpService
                 └─ guards globaux : HttpInputGuard puis SessionGuard

politiques globales -> middleware d’entrée du module/chemin -> guards -> handler/pipes
```

Dépendances fonctionnelles conservées : `bootstrap` et `reauthentication` orchestrent `sessions`, `password-verifier` et `vault`. `registration` réutilise les jetons opaques et le vérificateur. `vault` ne dépend pas d’`auth`. Le filtre transversal de présentation traduit `SessionError`, sans accès au repository. Les modules fonctionnels importent `shared/database` ; cette infrastructure n’importe plus la configuration HTTP.

## Frontières et abstractions

Les contrôleurs n’importent ni Prisma, ni la base, ni les repositories privilégiés. `SessionHttpService` reçoit un `Pick<PostgresSessionRepository, 'validate' | 'revokeCurrent'>` : les objets injectés en test ou en composition n’ont besoin que de ces capacités. Aucune interface artificielle de repository n’est ajoutée.

Les règles pures ne deviennent pas des services Nest. Le type structurel local `SessionLifetime` retire la dépendance Prisma sans changer le prédicat d’expiration. `PreparedPasswordChange` est extrait pour que l’intention pure de réauthentification ne dépende plus d’un fichier d’infrastructure ; il reste réexporté depuis le repository pour conserver ce contrat interne. Les ports existants d’e-mail et de liste de compromission restent justifiés par leurs dépendances extérieures.

Les classes transactionnelles existantes combinent toujours orchestration et persistance. Leurs préconditions, verrous, limites, transactions, HMAC, reçus et traitements d’issue inconnue ne sont pas réécrits. Elles constituent des compositions applicatives PostgreSQL, pas un domaine prétendument indépendant.

Alternatives écartées : quatre couches matérialisées dans chaque domaine, interface systématique devant chaque classe, module Nest d’inscription/coffre encore inutilisé, module de base global ou import de sessions uniquement pour obtenir Prisma, registre maison de routes et validation Zod réimplémentée. Elles ajouteraient des responsabilités artificielles ou masqueraient les dépendances.

## PostgreSQL : propriétaire et arrêt

`AppModule.register` crée une seule instance dynamique de `DatabaseModule.register(databaseUrl)`, l’importe et la transmet à `SessionModule.register`. Un futur module consommateur recevra cette même instance depuis la composition racine. Il ne doit pas rappeler la factory de base ni créer de client dans un contrôleur.

`Database` reste propriétaire du client Prisma et de l’adaptateur possédant le pool. Les limites et options PostgreSQL sont conservées. `onModuleDestroy` ferme le client, donc le pool. L’infrastructure reçoit désormais l’URL seule et ne dépend plus de `HttpConfig`. Aucun singleton de base global ni module `@Global`.

Les tests réels vérifient un seul fournisseur `Database` dans le conteneur, sa propriété par `DatabaseModule`, l’absence de propriété dans `SessionModule`, un seul appel à `$disconnect` lors de la fermeture et aucune connexion restante. L’échec de connexion initial ferme toujours l’application ; SIGTERM arrête aussi le serveur compilé.

## Politiques HTTP extensibles

Le pipeline global conserve les en-têtes sûrs, le refus des doublons de contenu/framing et de plus de 64 en-têtes, les timeouts, l’absence de cache/ETag/CORS, `trust proxy: false` et les erreurs assainies. Le parser automatique Nest reste désactivé.

Les modules composent, avec `MiddlewareConsumer.forRoutes`, le parseur JSON borné `jsonBodyPolicy` et la politique sans corps/query `noInputPolicy`. Cette composition s’applique aussi aux méthodes non prévues pour préserver les statuts avant authentification : JSON invalide/sélecteur → `400`, contenu non pris en charge → `415`, trop volumineux → `413`, méthode canonique non prévue → `405` et `Allow`. Les routes actuelles gardent 8 192 octets, sans décompression, y compris en chunked.

`HttpInputGuard` exige qu’un middleware d’entrée ait accepté la requête via `acceptHttpInput`. Sans ce passage, un handler retourne une erreur serveur assainie `500`, même s’il est public ou si un parseur seul a été appliqué. Le marqueur est conservé dans un `WeakSet<Request>`, sans identifiant ni secret ajouté à la requête. Il ne constitue ni une authentification, ni une preuve de validation de schéma. Chaque nouvelle route avec données doit composer son contrôle de query/méthodes et utiliser un schéma adapté ; les pipes Nest natifs effectuent cette validation. Le test de qualification utilise directement `StandardSchemaValidationPipe` et un schéma Zod partagé. Aucun moteur de validation ou registre de routes supplémentaire.

La fixture démontre qu’une route avec JSON valide peut accepter plus de 8 Kio avec une limite locale de 16 Kio, refuser les mauvaises structures/e-mails, les queries et les dépassements déclarés ou chunked, tout en conservant les limites des deux chemins existants. Elle n’appartient pas au build livré. Les futures tailles de publication E2EE ne sont pas décidées ici.

### Écart de routage préexistant découvert

La configuration d’Express ne suffit pas à démontrer les propriétés du routeur créé par l’adaptateur Nest. La comparaison du build initial et du build harmonisé montre que 4.4C1 accepte déjà `/health/live/`, `/Health/live`, `/v1/session/` et `/V1/session` ; leurs méthodes ne passent pas par la table canonique initiale. Sur les variantes de liveness, HEAD retourne déjà `200`, tandis que POST/OPTIONS retournent `404`. Les variantes de session restent authentifiées ; leurs GET/HEAD nécessitent le Bearer, et DELETE révoque la session courante.

Ces résultats sont conservés et couverts, sans transformer silencieusement les `404`/HEAD existants en `405`. Le contrôle explicite des méthodes de `noInputPolicy` est donc limité au chemin canonique fourni par le module. Un durcissement du routage serait un changement observable distinct, soumis à revue. Les chemins canoniques conservent le refus HEAD/OPTIONS décrit en 4.4C1. La politique proxy reste indépendante de cet écart.

Les chemins inconnus ne reçoivent plus le parseur ni le refus d’entrée global : ils retournent `404` sans que leur JSON soit décodé. C’est l’ajustement nécessaire à la composition par route ; il ne rend aucun handler accessible et ne modifie pas les résultats des routes existantes.

## Tests et couverture conservée

| Suite API          | Avant                 | Après                  | Contenu                                                                                              |
| ------------------ | --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Rapide `pnpm test` | 11 fichiers, 98 tests | 12 fichiers, 104 tests | `tests/unit/{auth,vault,shared}` ; ajoute six contrôles architecturaux                               |
| `test:persistence` | 9 fichiers, 136 tests | 9 fichiers, 136 tests  | `tests/persistence/{auth,vault,shared}` ; mêmes migrations, contraintes, courses, rollbacks et reçus |
| `test:http`        | 1 fichier, 37 tests   | 2 fichiers, 43 tests   | HTTP réel, JSON de qualification, compatibilité des alias, composition et imports ESM                |

Les 21 fichiers de test initiaux sont retrouvés dans leur suite. Les deux nouveaux fichiers sont le test architectural et la qualification ESM ; la suite HTTP existante est étendue. Le test d’affectation échoue si un fichier API ne correspond à aucune suite ou à plusieurs. Les tests des packages, vecteurs Python, fixtures relay et six fichiers de tests mobiles restent à leurs emplacements et sont toujours exécutés par les scripts existants.

Les fixtures PostgreSQL conservent leurs garde-fous : base dédiée locale, schémas aléatoires, version 18.7 vérifiée par le support partagé et les qualifications historiques qui l’exigeaient, suppression uniquement des schémas créés. Les fixtures JSON sont réutilisées directement, sans copie.

## Vérifications exécutées

Les résultats définitifs et la comparaison des artefacts sont consignés ci-dessous.

| Vérification                          | Résultat                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                           | Réussi dans tous les workspaces concernés, y compris les tests mobiles existants et les 104 tests rapides API                                                                                 |
| `pnpm typecheck`                      | Réussi, API, tests, packages et mobile                                                                                                                                                        |
| `pnpm lint`                           | Réussi                                                                                                                                                                                        |
| `pnpm format:check`                   | Réussi                                                                                                                                                                                        |
| `pnpm -r --if-present build`          | Réussi ; 30 modules API et 30 déclarations sous `dist/src`, client sous `dist/generated/prisma`, aucun test émis                                                                              |
| `prisma:validate` / `prisma:generate` | Réussis, Prisma 7.10.1, client généré au même emplacement                                                                                                                                     |
| `test:persistence`                    | 9 fichiers, 136 tests réussis sur PostgreSQL 18.7 réel                                                                                                                                        |
| `test:http`                           | 2 fichiers, 43 tests réussis ; HTTP réel, imports Node ESM de tous les modules, démarrage compilé, SIGTERM et fermeture                                                                       |
| Comparaison HTTP avant/après          | 244/244 réponses identiques : statuts, corps, `Allow`, cache et en-têtes de sécurité ; chemins canoniques et variantes, méthodes, query, JSON, MIME, compression et tailles déclarées/chunked |
| Comparaison sources/exports/sorties   | Exports des manifests inchangés ; 50 fichiers compilés des packages et 34 fichiers compilés du client généré identiques au build initial                                                      |
| `git diff --check`                    | Réussi                                                                                                                                                                                        |

Les 15 modules initiaux hors `http` ont également été comparés par syntaxe TypeScript : 14 conservent les mêmes déclarations après exclusion des imports/réexports et du type extrait. Le quinzième est `session-lifecycle` : seul son type d’entrée devient structurel ; le prédicat d’expiration reste identique et ses tests de bornes passent. Cela complète les suites transactionnelles sans prétendre constituer une preuve formelle d’équivalence.

Les exports des packages restent strictement inchangés. L’API est une application privée sans entrée publique de package : ses chemins internes et constructeurs de composition évoluent avec tous leurs consommateurs du dépôt. Les DTO, routes canoniques, formats de jeton et interfaces de publication restent identiques. Le réexport de `PreparedPasswordChange` est conservé. Les sorties API obsolètes sont retirées par le build propre ; le test ESM exige la correspondance exacte entre sources actuelles et fichiers `.js`/`.d.ts`.

L’installation PostgreSQL 18.7 temporaire du jalon précédent a été réutilisée sous `/tmp`, sur `127.0.0.1:55439`, uniquement avec `bunny_talks_test`. Le sandbox a d’abord refusé la socket TCP ; les suites réelles ont ensuite été exécutées avec l’autorisation automatique nécessaire. Un contrôle SQL indépendant après les suites et comparaisons constate **zéro schéma de test et zéro autre connexion** dans cette base. L’instance temporaire a ensuite été arrêtée proprement.

Les premiers tests ajoutés ont révélé des erreurs de fixture corrigées : query vide supprimée par le client HTTP, sélection d’un module dynamique Nest par sa classe seule, e-mails de qualification dépassant les bornes du schéma. Le test supplémentaire de routage a ensuite exposé une hypothèse incorrecte sur les réglages Express ; la comparaison avec le build initial a conduit à conserver et caractériser le comportement effectivement existant. Aucun test de sécurité n’a été relâché pour contourner un échec.

Les 24 fichiers mobiles, les fichiers des cinq packages et les neuf fichiers Prisma inventoriés sont inchangés par comparaison d’empreintes. Le fichier `.env` privé inventorié est également inchangé, sans publication de son contenu. Les seules données PostgreSQL écrites par les suites sont leurs schémas éphémères de qualification.

## Risques, limites et décisions différées

- Le routage des variantes de casse/slash et HEAD est un écart préexistant entre l’intention de configuration et le comportement réel. Le durcir nécessite une décision séparée et des tests de compatibilité ; il n’est pas corrigé implicitement ici.
- `acceptHttpInput` atteste le passage d’une politique de transport, pas l’existence d’un schéma : la revue des nouvelles routes doit vérifier leurs paramètres et pipes. Le refus par défaut protège contre un oubli de composition, sans remplacer cette revue.
- Les tailles des publications E2EE, l’anti-bruteforce, les quotas, les budgets Argon2id et la politique de reverse proxy/TLS restent à traiter dans leurs jalons approuvés.
- Les tests mobiles existants passent sous Node/Vitest. Aucun nouveau passage instrumenté sur émulateur ou appareil Android/iOS n’a été exécuté dans ce jalon structurel ; les limites de qualification natives précédentes restent valables.
- SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. Aucun format cryptographique, secret de récupération, protocole d’archive ou mécanisme d’autorisation n’est modifié.
- Aucun module Nest d’inscription, de coffre ou de messagerie n’est créé. Aucun endpoint 4.4C2 n’est commencé.

## Revue attendue

Examiner particulièrement :

1. La réutilisation de la même instance dynamique de `DatabaseModule` et la fermeture unique de son fournisseur.
2. L’ordre middleware de parsing/politique, `HttpInputGuard`, `SessionGuard`, puis pipes/handler ; la portée réelle du marqueur d’entrée et la conservation des erreurs avant authentification.
3. Le traitement explicite des méthodes canoniques et la caractérisation des alias historiques.
4. La capacité étroite injectée dans `SessionHttpService`, le type de durée indépendant de Prisma et le type partagé de préparation.
5. Les chemins de fixtures et migrations, l’exhaustivité des suites et le nettoyage des anciennes sorties ESM.

Les déplacements restent non commités pour la revue humaine. Message recommandé :

```text
refactor(api): organize domains and share database and HTTP composition
```

Attendre la revue critique avant toute suite.
