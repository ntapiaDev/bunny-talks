# Fondation PostgreSQL et Prisma — jalon 4.2A

## Environnement local — 4.5A en revue

PostgreSQL 18.7, Prisma CLI/client/adaptateur 7.10.1 et pg 8.23.1 sont conservés. Le backend NestJS existe désormais ; les descriptions des fondations ci-dessous restent historiques.

Trois identités sont utilisées : `bunny_admin` initialise les ressources, `bunny_dev` possède uniquement la base `bunny_talks`, `bunny_test` possède uniquement `bunny_talks_test`. Les rôles applicatifs n'ont ni superprivilège, ni création de base/rôle, ni réplication, ni contournement RLS, ni appartenance explicite à un rôle. Chaque propriétaire peut appliquer les migrations et créer ses schémas dans sa base. Les droits PUBLIC sur les deux bases sont retirés ; les connexions croisées sont refusées. Le rôle administrateur reste privilégié et doit être réservé au provisionnement.

### Première installation

Ne pas écraser `apps/api/.env` existant. Copier l'exemple uniquement si le fichier est absent, puis adapter les valeurs manuellement : `POSTGRES_USER=bunny_admin`, `POSTGRES_DB=postgres`, trois mots de passe distincts (au moins 16 caractères pour chacun, valeurs `replace_with_` refusées), et les deux URL avec les rôles applicatifs correspondants. Encoder les caractères réservés dans les URL. Les variables de processus priment sur le fichier local ; ne pas afficher les URL ou la configuration Compose résolue.

Après revue du jalon et autorisation de démarrer l'environnement permanent :

```sh
docker compose --env-file apps/api/.env config --quiet
docker compose --env-file apps/api/.env up -d
pnpm --filter @bunny-talks/api prisma:generate
pnpm --filter @bunny-talks/api prisma:validate
pnpm --filter @bunny-talks/api prisma:migrate
```

Le volume nommé est monté sur `/var/lib/postgresql`, avec PGDATA PostgreSQL 18 sous `/var/lib/postgresql/18/docker`. Son nom physique dépend du projet Compose : conserver le même projet pour retrouver les données. Le healthcheck TCP est borné ; il ne prouve ni les migrations ni la disponibilité fonctionnelle de l'API. Le port hôte reste `127.0.0.1:15432`.

### Volume existant et échec partiel

Le fichier `01-provision.sh` est exécutable (mode Linux 755) : l'entrypoint PostgreSQL 18.7 le lance dans un processus indépendant, ce qui isole son `set -eu` du shell parent. Les scripts d'initialisation sont exécutés uniquement sur un PGDATA vide. Un échec d'initialisation peut laisser des rôles ou une base déjà créés ; redémarrer ne rejoue pas automatiquement les scripts. Ne pas supprimer le volume et ne pas relancer de migration avant inspection.

Le diagnostic suivant ne lit que des métadonnées, sans mots de passe :

```sh
docker compose --env-file apps/api/.env exec -T postgres psql -X -U bunny_admin -d postgres -c "SELECT datname, pg_get_userbyid(datdba) AS owner, datacl FROM pg_database WHERE datname IN ('bunny_talks','bunny_talks_test'); SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('bunny_admin','bunny_dev','bunny_test'); SELECT roleid::regrole, member::regrole FROM pg_auth_members;"
```

Après inspection et décision explicite, exécuter le provisionnement additif :

```sh
docker compose --env-file apps/api/.env exec -T postgres /docker-entrypoint-initdb.d/01-provision.sh
```

Il vérifie toutes les ressources existantes avant de modifier quoi que ce soit, prend un verrou consultatif, puis crée uniquement les rôles et bases manquants. Il ne remplace aucun mot de passe existant. Un rôle privilégié, une appartenance, un propriétaire différent ou une ACL accordée à PUBLIC/autrui entraîne un refus sans réparation. Une base créée avant une interruption précédant le retrait de PUBLIC est donc détectée comme incompatible. Le diagnostic et la décision humaine restent nécessaires ; aucune correction automatique n'est proposée. Les anciennes installations dont `bunny_talks` appartient au rôle partagé nécessitent une procédure de conversion revue séparément.

CREATE DATABASE ne peut pas être inclus dans une transaction classique : un échec tardif peut laisser un état partiel. Les diagnostics psql susceptibles de contenir des secrets sont supprimés, et la journalisation des instructions est désactivée pour la session de provisionnement. Le résultat indique seulement succès ou refus/échec ; conserver les secrets hors des journaux.

### Migrations et tests

`prisma:migrate` applique uniquement les migrations existantes via `migrate deploy`, après contrôle de la destination locale exacte : hôte `localhost`, `127.0.0.1` ou `[::1]`, port explicitement `15432`, base `bunny_talks`, rôle `bunny_dev`, sans paramètres ni fragment. La connexion serveur doit confirmer PostgreSQL 18.7, l'identité et les permissions attendues. Un port absent ou différent est refusé avant migration. Le CLI ouvre ses propres connexions : la séparation PostgreSQL reste indispensable. Ne pas utiliser `migrate reset` ou `migrate dev` sur des données à préserver. Relire les SQL en attente et sauvegarder avant une évolution : `migrate deploy` peut appliquer un SQL destructif. Les workflows non locaux doivent définir leur propre procédure revue et appeler explicitement Prisma ; le script local refuse les destinations distantes.

```sh
pnpm --filter @bunny-talks/api test:persistence
pnpm --filter @bunny-talks/api test:http
```

Les tests exigent une URL locale sans paramètres visant `bunny_talks_test`, avec `bunny_test`. Le contrôle serveur vérifie identité de session et rôle, version 18.7, absence de privilèges et d'appartenance et impossibilité de se connecter à dev. Le hook `onConnect` de pg est attendu avant de prêter chaque nouvelle connexion physique à Prisma ; ce contrôle ne garantit pas l'immuabilité des droits ou de l'état de session après ouverture. Aucun test ne doit changer de rôle ou de destination. Les schémas aléatoires restent les seules ressources nettoyées.

Après application des migrations initiales, pour qualifier SQL dans un conteneur explicitement jetable marqué `bunny45a=temporary`, avec exactement un volume inscriptible préfixé `bunny45a-`, monté sur `/var/lib/postgresql` sans montage superposé :

```sh
node apps/api/tests/support/qualify-local-postgres.mjs bunny45a-nopublish-20261117
```

Ce test écrit uniquement dans le conteneur désigné, crée un témoin, simule des conflits de droits puis restaure ces changements de test. Il ne doit jamais cibler un environnement permanent. Il ne remplace pas les suites Node/Prisma. Un volume persistant n'est pas une sauvegarde : une suppression, une corruption ou la perte de Docker Desktop peut perdre ses données ; une sauvegarde et une restauration vérifiées sont nécessaires pour des données importantes.

### Qualification Compose jetable

Le fichier `apps/api/tests/support/compose.qualification.yaml` surcharge uniquement le port (boucle locale, attribution dynamique), l'étiquette temporaire et le nom physique du volume. Le healthcheck et l'initialisation restent ceux du Compose racine.

Avant démarrage, inspecter les projets, conteneurs et volumes et vérifier que `bunny45a-qualification` et `bunny45a-qualification-data` ne désignent aucune ressource préexistante à préserver. Préparer un fichier d'environnement de test distinct avec des mots de passe jetables ; ne pas utiliser ni modifier le `.env` permanent.

```sh
docker compose --env-file /tmp/bunny45a-final.env -p bunny45a-qualification -f compose.yaml -f apps/api/tests/support/compose.qualification.yaml config --quiet
docker compose --env-file /tmp/bunny45a-final.env -p bunny45a-qualification -f compose.yaml -f apps/api/tests/support/compose.qualification.yaml up -d --wait --wait-timeout 30
docker compose --env-file /tmp/bunny45a-final.env -p bunny45a-qualification -f compose.yaml -f apps/api/tests/support/compose.qualification.yaml port postgres 5432
```

Pour ce flux isolé à port dynamique, fournir explicitement `DATABASE_URL` et `TEST_DATABASE_URL` avec les identifiants jetables. Appliquer d'abord `pnpm --filter @bunny-talks/api exec prisma migrate deploy` à la base dev vide ; ensuite lancer le qualificateur SQL, qui y crée une table témoin, puis les suites de persistance et HTTP. Le script `prisma:migrate` permanent doit refuser ce port dynamique. Un témoin créé avant la toute première migration provoque le refus Prisma P3005 ; ne pas contourner ce refus en baselinant une base inconnue.

### Résultats finaux du 17 novembre 2026 — en attente de revue

Le projet Compose jetable `bunny45a-qualification` utilise le volume neuf `bunny45a-qualification-data`. L'initialisation a exécuté `01-provision.sh` en processus indépendant ; le mode 755 a été confirmé dans WSL et dans le conteneur. Le healthcheck du Compose racine a atteint `healthy`, avec des contrôles effectivement exécutés et réussis.

Les neuf migrations historiques ont été appliquées avec `bunny_dev` via le flux isolé à port dynamique, après vérification de l'identité et de la version serveur. Le qualificateur SQL a confirmé les refus de connexion croisée, les permissions, l'idempotence et le refus des conflits. Résultats : 49 tests unitaires ciblés, 174 tests de persistance et 144 tests HTTP (suite complète) réussis. `pnpm typecheck`, `pnpm lint` et `pnpm format:check` ont réussi ; les suites cryptographiques inchangées n'ont pas été relancées.

Après les suites, le témoin dev vaut toujours 45, les neuf migrations sont terminées et aucun schéma temporaire `test_<32 caractères hexadécimaux>` ne subsiste. Lors de la préparation, un témoin créé avant les premières migrations avait provoqué P3005 : seule cette table de test du volume neuf a été retirée, puis les migrations ont réussi avant recréation du témoin. Aucune migration historique ni aucun test n'a été modifié pour contourner ce refus.

Le jalon attend la revue humaine. Le premier démarrage permanent et la configuration réelle de son `.env` restent à effectuer après validation ; la qualification Android/E2EE est hors périmètre. Les limites transactionnelles du provisionnement et celles du healthcheck décrites plus haut restent applicables.

## Modèle et contraintes

`Account.id` est l'identifiant stable du contexte V1, imprimable ASCII sur 1 à 128 caractères. `PasswordCredential` conserve un vérificateur et sa révision positive, jamais un mot de passe. Ces tables constituent une fondation et ne réalisent pas l'authentification. `VaultState` porte l'unique coffre actif du compte, sa révision de stockage et la référence à une `VaultPublication`. La clé étrangère composite `(accountId, vaultId, activePublicationId)` empêche de pointer vers une publication d'un autre compte ou coffre. Les publications conservent les octets exacts en `bytea`, un digest de 32 octets et les compteurs structurellement extraits. Le serveur ne vérifie pas le HMAC du manifest et ne prétend pas authentifier ces compteurs.

La version de format, la génération et les révisions cryptographiques sont distinctes des révisions transactionnelles de stockage et d'identifiants. Les premières sont limitées à `Number.MAX_SAFE_INTEGER` comme les contrats V1 ; les dernières sont des `bigint` PostgreSQL positifs jusqu'à 9223372036854775807 et doivent être converties en chaînes décimales pour le contrat. À cette borne, toute incrémentation doit échouer explicitement ; aucun retour à zéro ou conversion en `number` ne convient. Le schéma SQL impose les bornes et PostgreSQL refuse les débordements.

`VaultOperation` conserve par compte et identifiant d'opération les préconditions, un identifiant de clé, une empreinte protégée de 32 octets et un résultat terminal exclusif : `COMMITTED` avec ses révisions et digest ou `REJECTED` avec un code. Une opération inconnue correspond à l'absence de ligne. La protection HMAC de l'empreinte, son calcul et sa vérification ne sont pas encore implémentés ; aucun hash simple de mot de passe ou de requête en contenant ne doit être stocké. Le choix de la clé, sa rotation, la rétention des clés, reçus et tombstones restent ouverts. Aucun mot de passe, ancien vérificateur ou secret de coffre ne figure dans les reçus.

Toutes les suppressions référencées sont restreintes, sans cascade. Les contraintes SQL de la migration complètent le schéma Prisma : formats d'identifiants, révisions positives et bornes, longueur des octets, combinaisons d'état et codes d'erreur. Le digest public est SHA-256 des octets exacts, encodé en Base64url canonique sans padding ; ce n'est ni une signature ni une vérification du manifest HMAC. La fonction `publicationDigest` calcule ce digest ; la future couche d'écriture doit l'utiliser et contrôler sa cohérence avec les octets stockés. Les contraintes de longueur ne le prouvent pas.

`Device` et `Session` portent chacun une révocation individuelle ; une clé étrangère composite lie chaque session à un appareil du même compte. Ces champs ne constituent pas une autorisation et les identifiants de session ou jetons restent à concevoir. Les entités d'identifiant de connexion et de preuve de réauthentification ne sont pas créées prématurément : leurs contrats de sécurité et cycles de vie restent à définir. L'amorçage du premier appareil est distinct de l'autorisation des suivants ; aucun accès n'est autorisé par cette fondation. Un changement ordinaire de mot de passe devra conserver les appareils et sessions autorisés. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

## Qualification et suite

Le test d'intégration applique la migration dans un schéma PostgreSQL vierge et vérifie les données, octets, unicités, clés étrangères, référence croisée, limites, reçus et suppressions. Il emploie exclusivement des fixtures. Il ne démontre pas les garanties de concurrence, de CAS ou d'atomicité. Le jalon 4.2B devra verrouiller le compte, appliquer les préconditions et conserver le résultat atomiquement, sans appel réseau ni KDF sous verrou. Aucun endpoint, mécanisme d'autorisation ou transaction métier n'est fourni ici.

Le 15 novembre 2026, la migration et le test d'intégration ont réussi sur PostgreSQL 18.7 compilé localement dans `/tmp`, sur une base dédiée et un schéma vierge temporaire. Docker Compose n'a pas été exécuté car Docker n'est pas installé. L'instance de test a été arrêtée après l'exécution.

L’installation Prisma introduit `@prisma/studio-core`, dont les dépendances React résolvent `react-dom` 19.3.1 avec `react` 19.2.3 ; ce désaccord entre pairs n’existait pas dans le fichier de verrouillage précédent. Il concerne Prisma Studio et sa résolution de dépendances, et peut aussi affecter les chemins Expo web résolus avec ce pair : aucune panne d’exécution n’a été établie. Ne pas changer les versions mobiles pour masquer l’avertissement. Avant d’utiliser Studio ou Expo web, qualifier leurs versions React ensemble ; envisager ensuite un correctif de résolution ciblé et testé.
