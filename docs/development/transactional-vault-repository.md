# Repository transactionnel du coffre — jalon 4.2B

Statut historique : jalon terminé et commité (`90d8507`). Cette page décrit 4.2B ; les sessions et la réauthentification sont depuis livrées. L’[amorçage 4.4B](initial-device-bootstrap.md) compose désormais cette primitive interne, sans endpoint HTTP. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants avant production.

## Audit et structure

La [fondation 4.2A](postgresql-prisma-foundation.md) est réutilisée sans migration. `Account` existe avant le coffre et fournit le verrou stable ; `PasswordCredential` porte le vérificateur et sa révision ; `VaultState` référence une publication du même compte et coffre par clé étrangère composite ; `VaultPublication` conserve les octets et compteurs ; `VaultOperation` possède une clé primaire `(accountId, operationId)` et les deux seuls états terminaux `COMMITTED` et `REJECTED`. Les contraintes SQL complètent Prisma : formats, bornes, tailles, cohérence des états et suppressions restreintes.

`apps/api/src/postgres-vault-repository.ts` est un adaptateur d'infrastructure TypeScript sans NestJS. Il utilise les contrats et schémas de 4.1 ainsi que les API publiques `validateAccountVault`, `evaluateInitialVaultPublication` et `evaluatePasswordVaultTransition` de `crypto-backup`. Le parseur V1 n'est pas dupliqué. `crypto-core` et les formats cryptographiques restent inchangés.

Les fichiers `vault-request-fingerprint.ts` et `vault-repository-error.ts` isolent l'identité protégée et les erreurs expurgées. Les dépendances ajoutées sont uniquement trois liens de workspace. `rootDir` de l'API devient `.` pour compiler ensemble `src` et le client Prisma généré sous `generated/prisma` : les sorties sont désormais `dist/src` et `dist/generated/prisma`. Aucun point d'entrée public de package n'existait dans cette application privée. Le tsconfig des tests autorise l'import du chargeur `.mjs` existant sans désactiver le typage strict TypeScript.

## API interne et préconditions de sécurité

| Méthode                                    | Entrées et résultat                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `readActive(account)`                      | État de transport V1 ou `null` si le compte existant n'a pas de coffre.                                                     |
| `publishInitial(request, candidateDigest)` | DTO `InitialVaultPublication`, digest annoncé à comparer au SHA-256 recalculé ; reçu terminal.                              |
| `rewrapPassword(request, prepared)`        | DTO `OrdinaryPasswordChange`, nouveau vérificateur opaque, digest et génération de départ, digest candidat ; reçu terminal. |
| `getOperation(account, operationId)`       | Résultat durable public, sans empreinte ni vérificateur ; absence de reçu : `unknown`.                                      |

Le rejeu est classifié lors des mutations : même identité protégée, restitution du reçu ; identité différente, `IDEMPOTENCY_MISMATCH` sans modifier le reçu original. Le helper pur `classifyVaultOperationReplay` de 4.1 utilise une égalité de chaînes ; l'adaptateur effectue donc la comparaison HMAC avec `timingSafeEqual` de Node et vérifie les champs publics d'identité. Les autres validations réutilisent les schémas et fonctions existants.

Les comptes et leurs identifiants doivent préexister. Leur absence produit `ACCOUNT_NOT_FOUND` ou `CREDENTIAL_NOT_FOUND`, sans fabriquer de compte ni de reçu. Le repository borne le vérificateur préparé à 1–4096 caractères, mais n'en prouve ni la provenance ni les paramètres Argon2id. Le service d'authentification devra préparer un véritable vérificateur conforme, vérifier l'ancien mot de passe, les preuves de réauthentification et l'autorisation du demandeur. L'activation initiale exigera aussi le compte authentifié, l'e-mail vérifié et la capacité d'amorçage appropriée. Aucun booléen d'autorisation fictive n'est utilisé.

La révision d'authentification décrit le vérificateur serveur courant ; `envelopeCredentialRevision` identifie la révision à laquelle l'enveloppe mot de passe active a été associée. Après une réinitialisation par e-mail, la première peut avancer sans réenveloppement : la lecture retourne alors les deux valeurs distinctes et les octets exacts du coffre. Cet état cohérent nécessite une réparation future par récupération ou appareil fiable. Une enveloppe en avance sur la révision d'authentification est incohérente et produit `CORRUPT_STORAGE`. Le changement ordinaire exige des révisions égales et enregistre un `VERSION_CONFLICT` durable si l'enveloppe est ancienne, sans modifier vérificateur, publication, appareils ou sessions. Aucun service de réinitialisation ou de réparation n'est implémenté ; le serveur ne valide pas cryptographiquement le manifest.

Ces préconditions restent obligatoires pour les lectures, reçus et rejouements, y compris après consommation éventuelle d'une preuve. Cette primitive interne n'est pas un changement de mot de passe sécurisé accessible aux utilisateurs. Les appareils et sessions ne sont jamais modifiés.

## Clés et empreinte HMAC

Le constructeur exige une dépendance `VaultFingerprintKeys` avec `activeKeyId` et `getKey(keyId)`. Une seule clé est active dans ce jalon. Le résolveur synchrone doit lire des clés déjà chargées en mémoire, sans réseau. L'appelant fournit un `KeyObject` symétrique Node issu d'au moins 32 octets générés cryptographiquement, indépendants des clés de coffre, sessions, mots de passe et autres usages. La taille minimale est vérifiée ; l'entropie et l'indépendance restent des responsabilités du déploiement. Aucun secret, repli ou clé de test ne figure dans le code de production ni dans PostgreSQL. Les tests génèrent leurs clés avec `randomBytes(32)`.

L'empreinte HMAC-SHA-256 est calculée avec `node:crypto`, puis stockée sur 32 octets avec son `keyId`. Son entrée UTF-8 est un tableau JSON à positions fixes :

1. Domaine versionné `bunny-talks/vault-repository/request/v1`, identifiant de clé.
2. Version de transport, type d'opération, compte, identifiant d'opération, `vaultId`.
3. Révision de stockage attendue ou `null`, révision d'authentification attendue.
4. Publication Base64url canonique exacte et digest candidat recalculé.
5. Digest et génération de départ, nouveau vérificateur préparé ; `null` pour ces trois champs lors de l'activation initiale.

Les limites et schémas sont appliqués avant le calcul. Les chaînes échappées JSON, nombres sûrs et `null` évitent les ambiguïtés de concaténation. Les empreintes de longueur valide sont comparées avec `timingSafeEqual`. L'ancien vérificateur n'entre pas dans l'empreinte ; aucun vérificateur ni mot de passe n'est conservé dans un reçu. Le SHA-256 public ne porte que sur la publication chiffrée, jamais sur un mot de passe.

Au rejeu, l'empreinte est recalculée avec la clé désignée par le reçu, même si la clé active a changé. Une clé absente, courte ou une erreur du fournisseur entraîne `KEY_UNAVAILABLE` sans réexécution ; la consultation du reçu échoue également si cette clé manque. L'interface permet ultérieurement de résoudre les anciennes clés, mais aucune rotation automatique ni infrastructure de secrets n'est implémentée.

### Frontière avec la future couche HTTP

L'identité du repository lie les **données préparées exactes**, dont le vérificateur salé. Régénérer un vérificateur Argon2id avec un sel différent change donc cette identité. Cette garantie interne ne constitue pas la politique d'idempotence HTTP.

Avant tout futur endpoint, la couche applicative devra calculer une empreinte protégée de l'identité stable de la demande **avant** de générer le vérificateur aléatoire, puis organiser la reprise des données préparées exactes ou la restitution authentifiée d'un résultat déjà enregistré. Il faudra concevoir la liaison durable entre cette identité HTTP et l'opération interne, ainsi que la reprise après panne pendant la préparation. Il ne suffira pas de relancer Argon2id et d'invoquer aveuglément `rewrapPassword`, ni de restituer un reçu sur la seule connaissance d'un UUID. Aucun contrat public de 4.1 n'est modifié et aucune politique ne rend obligatoire une nouvelle identité HTTP au rejeu.

## Ordre transactionnel et CAS

Hors transaction : validation stricte du DTO, copie des données préparées, décodage borné, recalcul et comparaison du digest, contrôle structurel V1, calcul HMAC de la requête active. Aucun KDF n'est exécuté dans ce repository.

Dans une transaction interactive Prisma, en isolation PostgreSQL `ReadCommitted` :

1. Définir localement `lock_timeout` et `statement_timeout` avec `set_config` paramétré.
2. Verrouiller l'unique ligne `Account` par `SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE`.
3. Lire le reçu avant toute réapplication des préconditions mutables. S'il existe, comparer l'identité et restituer ou signaler la divergence, sans nouvelle écriture.
4. Lire le vérificateur courant et l'état actif. Pour un réenveloppement, contrôler les octets, digest, compteurs et liaison de révision d'authentification stockés ; une corruption produit une erreur de stockage non terminale.
5. Appliquer les règles pures de 4.1. L'activation initiale exige absence de coffre, révision d'authentification attendue et quatre compteurs initiaux à 1. Le réenveloppement compare compte/coffre, stockage, authentification, digest de départ et génération ; il conserve exactement contenu chiffré et enveloppe récupération et progresse de 1 en génération et révision mot de passe. Les débordements sont refusés.
6. Pour le réenveloppement seulement, remplacer le vérificateur et incrémenter sa révision. Insérer la publication avec ses octets exacts, son digest recalculé, ses compteurs et sa révision d'authentification associée. Créer ou déplacer la référence active et avancer la révision de stockage (1 pour l'activation initiale).
7. Insérer le reçu terminal avec les révisions et digest résultants ou un code de rejet métier. Retourner normalement pour conserver aussi les rejets, puis committer l'ensemble.

Chaque opération ne verrouille qu'un compte, toujours avant ses autres lignes : l'ordre est déterministe. Le verrou est conservé jusqu'au commit ou rollback et existe avant toute publication. Les lectures d'état et de reçu utilisent le même verrou pour éviter une lecture incohérente entre référence active et identifiants. Deux comptes distincts ne partagent pas ce verrou. Les futurs écrivains sensibles du même compte devront suivre ce protocole, notamment l'authentification, la récupération et la révocation ; une écriture SQL directe qui l'ignore n'est pas couverte par le CAS applicatif.

Le client injecté doit viser le même schéma pour l'adaptateur Prisma et le `search_path` des requêtes SQL brutes ; la configuration normale utilise `public`, les tests règlent les deux explicitement. Aucun identifiant fourni par un demandeur n'est interpolé en SQL. Les lectures vérifient aussi la cohérence structurelle et le SHA-256 des octets stockés, sans authentifier le manifest.

## Timeouts, erreurs et reprise

Valeurs explicites par défaut : attente d'acquisition d'une transaction Prisma 2000 ms, durée interactive 5000 ms, attente de verrou PostgreSQL 1000 ms, instruction PostgreSQL 3000 ms. Les options injectables doivent être des entiers positifs avec `lockTimeoutMs < statementTimeoutMs < timeoutMs`. Aucun retry automatique n'est effectué, y compris après deadlock ou conflit de connexion.

Une entrée ou publication malformée est rejetée avant transaction avec une erreur fixe `INVALID_INPUT` ou `INVALID_PUBLICATION`, sans reçu. Les conflits métier valides produisent un `REJECTED` durable. Une incohérence des données stockées produit `CORRUPT_STORAGE`, sans reçu terminal. Les erreurs Prisma, SQL, connexion et commit sont expurgées sous `TRANSACTION_OUTCOME_UNKNOWN`, sans exposer paramètres, vérificateurs ou erreurs du pilote. La configuration du client et de l'infrastructure doit également empêcher la journalisation des paramètres sensibles.

Cette dernière erreur ne prouve **jamais** l'annulation. Après un résultat incertain, conserver compte, UUID, publication et préparation exacts, puis consulter le reçu ou rejouer après rétablissement de la connexion. `COMMITTED` prouve le succès durable dans PostgreSQL ; `REJECTED` indique le rejet enregistré ; absence de reçu indique une opération encore inconnue lors de cette lecture. Un rejeu sérialisé avec le même UUID permet de terminer sans double mutation, y compris si une première transaction était encore en cours. Ne pas inventer un nouvel UUID ni annoncer un rollback à partir du seul timeout.

## Rétention et limites avant production

Conserver les anciennes clés aussi longtemps que des reçus en dépendent ; perdre la clé provoque une indisponibilité fermée de ces rejouements. Ne pas réaffecter un `keyId` à une autre clé. La disponibilité, la sauvegarde, les accès, le provisionnement et la rotation opérationnelle des secrets restent à concevoir.

Les reçus assurent la mémoire des opérations ; les anciennes publications conservent des données chiffrées historiques. Le reçu de succès contient son digest et ses révisions, sans dépendance à une ancienne publication : le rejeu peut donc restituer un succès historique même si l'état actif a avancé. Leur rétention n'a pas le même objectif. Aucune purge n'est livrée. Supprimer prématurément un reçu ferait perdre l'identité et le résultat d'une opération et pourrait permettre son réexamen ou sa réexécution après évolution de l'état.

Une future politique de tombstones devra préserver la liaison compte/UUID/identité protégée et l'issue requise, définir durées, sauvegardes, clés et comportement après expiration, et empêcher la réutilisation silencieuse des identifiants. Elle ne se déduit pas de la purge des publications et reste distincte des tombstones de suppression des messages et archives. Aucune suppression de compte ni rétention réglementaire n'est définie ici.

La validation serveur est structurelle : pas de vérification du manifest HMAC client, du mot de passe ou de l'autorisation. Elle ne protège pas contre un serveur malveillant qui présente un ancien état. Le parcours HTTP, les preuves, la limitation d'abus, l'audit de sécurité, la fraîcheur indépendante, les pannes physiques et la haute disponibilité restent à qualifier. Les anciennes publications peuvent rester déchiffrables avec un ancien mot de passe si elles ont été copiées ; un changement ordinaire ne révoque pas ces copies.

## Qualification PostgreSQL

Le 15 novembre 2026, les tests ont été exécutés sur une nouvelle instance PostgreSQL **18.7 réelle** temporaire, compilée au jalon précédent, sans installation système, Docker, modification du `.env` privé ou suppression d'un volume existant. La base est exclusivement `bunny_talks_test` sur localhost ; les suites créent chacune un schéma aléatoire et ne suppriment que celui qu'elles ont créé. Les garde-fous rejettent les URL distantes, autres bases, paramètres et fragments avant connexion.

`test:persistence` exécute les contraintes SQL existantes et la suite transactionnelle. Les courses emploient des clients Prisma et pools distincts : une barrière retient la première transaction après ses écritures ; `pg_stat_activity` doit montrer l'attente réelle du verrou par la seconde avant libération. Le polling borné observe un état PostgreSQL, sans déduire une course d'un simple délai.

Les tests couvrent les quinze scénarios demandés : concurrence initiale et CAS, indépendance entre comptes, rejeux identiques et divergents, rejets durables après évolution de l'état, conflits de révisions/digest/génération, modifications interdites, octets exacts, conservation des appareils et sessions, recréation du client, réponse perdue après commit, faute avant commit et reprise après timeout réel de verrou. Ils vérifient aussi les rejouements simultanés d'un même UUID, les limites bigint, les compteurs initiaux, les clés absentes, la conservation d'une ancienne clé et les erreurs de parsing non terminales.

Les injections sont exclusivement dans les tests, par enveloppe du client transactionnel : une faute après publication, vérificateur, activation et reçu mais avant commit démontre leur rollback intégral ; une faute après commit démontre la relecture et le rejeu sans seconde mutation. La recréation du client démontre la persistance hors mémoire du repository ; aucun redémarrage physique du serveur ni incident disque n'est simulé.

Pour reproduire après génération du client et construction des packages partagés :

```sh
pnpm --filter @bunny-talks/api prisma:generate
pnpm -r --if-present build
pnpm --filter @bunny-talks/api test:persistence
```

`TEST_DATABASE_URL` doit être injectée ou déjà définie localement selon les garde-fous de 4.2A. La suite d'intégration n'est pas silencieusement ignorée en l'absence de base : elle échoue explicitement. Les tests sans base font partie de `pnpm test`.

Points de revue prioritaires : frontières d'autorisation, ordre verrou/reçu/CAS, encodage et couverture HMAC, identité stable du futur endpoint, absence de retry automatique, rétention des clés et reçus. L'alternative `Serializable` avec retries automatiques n'a pas été retenue : le verrou de compte fournit la sérialisation voulue, et un résultat de commit incertain exige d'abord une résolution par reçu. Aucun statut `PENDING`, repository en mémoire ou parseur V1 parallèle n'est nécessaire.

## Résultats et fichiers de revue

Toutes les vérifications finales suivantes ont réussi le 15 novembre 2026 :

| Vérification                                   | Résultat                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm test`                                    | Suites du monorepo réussies, dont 9 tests API sans base.                                            |
| `pnpm typecheck`                               | Tous les packages concernés, l'API et les tests, ainsi que le mobile.                               |
| `pnpm lint`                                    | Réussi.                                                                                             |
| `pnpm format:check`                            | Réussi.                                                                                             |
| `pnpm -r --if-present build`                   | Réussi.                                                                                             |
| `git diff --check`                             | Réussi.                                                                                             |
| `prisma:generate` / `prisma:validate` de l'API | Client 7.10.1 généré ; schéma valide.                                                               |
| `test:persistence` de l'API                    | 27 tests réussis : 26 tests du repository et le test des contraintes SQL 4.2A, sur PostgreSQL 18.7. |
| Import Node des sorties ESM compilées          | Repository et client Prisma importés avec succès.                                                   |

Le premier passage d'intégration avait échoué sur la fixture de sessions, qui fournissait explicitement un `accountId` déjà déduit par Prisma de la relation composite ; la fixture a été corrigée et la suite complète a ensuite réussi. Aucune validation de parcours HTTP, d'autorisation, de redémarrage physique PostgreSQL ou de panne disque n'est revendiquée. Docker n'a pas été utilisé.

La correction de compatibilité avec une réinitialisation simulée a ensuite été qualifiée sur une nouvelle instance temporaire PostgreSQL 18.7 : 30 tests de persistance réussis. La simulation modifie le vérificateur sous verrou de compte uniquement dans le test ; elle ne constitue pas un service de réinitialisation. Les tests vérifient les révisions distinctes à la lecture, le rejet ordinaire durable et son rejeu, la préservation des données et sessions, ainsi que le refus des révisions futures, structures corrompues et digests incorrects.

Fichiers créés : les trois fichiers `apps/api/src/postgres-vault-repository.ts`, `vault-request-fingerprint.ts`, `vault-repository-error.ts` ; les quatre fichiers `apps/api/tests/postgres-vault-repository.test.ts`, `postgres-test-database.ts`, `postgres-test-database.test.ts`, `vault-request-fingerprint.test.ts` ; cette documentation.

Fichiers modifiés : `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tests/tsconfig.json`, `pnpm-lock.yaml`, `docs/architecture/architecture-overview.md`, `docs/development/current-milestone.md`, `docs/development/postgresql-prisma-foundation.md` et `docs/development/vault-publication-contracts.md`. Le schéma et la migration restent ceux de 4.2A.

Message de commit recommandé : `feat(api): add transactional PostgreSQL vault repository`. Ce jalon est désormais commité ; les résultats ci-dessus décrivent sa qualification initiale.
