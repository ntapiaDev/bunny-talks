# Fondation PostgreSQL et Prisma — jalon 4.2A

Cette page conserve la description de la fondation 4.2A. Le [jalon 4.2B](transactional-vault-repository.md) ajoute désormais le repository interne, les transactions, le CAS, l'empreinte HMAC et les tests concurrents, sans modifier ce schéma ni exposer d'API HTTP. Les mentions ci-dessous de capacités futures décrivent la situation à la fin de 4.2A.

## Environnement local

Versions retenues : Node 24, pnpm 10.34.9, PostgreSQL 18.7, Prisma CLI, client et adaptateur PostgreSQL 7.10.1, pilote `pg` 8.23.1. Prisma 7 requiert un adaptateur pour les connexions directes ; le client généré est local et ignoré par Git. Aucune connexion applicative ni service HTTP n'est encore implémenté.

Sous WSL2, installer Docker et le plugin Compose selon les instructions officielles adaptées à l'environnement. Sans Docker, utiliser un serveur PostgreSQL 18.7 local distinct et créer manuellement les bases `bunny_talks` et `bunny_talks_test`. Ne pas utiliser une base existante sans vérifier sa destination. Le fichier Compose expose PostgreSQL uniquement sur `127.0.0.1:55432` et conserve ses données dans un volume. Le script d'initialisation ne crée la base de test qu'au premier démarrage d'un volume vide ; il ne détruit pas un volume existant.

```sh
corepack enable
pnpm install --frozen-lockfile
cp -n apps/api/.env.example apps/api/.env
docker compose --env-file apps/api/.env up -d
pnpm --filter @bunny-talks/api prisma:generate
pnpm --filter @bunny-talks/api prisma:validate
pnpm --filter @bunny-talks/api prisma:migrate
pnpm --filter @bunny-talks/api test:persistence
```

Avant le démarrage, remplacer dans `apps/api/.env` les valeurs d'exemple par un mot de passe local choisi : `POSTGRES_PASSWORD` et le mot de passe des deux URL doivent correspondre. Encoder les caractères spéciaux du mot de passe dans les URL PostgreSQL. Compose exige `POSTGRES_USER`, `POSTGRES_DB` et `POSTGRES_PASSWORD` sans valeur de repli ; les variables injectées dans le shell priment sur le fichier. L'utilisateur des deux URL doit correspondre à `POSTGRES_USER` et la base de `DATABASE_URL` à `POSTGRES_DB`. La base de test reste `bunny_talks_test` : `POSTGRES_DB` doit être différent de ce nom pour que son initialisation fonctionne. Pour un fichier `.env` existant, ajouter les deux nouvelles variables sans remplacer les valeurs locales. Après initialisation du volume, modifier ces variables ne renomme ni le rôle ni la base et ne change pas le mot de passe du rôle PostgreSQL existant : adapter explicitement le rôle et les URL si nécessaire, sans supprimer le volume. Les exemples ne constituent pas une configuration de production. Les fichiers `.env` sont exclus de Git. Les commandes Prisma et le test de persistance chargent explicitement `apps/api/.env` s'il existe, quel que soit le répertoire appelant. Les variables déjà injectées dans le processus ont priorité, notamment en CI ; sans fichier local, elles doivent être fournies explicitement. `DATABASE_URL` est nécessaire aux migrations. `TEST_DATABASE_URL` doit pointer vers la base dédiée `bunny_talks_test` sur localhost, sans paramètres d'URL. Le test crée un schéma au nom aléatoire et ne supprime que celui qu'il vient de créer, après y avoir appliqué toutes les migrations. Il ne réinitialise jamais la base. La création des bases, la gestion des accès et les sauvegardes en production restent à concevoir.

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
