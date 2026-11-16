# Amorçage sécurisé du premier appareil — jalon 4.4B

Statut historique : jalon terminé, validé expérimentalement et commité (`767ed84`). À sa clôture : aucun endpoint HTTP, ajout d’appareil supplémentaire, récupération de compte ou transfert OpenE2EE. La [fondation HTTP 4.4C1](http-sessions.md) ne publie pas cet amorçage. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts ; aucune qualification de production.

## Audit initial et réutilisation

Le dépôt était propre au début du jalon. Les commits locaux confirment la livraison de 4.2A (`29c5bf6`), 4.2B (`90d8507`), 4.3A (`a6c0a21`), 4.3B (`4bb702d`), 4.3C (`7548633`) et 4.4A avec unicité e-mail insensible à la casse (`46d6681`). Les anciennes indications « pour revue » de ces jalons sont actualisées sans transformer leurs résultats expérimentaux en qualification de production.

L’audit porte sur le schéma Prisma et ses cinq migrations, `postgres-vault-repository.ts`, `postgres-session-repository.ts`, `session-authentication.ts`, `session-lifecycle.ts`, `postgres-email-registration.ts`, `password-verifier.ts`, `postgres-reauthentication.ts`, les contrats/schémas de publication, les exports publics et transitions de `crypto-backup`, ainsi que les documentations 4.2 à 4.4A et les documents produit, architecture, archive et menaces.

Éléments réutilisés :

- `Account FOR UPDATE` : verrou stable avant la première publication, partagé avec coffre, sessions et réauthentification.
- `requireSessionInTransaction` : vérification effective du secret de session, du compte, des dates et de la révocation de session/appareil sous ce verrou.
- `verifyPassword` : Argon2id natif asynchrone, profil serveur borné, erreurs fixes et concurrence limitée ; aucun nouveau KDF.
- `EmailIdentity` : son existence prouve la vérification persistée ; `verifiedAt` est obligatoire et fini en SQL, et ne doit pas être futur.
- `prepareInitialPublication` : extraction synchrone minimale du chemin 4.2B existant. Validation stricte V1, copie des données avant le premier `await`, digest recalculé sur les octets exacts et validation du contexte par les primitives publiques existantes.
- `executeInTransaction(tx, input, replayOnly)` : reçu HMAC, CAS, compteurs initiaux et octets exacts inchangés. Aucune transaction Prisma imbriquée, aucun nouveau contrat V1.

Les données antérieures prouvent parfois l’existence d’un coffre ou d’un appareil autorisé, mais ne permettent pas d’attribuer sans ambiguïté une publication à son appareil initiateur. Aucun UUID de session, reçu d’inscription ou booléen fourni par l’appelant ne remplace cette liaison.

## États et éligibilité

| État                                      | Traitement                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Compte vérifié, jamais initialisé     | Potentiellement éligible : vérificateur présent, aucun succès antérieur, état/publication/reçu de succès historiques absents, aucun `Device.authorizedAt` non nul, même si cet appareil est révoqué. |
| B — Appareil connecté en attente          | Session valide liée au compte et appareil non révoqué ; aucun droit E2EE avant le commit d’amorçage.                                                                                                 |
| C — Compte initialisé                     | Publication active, reçu `COMMITTED`, autorisation du premier appareil et association compte/appareil/opération conservés dans un seul commit.                                                       |
| D — Tous les appareils perdus ou révoqués | Définitivement non éligible à un nouvel amorçage ; récupération distincte à concevoir. Aucun effacement du coffre ou de l’historique.                                                                |
| E — Historique ambigu                     | `HISTORICAL_STATE` : coffre actif, ancienne publication, reçu de succès ou autorisation historique sans association identifiable. Intervention ou migration future ; aucune réparation automatique.  |

Les rejets métier associés à des tentatives précédentes ne rendent pas le compte initialisé. Un nouvel UUID correctement préparé peut être examiné tant qu’aucune initialisation n’a réussi. L’éligibilité est vérifiée sous verrou au moment de la mutation ; aucun endpoint d’éligibilité indépendant n’est ajouté.

## Authentification et confiance du premier appareil

`PostgresInitialDeviceBootstrap.activate(sessionToken, password, request, candidateDigest)` exige une session réelle et un mot de passe vérifié directement avec le vérificateur serveur. Le compte du DTO doit être celui de la session ; l’appareil est obtenu exclusivement par la session, jamais choisi dans la requête.

La session est d’abord lue avec les primitives existantes. Le vérificateur exact et sa révision sont lus, puis Argon2id est exécuté **hors transaction**. La transaction d’activation revalide ensuite session, appareil, identité e-mail, vérificateur exact et révision. Elle refuse un contrôle commencé depuis cinq minutes ou plus, ainsi qu’un recul d’horloge par rapport à son début. Le budget inclut la dérivation et l’attente du verrou. Aucun grant 4.3C n’est émis ou consommé. La session n’est ni créée, ni prolongée, ni remplacée par ce service.

Le mot de passe reçu est celui de l’authentification du compte. La dérivation cliente du coffre reste indépendante. Le service ne reçoit ni clé de récupération indépendante, ni clé maîtresse, ni clé privée E2EE en clair. Les chaînes JavaScript du mot de passe ne peuvent pas être effacées avec une garantie mémoire ; les buffers transitoires restent gérés par les primitives existantes. Aucun log n’est émis. L’infrastructure future doit aussi empêcher la journalisation des paramètres sensibles.

L’inscription 4.4A ayant déjà vérifié l’adresse, aucune seconde vérification e-mail n’est ajoutée pour ce premier amorçage. Risque résiduel explicite : un attaquant possédant les identifiants avant la première activation, et capable d’obtenir une session valide, peut gagner la course et publier son propre coffre structurellement valide. Le service ne prouve pas la légitimité humaine du premier appareil. Les appareils supplémentaires resteront soumis à la procédure renforcée dédiée ; cette exception initiale ne leur est pas transférable.

## Persistance minimale et irréversibilité

La migration additive `20261115050000_initial_device_bootstrap` crée une seule association `InitialBootstrapOperation` : `(accountId, operationId)` comme clé primaire, `deviceId`, deux clés étrangères composites vers le reçu et l’appareil du même compte. Elle mémorise **chaque tentative examinée**, y compris les rejets métier, pour empêcher l’appropriation de son UUID par un autre appareil.

Le résultat n’est pas dupliqué : l’association rejoint `VaultOperation.status`. Un succès associé identifie définitivement le premier appareil et son opération, indépendamment des sessions et des champs mutables du coffre. Aucune copie de publication, digest, mot de passe, vérificateur ou secret dans cette table. La date d’autorisation reste dans `Device.authorizedAt`.

Les triggers SQL :

- Refusent modification et suppression d’une association, et exigent un reçu `initial-publication` existant.
- Prennent le verrou de compte à l’insertion et interdisent un second succès associé pour ce compte en consultant les reçus existants ; les rejets n’occupent pas cette place.
- Rendent immuable le reçu associé. Les clés étrangères empêchent sa suppression et la disparition de l’appareil référencé.

L’unicité est donc assurée par la vérification applicative sous verrou, le coffre unique par compte et le garde SQL d’insertion de succès. Elle ne dépend pas d’un statut supplémentaire recopié dans le marqueur. La révocation ne supprime pas `authorizedAt` ni les associations ; même une perte simulée des champs mutables ne rend pas le compte réamorçable. Ces protections ne résistent pas à un administrateur malveillant pouvant supprimer les triggers ou altérer les sauvegardes.

La migration ne remplit aucune association historique et ne modifie aucune ancienne table de données. Elle ne réautorise aucun appareil. Son test applique les cinq anciennes migrations, crée compte neuf, coffre/reçu historiques, appareil autorisé puis révoqué, appareil en attente et session historique ; toutes leurs données restent strictement identiques après migration. Les comptes historiques sans e-mail vérifié restent également refusés.

Alternatives écartées : se fier uniquement au nombre d’appareils actifs perd l’irréversibilité ; reconstruire arbitrairement l’appareil initiateur depuis un reçu serait infondé ; ajouter un marqueur de succès et une table distincte pour les rejets dupliquerait la structure ; ajouter un statut de succès à l’association dupliquerait le reçu. Aucun moteur de workflow ni table générique n’est nécessaire.

## Ordre des verrous et des écritures

Après préparation/Argon2id hors transaction, une transaction interactive `ReadCommitted` :

1. Configure les délais locaux et prend `Account FOR UPDATE`.
2. Revalide le contexte authentifié et le contrôle de mot de passe récent.
3. Cherche l’association de cette opération. Si elle existe, exige le même appareil et effectue seulement le rejeu HMAC exact du reçu.
4. Sinon, refuse les précédents succès et les historiques ambigus. Un reçu ancien sans association pour cet UUID produit aussi `HISTORICAL_STATE`.
5. Appelle le repository 4.2B dans **cette transaction** : validation des révisions attendues, quatre compteurs initiaux à 1, insertion de publication/état actif et reçu terminal.
6. Renseigne `Device.authorizedAt` **uniquement si** le résultat est `committed`.
7. Insère l’association immuable vers le reçu et l’appareil ; commit de l’ensemble.

Un rejet métier est retourné normalement pour committer son reçu et son association ; aucune publication ni autorisation n’est créée. Une exception avant commit annule toutes les écritures. Aucun calcul Argon2id, réseau ou appel de transport sous verrou. Les seuls callbacks de transaction sont privés à l’infrastructure ; aucun callback arbitraire de mutation n’est exposé.

Délais identiques aux compositions précédentes : acquisition Prisma 2 s, transaction 5 s, verrou PostgreSQL 1 s, instruction 3 s. Tous les écrivains sensibles doivent conserver l’ordre `Account` avant les lignes dépendantes. Une révocation ayant committé avant le verrou refuse l’activation ; elle ne peut pas annuler rétroactivement une opération déjà committée. Aucun retry automatique.

## Réponse perdue et relecture sans création

`recoverReceipt(sessionToken, request, candidateDigest)` est une lecture authentifiée dédiée : compte vérifié, session actuellement valide, appareil non révoqué, association au même appareil, identité et octets exacts. Elle ne nécessite pas le mot de passe et reste possible avec une session renouvelée du **même appareil** par une future authentification correctement liée. La création de cette session et la preuve de liaison ne sont pas fournies par l’amorçage.

Le chemin vérifie l’existence de l’association puis appelle seulement `executeInTransaction(..., true)`. Si association et reçu sont absents, il retourne `unknown`, sans création. Un reçu ancien non associé échoue fermé. `unknown` ne prouve pas l’annulation d’une opération encore en cours ou dont le commit est incertain. Une nouvelle lecture ou une tentative exacte avec les mêmes données reste nécessaire.

Le HMAC est recalculé avec la clé historique du reçu. Une divergence de données valides retourne `IDEMPOTENCY_MISMATCH` sans écriture ; une clé absente produit `KEY_UNAVAILABLE`. Un autre appareil reçoit `REPLAY_FORBIDDEN`. Une session/appareil révoqué reçoit `INVALID_SESSION`. Le rejeu d’un rejet ne confère aucune autorisation. Le rejeu d’un succès ne renseigne jamais de nouveau `authorizedAt`, même si un état mutable a disparu. Un nouvel UUID après succès produit `NOT_ELIGIBLE`.

Une erreur du pilote ou de commit est expurgée en `OUTCOME_UNKNOWN` ; elle n’est jamais qualifiée de rollback. Après erreur, conserver DTO, digest et UUID exacts, puis utiliser la relecture. Un reçu `COMMITTED` établit le succès durable PostgreSQL ; `REJECTED` établit seulement le rejet durable. Le reçu d’inscription `account-created` n’authentifie pas ce chemin et n’en remplace jamais le résultat.

La rétention des associations/reçus et des clés HMAC historiques est nécessaire. Aucune purge ni politique de suppression de compte n’est livrée. Les gardes SQL interdisent actuellement la suppression de ces traces ; une politique future devra préserver l’irréversibilité et la récupération sans réaffecter les UUID.

## Qualification et limites

Les tests de préparation sont unitaires : copie synchrone, octets/digest exacts, absence d’accès à la base, refus de champs d’authentification inventés, structure et contexte invalides. Les tests de service et d’atomicité utilisent réellement PostgreSQL 18.7, Prisma et plusieurs pools distincts.

Les courses déterministes font terminer les deux vérifications Argon2id réelles avant toute transaction d’activation. Une première transaction est retenue après les écritures ; `pg_stat_activity` doit montrer l’attente de verrou de la seconde avant libération. Cela couvre deux appareils avec UUID distincts, même UUID/candidats distincts, même appareil/rejeu exact et même appareil/candidats distincts. Un seul coffre et une seule autorisation deviennent durables. Le résultat du gagnant peut être relu même en ignorant sa première réponse.

Les autres scénarios couvrent les 26 exigences du jalon : éligibilité du compte neuf ; absence d’e-mail ou vérificateur ; sessions absentes/inconnues, expirées, inactives, révoquées et mauvais secret ; appareil révoqué ; mauvais mot de passe ; erreur Argon2id assainie ; changement indépendant du PHC ou de sa révision pendant le KDF ; révocation et suppression d’identité e-mail pendant ce calcul ; contrôle devenu trop ancien ; publication/digest/contexte invalides ; rejets durables de révisions ; activation atomique et octets exacts ; reprise des deux résultats ; tentative par un autre appareil/compte ; révocation totale et nouvelle connexion ; historiques ambigus ; faute avant commit ; faute après commit ; recréation Prisma ; sessions conservées ; absence de secrets dans erreurs/reçus. Les tests SQL couvrent aussi les liaisons intercomptes, l’immuabilité et le second succès refusé.

Les injections de pannes entourent de vraies transactions : faute après toutes les écritures avant commit, ou après le commit réel avant retour. Les barrières KDF appellent d’abord le vrai vérificateur. Seule l’erreur du fournisseur est injectée ; ses mécanismes natifs d’assainissement sont aussi couverts par les tests unitaires existants de `password-verifier`. Aucun mock en mémoire ne sert à revendiquer l’atomicité.

Les garde-fous existants sont conservés : base `bunny_talks_test` exclusivement locale, URL sans paramètres/fragment, contrôle de version 18.7, création de schémas aléatoires et suppression limitée à ces schémas. Le test de migration suit les mêmes restrictions. Aucun `.env` privé ni secret utilisateur modifié, aucune migration déployée dans la base applicative.

**Limite E2EE :** le serveur valide la structure V1 et le contexte, mais ne vérifie ni manifest client, ni déchiffrement effectif, ni possession de l’identité commune. La publication est préparée sur le client ; aucune identité n’est inventée côté serveur. `authorizedAt` représente une décision serveur, pas une preuve cryptographique. Aucun téléchargement de secrets ni partage de clés n’est exposé sur cette seule base.

SEC-CRYPTO-003 reste ouvert pour l’autorisation complète des appareils, et SEC-CRYPTO-002 pour restauration/transfert OpenE2EE. Aucun changement du SDK n’est réalisé ici. La qualification Node/PostgreSQL ne démontre ni sauvegarde de la clé de récupération hors appareil, ni persistance de la première identité locale, ni reprise mobile complète. Le client devra prouver ces conditions avant de présenter l’activation comme terminée ; React Native/Hermes, appareils physiques et iOS restent à qualifier séparément.

Avant production restent également les endpoints sécurisés, TLS et journalisation, limitation d’abus avant KDF, horloges, dimensionnement, gestion opérationnelle des clés HMAC et audit indépendant. Ces travaux ne sont pas entrepris dans ce jalon.

## Résultats et revue

Vérifications finales exécutées le 15 novembre 2026 avec Node **24.22.2**, pnpm **10.34.9**, Prisma **7.10.1** et PostgreSQL **18.7** réel :

| Vérification                          | Résultat                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm test`                           | Réussi dans tous les workspaces, avec les cinq nouveaux tests unitaires de préparation.                    |
| `pnpm typecheck`                      | Réussi, code API et tests inclus, ainsi que le mobile.                                                     |
| `pnpm lint`                           | Réussi.                                                                                                    |
| `pnpm format:check`                   | Réussi.                                                                                                    |
| `pnpm -r --if-present build`          | Réussi.                                                                                                    |
| `git diff --check`                    | Réussi.                                                                                                    |
| `prisma:generate` / `prisma:validate` | Client généré ; schéma valide.                                                                             |
| `test:persistence`                    | **135 tests réussis dans neuf suites**, dont amorçage et migration historique.                             |
| Imports ESM compilés                  | Six modules serveur réellement importés sous Node ; préparation initiale V1 compilée exécutée avec succès. |

La base temporaire de cette session est `bunny_talks_test`, sur `127.0.0.1:55440`, dans une instance indépendante sous `/tmp`. Aucun service utilisateur ni volume existant utilisé. Les données de migration et les transactions concurrentes ont été vérifiées dans leurs schémas isolés.

Le premier passage ciblé a révélé trois erreurs de fixtures : ajouter une fin de ligne ne produit pas un autre candidat V1 valide, puisque le parseur exige le JSON canonique. Les candidats divergents utilisent désormais une autre publication structurellement valide ; aucune validation de production n’a été affaiblie. Un premier lint lancé pendant la régénération du client a rencontré un fichier transitoirement absent ; il a été relancé avec succès après génération. Aucun échec de vérification final ne reste ouvert.

La revue doit porter particulièrement sur l’association des rejets, l’ordre verrou/authentification/reçu/éligibilité, les triggers d’immuabilité et d’unicité, le garde `replayOnly`, la fraîcheur du contrôle de mot de passe et les limites de `authorizedAt`.

Fichiers créés : `apps/api/src/initial-bootstrap-error.ts`, `apps/api/src/postgres-initial-device-bootstrap.ts`, la migration `20261115050000_initial_device_bootstrap/migration.sql`, `apps/api/tests/initial-publication-preparation.test.ts`, `apps/api/tests/postgres-initial-device-bootstrap.test.ts`, `apps/api/tests/initial-bootstrap-migration.test.mjs` et cette page.

Fichiers modifiés :

- `apps/api/prisma/schema.prisma`, `apps/api/src/postgres-vault-repository.ts` (extraction de préparation), `apps/api/package.json` (scripts de tests).
- `docs/development/current-milestone.md`, `docs/development/transactional-vault-repository.md`, `docs/development/persistent-sessions.md`, `docs/development/reauthentication-grants.md`, `docs/development/email-registration.md`.
- `docs/product/project-overview.md`, `docs/architecture/architecture-overview.md`, `docs/security/encrypted-archive-and-recovery.md`, `docs/security/threat-model.md`.

Aucune dépendance ajoutée, aucun secret ou fichier `.env` privé modifié, aucune ancienne migration réécrite. Modifications laissées non commitées pour revue ; aucun travail 4.4C commencé.

Message de commit recommandé après revue : `feat(api): bootstrap the first trusted device atomically with initial vault publication`.
