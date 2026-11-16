# Fondation HTTP et sessions — jalon 4.4C1

**Actualisation 4.4C2A :** deux routes publiques d’[inscription HTTP](http-email-registration.md) complètent désormais la composition ; les contrats et particularités historiques de liveness/session sont conservés.

**Actualisation 4.4C1 bis :** les chemins et la composition présentés ci-dessous décrivent le jalon historique 4.4C1. L’[harmonisation architecturale](backend-architecture-harmonization.md) déplace le transport de session dans `src/auth/sessions`, le fournisseur dans `src/shared/database`, les protections transversales dans `src/shared/http` et le démarrage à la racine de `src`. Les tests sont répartis entre `tests/unit`, `tests/persistence` et `tests/http`. La politique sans entrée s’applique désormais aux routes concernées, avec les mêmes contrats et limites ; le filtre et le guard d’authentification conservent leur rôle. Les résultats ci-dessous sont historiques, les nouveaux passages figurent dans le rapport d’harmonisation.

Statut : implémentation locale non commitée pour revue critique. Seuls la liveness, la consultation de la session courante et sa révocation sont exposés. Aucun utilisateur réel ne doit être accueilli avec cette seule fondation. **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. 4.4C2 n’est pas commencé.**

## Audit initial et versions

L’arbre de travail était propre sur `feature/crypto`. Les commits locaux `46d6681` (4.4A) et `767ed84` (4.4B) confirment leur intégration. Les anciennes mentions « non commité » de 4.4B sont actualisées. Leur clôture reste une clôture expérimentale, sans qualification de production.

L’API possédait un build TypeScript strict NodeNext, un client Prisma généré dans `apps/api/generated/prisma`, six migrations, des services internes d’inscription/réauthentification/amorçage et des suites PostgreSQL séparées. Elle n’avait ni serveur HTTP ni dépendance NestJS. Les fixtures construisent `PrismaClient` avec `PrismaPg`; aucun singleton applicatif préexistant n’était à réutiliser. `local-env.mjs` charge le fichier local sans remplacer les variables injectées.

Les primitives réutilisées sont `parseSessionToken`, `SessionError`, `requireSessionInTransaction` et `PostgresSessionRepository.validate`. La seule extension du repository est `revokeCurrent(token)`, qui revalide la session dans `authenticated`, sous le verrou `Account FOR UPDATE`, puis révoque exclusivement la ligne authentifiée. Le contrôleur ne transmet jamais de cible de révocation.

Versions exactes vérifiées dans le registre npm officiel le 16 novembre 2026 :

| Dépendance                                                   | Version | Usage                                                                         |
| ------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------- |
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | 12.5.0  | Modules, injection, contrôleurs, pipeline HTTP et adaptateur Express standard |
| `reflect-metadata`                                           | 0.2.2   | Métadonnées des décorateurs NestJS                                            |
| `rxjs`                                                       | 7.8.2   | Dépendance pair obligatoire du framework                                      |
| `@types/express`                                             | 5.0.6   | Types du transport, développement uniquement                                  |

Express 5.3.0 est une dépendance transitive de l’adaptateur. Nest 12 est ESM et demande Node >=20 ; les essais utilisent Node 24.22.2, TypeScript 6.0.3, Prisma 7.10.1 et Vitest 5.1.0. Voir le [guide officiel Nest 12](https://docs.nestjs.com/migration-guide), les [versions du package officiel](https://www.npmjs.com/package/@nestjs/core?activeTab=versions) et les manifestes installés. Aucune CLI Nest, bibliothèque de validation supplémentaire, dépendance Passport/JWT ou seconde ORM n’est ajoutée. L’avertissement pnpm sur le pair React/React DOM provient des dépendances préexistantes Prisma/Expo ; leurs versions n’ont pas été changées.

## Organisation et responsabilités

- `apps/api/server.mjs` : charge l’environnement, importe le point d’entrée ESM compilé et assainit tout échec de démarrage.
- `src/http/main.ts` : lit la configuration, démarre l’écoute et active l’arrêt propre SIGINT/SIGTERM.
- `src/http/application.ts` : assemble Nest, le pipeline HTTP, les limites et le contrôle de connexion initial.
- `src/http/app.module.ts` : module principal et contrôleur de liveness.
- `src/http/config.ts`, `database.ts` : validation de configuration, création du client Prisma/adaptateur existant, propriété du pool et fermeture.
- `src/http/session.module.ts` : composition du module et enregistrement du guard global avec `APP_GUARD`.
- `src/http/session.guard.ts` : exemption publique explicite, parsing Bearer et contexte issu de la validation PostgreSQL.
- `src/http/session-http.service.ts` : capacité étroite de validation/révocation et projection explicite du DTO.
- `src/http/session.controller.ts` : deux opérations de transport, sans Prisma ni SQL.
- `src/http/http-policy.ts`, `http-error-filter.ts` : entrées, méthodes, en-têtes et erreurs assainies.

La couche HTTP dépend d’un adaptateur serveur étroit ; le domaine et les packages crypto restent indépendants de NestJS. Le module ne compose aucun service d’inscription, de réauthentification ou de coffre. Le client Prisma reste une capacité privilégiée de composition, jamais une dépendance des contrôleurs. Le contexte authentifié est conservé dans une `WeakMap` par requête, sans ajout de propriétés énumérables. L’en-tête Authorization original reste présent dans l’objet HTTP natif : aucune sérialisation brute de requête n’est sûre.

`experimentalDecorators: true` est activé uniquement pour l’API. L’injection utilise des tokens explicites avec `@Inject` ou des factories : `emitDecoratorMetadata` n’est pas requis, ce qui évite une divergence entre la compilation TypeScript et les transformations Vitest. Les imports relatifs `.js`, le build ESM, le typage strict et l’exclusion des tests du build sont conservés.

## Contrat HTTP

Toutes les routes acceptent **zéro paramètre de requête et zéro corps**, y compris `{}`. Aucun identifiant fourni par le client ne sélectionne de compte, appareil ou session. Les réponses avec contenu sont JSON. Les routes sont sensibles à la casse et aux barres finales.

| Méthode et chemin    | Authentification                             | Réponse               |
| -------------------- | -------------------------------------------- | --------------------- |
| `GET /health/live`   | Publique, exemption explicite sur ce handler | `200 {"status":"ok"}` |
| `GET /v1/session`    | Bearer opaque vérifié dans PostgreSQL        | `200`, DTO ci-dessous |
| `DELETE /v1/session` | Même Bearer, revalidé lors de la mutation    | `204`, aucun corps    |

Le DTO contient exactement :

```json
{
  "accountId": "identifiant-du-compte",
  "sessionId": "uuid-de-la-session",
  "deviceId": "uuid-de-l-appareil",
  "deviceState": "pending",
  "expiresAt": "2026-12-16T12:00:00.000Z"
}
```

`deviceState` vaut `pending` ou `authorized`. Cette dernière valeur est un état serveur informatif, **pas une preuve de possession de l’identité E2EE**. Une session `pending` peut consulter son état et se révoquer, sans accès au coffre. `GET` et le passage du guard pour `DELETE` appellent `validate` : mise à jour de `lastSeenAt`, jamais de l’expiration absolue. La politique 4.3B reste 30 jours absolus et 7 jours d’inactivité, persistés par session. Un échec HTTP après validation peut donc avoir actualisé l’activité, sans avoir réussi la révocation.

La liveness ne consulte pas PostgreSQL. Un `SELECT 1` est effectué au démarrage, mais le `200` ultérieur de liveness ne démontre ni disponibilité courante de la base, ni présence des migrations, ni bon fonctionnement des autres services. Aucun endpoint de readiness n’est ajouté.

## Authentification et concurrence

Le seul emplacement accepté est `Authorization: Bearer <s1.uuid.secret>`. Le schéma est insensible à la casse conformément à HTTP ; il faut un espace unique avant un jeton canonique. Le parseur opaque existant vérifie version, UUID v4 minuscule, longueur, alphabet et bits de remplissage Base64url. Les en-têtes Authorization bruts sont comptés sans tenir compte de leur casse : doublons, listes séparées par virgules, tabulation interne et jetons non canoniques sont refusés. Les espaces HTTP externes éventuellement retirés par le parseur natif Node ne peuvent pas être distingués après ce parsing ; ils ne changent pas le jeton.

Cookies et en-têtes alternatifs ne participent jamais à l’authentification. Un jeton dans l’URL ou le JSON est refusé avec les autres entrées superflues. Le guard global protège chaque nouveau handler par défaut ; seules les métadonnées `PublicRoute` explicites exemptent un handler ou une classe. Il n’existe aucun booléen de contournement de développement.

La vérification PostgreSQL contrôle le hash à temps constant, les deux expirations et les révocations session/appareil. Elle relit les données après acquisition du verrou commun au compte. `DELETE` effectue une seconde transaction avec la même revalidation, ce qui couvre une révocation entre le guard et le contrôleur. Il n’existe aucun `sessionId` cible dans son contrat. Les autres sessions, appareils, autorisations et clés restent inchangés.

Une consultation validée avant le commit d’une révocation peut encore produire sa réponse ; il n’existe pas d’annulation rétroactive. Après le commit de révocation, une nouvelle validation échoue. Le verrou par compte sérialise aussi les usages simultanés de ses autres sessions. Les limites existantes restent : verrou 1 s, instruction 3 s, acquisition transaction 2 s, transaction 5 s. Un timeout retourne `503`, jamais `401`. `DELETE` implique deux validations transactionnelles : une optimisation future doit préserver leur revalidation, sans déplacer une décision d’autorisation hors transaction.

## Protections HTTP et alternatives

- Corps limité à **8 192 octets**, y compris en transfert chunked. Seul `application/json`, avec éventuellement `charset=utf-8`, est reconnu ; compression et autres contenus sont refusés. Le parseur JSON borne la lecture avant le refus des corps par les routes actuelles.
- Maximum 64 en-têtes : refus explicite plutôt que troncature silencieuse susceptible de masquer un doublon. Les doublons de contenu/framing sont également refusés ; le parseur Node peut rejeter une requête HTTP invalide avant Nest.
- `Cache-Control: no-store` sur les succès et erreurs du pipeline, pas d’ETag, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, suppression de `X-Powered-By`.
- CORS désactivé, sans origine universelle. Ce choix convient au client mobile natif ; une future origine web exigera une décision explicite. CORS n’est pas un mécanisme d’authentification.
- Méthodes non prévues : `405` et `Allow` sur les trois routes connues, y compris HEAD implicite et OPTIONS. Route inconnue : `404` assaini. Les erreurs du parseur HTTP natif, en amont d’Express, restent des refus de transport Node et peuvent avoir un corps vide.
- Délais HTTP : en-têtes 5 s, réception 10 s, keep-alive 1 s. Pool PostgreSQL : 8 connexions au plus, acquisition 2 s, requêtes 5 s. Ce sont des bornes locales, sans garantie globale de résistance au déni de service.
- Aucun log de requête/exception Nest activé ; seuls des messages fixes sans données signalent un échec de démarrage. L’observabilité future devra ajouter des événements assainis plutôt qu’activer une sérialisation brute des requêtes ou exceptions.

Le `ValidationPipe` historique requiert class-validator et ne réutilise pas nos schémas. Nest 12 fournit aussi `StandardSchemaValidationPipe`, dont les déclarations publiques installées ont été examinées ; il permet une future intégration des schémas Zod 4 existants. Aucun schéma métier n’est applicable aux trois routes sans entrées de ce jalon. Ajouter une série de DTO décorés, une dépendance directe Zod ou un pipe inutilisé n’apporterait aucune validation supplémentaire ici.

La limitation a été évaluée : un compteur en mémoire par IP/processus ne protégerait pas un déploiement distribué, et sa clé deviendrait trompeuse derrière un proxy non configuré. **Aucun rate limiter ni `429` n’est actuellement émis.** Avant publication, des limites coordonnées devront être appliquées à l’entrée et aux opérations sensibles. Aucun Redis n’est ajouté. Le dispositif anti-bruteforce, les quotas et budgets Argon2id globaux des futurs login/inscription restent obligatoires pour 4.4C2. Le verrou et la taille du pool ne constituent pas un dispositif anti-bruteforce.

## Erreurs

Format unique des erreurs traitées par Nest : `{"error":{"code":"UNAUTHORIZED"}}`. Aucun détail SQL, chemin local, stack, jeton, hash, mot de passe ou code de sécurité interne n’est reflété.

| Origine                                                             | Statut | Code public              |
| ------------------------------------------------------------------- | ------ | ------------------------ |
| Bearer absent/invalide ; `SessionError.INVALID_SESSION`             | 401    | `UNAUTHORIZED`           |
| Entrée superflue, JSON malformé, en-têtes ambigus ; `INVALID_INPUT` | 400    | `BAD_REQUEST`            |
| Route absente                                                       | 404    | `NOT_FOUND`              |
| Méthode non acceptée sur une route connue                           | 405    | `METHOD_NOT_ALLOWED`     |
| Corps trop volumineux                                               | 413    | `PAYLOAD_TOO_LARGE`      |
| Type, encodage ou compression non pris en charge                    | 415    | `UNSUPPORTED_MEDIA_TYPE` |
| `SessionError.UNAVAILABLE` ou `OUTCOME_UNKNOWN`                     | 503    | `SERVICE_UNAVAILABLE`    |
| Exception inattendue, y compris exception Prisma non classée        | 500    | `INTERNAL_ERROR`         |

Les `401` incluent `WWW-Authenticate: Bearer`. Une erreur SQL du repository est déjà transformée en erreur de disponibilité ou d’issue inconnue : elle ne devient jamais automatiquement un refus d’authentification. La classification HTTP n’inspecte pas de message PostgreSQL ni de structure interne du pilote. `OUTCOME_UNKNOWN` peut aussi signifier que la mutation a été commitée sans confirmation ; un `503` ne démontre pas un rollback. Après une révocation réussie dont la réponse est perdue, une nouvelle tentative est refusée en `401` ; pas de reçu de déconnexion ni de nouvelle session implicite.

## Configuration et commandes

Le chargeur existant est exécuté par `server.mjs`, depuis n’importe quel répertoire courant, avec le même fichier `apps/api/.env`. Les variables injectées restent prioritaires. Aucun secret local n’est écrit ou modifié par le serveur.

| Variable       | Règle                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | Obligatoire, URL PostgreSQL avec hôte, utilisateur, mot de passe et base explicites             |
| `API_HOST`     | Adresse IP littérale ; défaut `127.0.0.1` ; toute exposition supplémentaire doit être explicite |
| `API_PORT`     | Entier décimal canonique 1–65535, défaut 3000 ; `0` autorisé uniquement en mode test            |
| `NODE_ENV`     | `development` par défaut, `test` ou `production`                                                |

Paramètres d’URL reconnus : `schema`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, chacun une seule fois. Le schéma doit être un identifiant simple de 63 caractères maximum. Les paramètres permettant de remplacer silencieusement l’hôte ou les limites du pool sont refusés. `sslmode` est limité à `disable` ou `verify-full` ; un hôte PostgreSQL distant, ou le mode production, exige `verify-full`. Les certificats éventuels sont des fichiers provisionnés par l’exploitant ; leurs contenus ne sont jamais documentés ou logués. La négociation TLS PostgreSQL distante n’est pas qualifiée par les tests locaux.

Depuis la racine du dépôt :

```sh
pnpm --filter @bunny-talks/api prisma:validate
pnpm --filter @bunny-talks/api prisma:generate
pnpm --filter @bunny-talks/api... build
pnpm --filter @bunny-talks/api dev
# Exécution du build déjà préparé :
pnpm --filter @bunny-talks/api start
# Suites avec TEST_DATABASE_URL injectée vers la base dédiée locale :
pnpm --filter @bunny-talks/api test:http
pnpm --filter @bunny-talks/api test:persistence
```

`dev` compile l’API puis démarre le même serveur que `start`, sans rechargement automatique : relancer après modification. Les packages partagés doivent être construits préalablement comme ci-dessus. Les migrations sont déployées séparément, selon les procédures existantes ; le démarrage n’effectue aucune migration et ne crée aucun compte. Les tests unitaires restent dans `pnpm test`, sans PostgreSQL. `test:http` construit l’API pour tester aussi son point d’entrée compilé. Les fixtures PostgreSQL conservent le refus des bases autres que `bunny_talks_test` locales, l’exigence 18.7 et les schémas aléatoires supprimables uniquement par leur propriétaire de test.

Le serveur local est en **HTTP clair**, sans TLS automatique. Le déploiement public prévu exige un reverse proxy avec terminaison HTTPS/TLS, accès direct au backend fermé, certificat valide, suppression/réécriture contrôlée des en-têtes de transfert, limites de requêtes et politique de journalisation sans secrets. Un saut HTTP local ne convient que dans un périmètre réseau effectivement protégé ; chiffrer les sauts traversant une frontière non fiable. `trust proxy` est explicitement `false` : `X-Forwarded-*` n’autorise aucun changement de confiance. Une future configuration devra nommer les proxys/adresses de confiance de manière restrictive et être testée suivant les [règles Express](https://expressjs.com/en/guide/behind-proxies/). Aucun chemin TLS public n’est validé ici.

## Validation et limites

`tests/http.test.ts` couvre les composants isolés et ne prétend pas authentifier des sessions. `tests/http-postgres.test.ts` passe par un serveur NestJS réel sur port loopback éphémère, des jetons créés par le repository et PostgreSQL 18.7 réel ; aucun mock n’accorde une identité. Une interception de méthode synchronise uniquement la course entre guard et révocation, avec deux révocations réellement persistées. Les autorisations de fixtures sont écrites par l’infrastructure de test privilégiée, pas par une route publique.

Les cas couvrent parsing, erreurs, configuration, session en attente/autorisée, secret incorrect, expirations absolue/inactivité, révocations, isolation, maintien des autres sessions, attente du verrou et timeout, méthodes, contenu, taille, doublons, cache, absence de routes sensibles et fuite de jetons, liveness indépendante d’une panne SQL, démarrage ESM compilé, SIGTERM et absence de connexions après fermeture. La suite repository ajoute un test direct de `revokeCurrent` avec secret incorrect et rejeu.

Il n’y a pas de benchmark de charge. Le test de contention attend réellement un verrou serveur observé dans `pg_stat_activity`, puis vérifie le refus après commit de révocation ; un autre conserve le verrou et vérifie un `503` après le délai de 1 s. Ces observations ne dimensionnent ni le débit ni la latence de production.

Hors périmètre : login HTTP, inscription/vérification e-mail HTTP, SMTP, liste de compromission de production, amorçage HTTP, changement de mot de passe HTTP, grants, ajout/approbation/révocation d’appareils, accès au coffre, cookies, JWT et Swagger public. La confidentialité des secrets côté client, la preuve de possession E2EE, la récupération et la qualification complète du SDK restent ouvertes.

Points de revue prioritaires : doublons d’en-têtes avant normalisation applicative, exemption publique du guard, seules capacités exposées par `SessionHttpService`, revalidation de `revokeCurrent` sous verrou, projection du DTO, classification `503`/`401`, refus des sélecteurs d’identité et fermeture du pool. Alternative non retenue : dériver une cible de révocation dans le contrôleur puis utiliser `revokeSession`; la primitive dédiée rend la frontière explicite et évite d’exposer une opération plus privilégiée.

## Résultats exécutés le 16 novembre 2026

| Vérification                                                                                           | Résultat                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm test`                                                                                            | Réussi dans tous les packages concernés ; comprend les 56 tests unitaires HTTP |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                                     | Réussis                                                                        |
| `pnpm -r --if-present build`                                                                           | Réussi ; aucun test inclus dans le build de l’API                              |
| `pnpm --filter @bunny-talks/api prisma:validate` et `prisma:generate`                                  | Réussis avec Prisma 7.10.1 ; emplacement généré inchangé                       |
| `pnpm --filter @bunny-talks/api test:persistence`                                                      | 9 suites, 136 tests réussis sur PostgreSQL 18.7 réel                           |
| `pnpm --filter @bunny-talks/api test:http`                                                             | Script vérifié avec 34 tests réussis ; suite ensuite étendue                   |
| `pnpm --filter @bunny-talks/api exec vitest run tests/http-postgres.test.ts`, après build global final | 37 tests réussis, dont démarrage ESM compilé et arrêt SIGTERM                  |
| `git diff --check`                                                                                     | Réussi                                                                         |

Le premier passage HTTP a identifié trois assertions/fixtures incorrectes : absence de `Host` dans les requêtes brutes HTTP/1.1 et recherche du caractère `{` dans une réponse JSON. Elles ont été corrigées avant les passages réussis. Aucun échec final ne reste ouvert.

PostgreSQL 18.7 a été compilé depuis les sources officielles sous `/tmp`, avec les outils de compilation manquants extraits sous `/tmp`, sans installation système. L’instance temporaire écoutait uniquement sur `127.0.0.1:55439`, base dédiée `bunny_talks_test`. Les migrations existantes sont appliquées dans chaque schéma aléatoire de test. Après les suites, un contrôle SQL indépendant constate **zéro schéma de test et zéro connexion restante** ; l’instance a été arrêtée. Aucun secret local, `.env` privé ni donnée applicative de l’utilisateur n’a été modifié.

Ne sont pas vérifiés : charge distribuée, TLS public, certificats PostgreSQL distants, reverse proxy déployé, protection anti-bruteforce, production mobile/E2EE. Le développement local ne recharge pas automatiquement les sources.

## Inventaire pour revue

Fichiers créés : `apps/api/server.mjs`, les onze modules `apps/api/src/http/*.ts` décrits plus haut, `apps/api/tests/http.test.ts`, `apps/api/tests/http-postgres.test.ts` et ce document.

Fichiers modifiés : `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/.env.example`, `pnpm-lock.yaml`, `apps/api/src/postgres-session-repository.ts`, `apps/api/tests/postgres-session-repository.test.ts`, `apps/api/tests/postgres-test-database.ts`, `docs/architecture/architecture-overview.md`, `docs/development/current-milestone.md` et `docs/development/initial-device-bootstrap.md`. Aucun schéma ni migration Prisma modifié.

Les changements restent non commités pour revue. Commit suggéré : `feat(api): add NestJS HTTP foundation and current-session authentication`.
