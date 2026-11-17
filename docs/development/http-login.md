# Connexion HTTP — Jalon 4.4C2B

Implémentation locale pour revue critique, sans commit ni démarrage du jalon suivant. Login désactivé par défaut et activation refusée en mode production. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

## Audit des primitives locales

- `auth/password-verifier.ts` : API existante `verifyPassword`, validation PHC avant appel natif, Argon2id v19, 19 456 Kio, deux passes, parallélisme un, limite locale de deux calculs. Aucun nouvel algorithme ni fournisseur cryptographique.
- `auth/sessions/` : token opaque `s1`, SHA-256 du secret, générateurs serveur, durée absolue de 30 jours et inactivité de sept jours, verrou `Account FOR UPDATE`, DTO et révocation réutilisés. L’ancien appel `createAfterAuthentication(accountId, deviceId?)` reste une capacité interne inchangée ; il n’est pas une preuve de mot de passe pour HTTP.
- `auth/registration/` : uniquement les principes de budgets distribués et les primitives de création de comptes dans les tests. Le login n’importe aucun service ni module d’inscription. La petite fonction SQL de compteur atomique est extraite dans `shared/database/postgres-budget.ts`, avec une liste fermée de deux tables ; aucune politique d’inscription n’est déplacée vers le login.
- `shared/database/` et `app.module.ts` : même instance de `DatabaseModule`, seul propriétaire du pool. Aucun client supplémentaire en production, aucun cycle de modules.
- `shared/http/` : guard global, déclaration publique explicite, politique d’entrée obligatoire, JSON borné à 8 Kio, refus de query et de champs inconnus, `no-store`, erreurs assainies, absence de CORS et confiance proxy désactivée conservés.
- Prisma et migrations : `EmailIdentity.canonical` unique et insensible à la casse ASCII de toute l’adresse ; `verifiedAt` obligatoire et fini. `PasswordCredential` conserve le PHC, une révision positive et un horodatage maintenu par trigger quand le PHC change. Les anciennes valeurs nulles de cet horodatage restent comparées exactement.
- Amorçage 4.4B : association historique immuable à l’appareil et aux reçus. Une connexion n’appelle ni cet amorçage ni le repository de coffre.

L’audit couvre les sources, contrats validation, migrations, suites HTTP/PostgreSQL, architecture et modèle de menaces locaux. Aucun comportement OpenE2EE n’est présumé ni modifié.

## Contrat HTTP final

`POST /v1/auth/login` reçoit exclusivement :

```json
{ "email": "Alice@example.com", "password": "mot de passe exact" }
```

Le schéma Zod partagé refuse les autres types et champs, notamment `accountId`, `deviceId`, `sessionId`, `authorizedAt`, `emailVerified`, `credentialRevision` et `sessionToken`. L’e-mail suit `canonicalizeLoginEmail` : ASCII, casse ignorée sur toute l’adresse, points et suffixes `+` significatifs, aucun trim. La recherche utilise exclusivement `EmailIdentity.canonical` ; `display` n’est jamais modifié.

Le mot de passe reste exactement celui reçu : aucun trim, changement de casse ou normalisation Unicode. Chaîne non vide, UTF-16 bien formé, maximum 1 024 octets UTF-8 selon les limites de l’encodeur existant. Le calcul de longueur dans validation reste indépendant de Node et des bibliothèques cryptographiques. Aucun minimum d’inscription n’est appliqué : un ancien mot de passe d’un caractère peut être vérifié.

Succès `201 Created` :

```json
{
  "sessionToken": "s1.<uuid>.<secret>",
  "session": {
    "accountId": "<uuid>",
    "sessionId": "<uuid>",
    "deviceId": "<uuid>",
    "deviceState": "pending",
    "expiresAt": "<ISO-8601>"
  }
}
```

DTO explicite, sans modèle Prisma, PHC, hash du token, mot de passe, coffre, preuve d’appareil ou statut OpenE2EE. Token présenté dans cette seule réponse, sans URL, cookie ni redirection. `GET /v1/session` permet ensuite sa lecture et `DELETE /v1/session` sa révocation.

Le chemin est exact : casse différente, slash final et encodage du chemin ne constituent pas des alias. `HEAD`, `GET`, `OPTIONS`, `DELETE`, `PUT` et `PATCH` sont refusés avec `405` et `Allow: POST`. Les query strings sont refusées. Les protections de transport des jalons précédents restent applicables.

| Statut    | Code                                           | Cas                                                                                                  |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 400       | `BAD_REQUEST`                                  | Validation ou query refusée                                                                          |
| 401       | `UNAUTHORIZED`                                 | Identifiants incorrects, absents, non éligibles, PHC absent/inutilisable ou credential devenu périmé |
| 404 / 405 | `NOT_FOUND` / `METHOD_NOT_ALLOWED`             | Chemin/méthode refusés                                                                               |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | Transport refusé                                                                                     |
| 429       | `TOO_MANY_REQUESTS`                            | Quota ou plafond de conservation atteint                                                             |
| 503       | `SERVICE_UNAVAILABLE`                          | Désactivation, saturation, bail perdu, fournisseur natif ou PostgreSQL indisponible                  |
| 503       | `OUTCOME_UNKNOWN`                              | Résultat de la transaction inconnu                                                                   |

Les réponses d’erreur sont exclusivement `{ "error": { "code": "..." } }`. `BUSY`, `CRYPTO_UNAVAILABLE`, `UNAVAILABLE` et `OUTCOME_UNKNOWN` restent distincts en interne, sans exposer d’erreur du pilote ou de l’implémentation native. Un PHC invalide est traité par substitution puis `401`, pas par une erreur publique révélant l’état du compte. Aucun corps d’authentification ni secret n’est journalisé par l’application.

## Vérification et anti-énumération

Après admission indépendante de l’existence du compte, `PostgresLoginCredentials` lit l’identité vérifiée et son credential. Un compte sans identité, une intention d’inscription ou un reçu de finalisation ne prouvent rien. L’identité vérifiée et le credential sont indispensables.

`VerifiedLogin.verify` photographie les marqueurs avant l’attente native, puis appelle strictement `verifyPassword`. Pour une identité absente ou un credential inutilisable, il effectue exactement une vérification avec un PHC de substitution valide au profil actuel. Ce PHC a été généré une fois avec `createPasswordVerifier` et un mot de passe public de fixture ; il ne coûte aucun nouveau hachage de génération par requête. Même un résultat de comparaison positif sur ce PHC ne crée jamais de contexte authentifié. Un changement futur du profil exige de renouveler et retester ce vérificateur.

Une comparaison incorrecte, un compte absent et un PHC inutilisable exécutent donc chacun un calcul du même profil, puis retournent le même `401`. Il reste des différences de requêtes PostgreSQL, de parsing, de charge et de planification. Une requête limitée s’arrête avant lecture du compte et Argon2id, avec `429` : cette différence est volontaire et ne dépend pas de l’existence de l’adresse. Le quota par e-mail révèle éventuellement de l’activité sur cette clé, pas une preuve d’existence. Aucun test ne démontre l’absence absolue d’oracle temporel.

La limite locale de deux calculs du fournisseur reste en place, y compris face à l’inscription ou la réauthentification dans le même processus. Elle peut refuser un calcul pourtant admis par le quota distribué du login ; la route retourne alors `503`, sans création et sans affaiblissement du fournisseur. Aucune file d’attente applicative illimitée, aucun sommeil de substitution et aucune ouverture en cas de panne.

## Revalidation et transaction

`LoginService` orchestre les quotas, la lecture, la comparaison native hors transaction et la création. `VerifiedLogin`, partagé dans `auth/verified-login.ts`, possède une photographie immuable enregistrée dans une `WeakMap` privée au module uniquement après comparaison réussie d’un vrai credential. `requireVerifiedLogin` contrôle cette provenance à l’exécution, indépendamment du constructeur TypeScript et du prototype ; le repository utilise exclusivement la photographie enregistrée. Le contrôleur ne reçoit ni ne fabrique ce contexte.

`PostgresSessionRepository.createAfterLogin` compose la même implémentation privée de création que `createAfterAuthentication`. Dans une seule transaction `ReadCommitted` :

1. `Account FOR UPDATE` et revalidation de son existence.
2. Relecture de l’identité et du credential, comparaison de la clé canonique et du `verifiedAt` exact, de la révision, du PHC exact et du `verifierUpdatedAt` exact ; refus d’une vérification e-mail située dans le futur.
3. Vérification et verrouillage du bail encore actif selon l’horloge PostgreSQL ; un propriétaire expiré ne publie pas de session.
4. Contrôle des plafonds de lignes conservées sous le même verrou de compte.
5. Insertion d’un nouvel appareil serveur, `authorizedAt = null`, puis de la session et du seul hash du secret ; commit atomique.

Les générateurs réutilisés produisent les identifiants et le token avant insertion. Aucun Argon2id, réseau ou transaction Prisma imbriquée sous le verrou. Délais existants : verrou 1 s, instruction 3 s, acquisition 2 s, transaction 5 s. Les écrivains de credential et de révocation applicatifs doivent respecter le même verrou `Account` ; les accès SQL administratifs hors protocole ne sont pas une API concurrente prise en charge.

Si un changement de mot de passe précède la revalidation, le résultat devient périmé et aucune session n’est créée. S’il suit le commit, le login a précédé ce changement ; la décision produit existante conserve les autres sessions lors d’un changement ordinaire de mot de passe. Révocation d’un ancien appareil et login sur un nouvel appareil sont sérialisés sans réactivation de l’ancien. Une révocation n’interdit pas de futures connexions avec un mot de passe encore valide.

## Budgets et concurrence multi-instances

Clé dédiée `LOGIN_HMAC_KEY`, différente de `REGISTRATION_HMAC_KEY`, partagée par toutes les instances. Les clés sont des HMAC-SHA-256 séparés par `login-v1`, portée et valeur ; aucune IP, adresse ou mot de passe en clair dans les tables de quotas. Une rotation coordonnée réinitialise les budgets : ce n’est pas une opération ordinaire de déblocage.

| Paramètre                           | Défaut        | Bornes                                                   |
| ----------------------------------- | ------------- | -------------------------------------------------------- |
| `LOGIN_ENABLED`                     | `false`       | `true` / `false`                                         |
| `LOGIN_HMAC_KEY`                    | absent        | 32 octets hexadécimaux minuscules obligatoires si activé |
| `LOGIN_WINDOW_MS`                   | 60 000        | 1 000 à 3 600 000                                        |
| `LOGIN_LEASE_MS`                    | 60 000        | 10 000 à 120 000                                         |
| `LOGIN_REQUESTS_GLOBALLY`           | 300 / fenêtre | 1 à 10 000                                               |
| `LOGIN_REQUESTS_PER_SOURCE`         | 20 / fenêtre  | 1 à 1 000                                                |
| `LOGIN_REQUESTS_PER_EMAIL`          | 10 / fenêtre  | 1 à 100                                                  |
| `LOGIN_HASHES_PER_WINDOW`           | 30 / fenêtre  | 1 à 120                                                  |
| `LOGIN_CONCURRENCY`                 | 2             | 1 à 2                                                    |
| `LOGIN_MAXIMUM_RECORDS_PER_ACCOUNT` | 1 000         | 10 à 10 000                                              |

Ordre atomique : global, source, adresse canonique, calcul global ; les consommations partielles restent acquises si une étape refuse. La première limite borne la cardinalité des nouvelles clés. Le budget de calcul est une borne conservatrice des démarrages : une requête admise qui échoue ensuite à obtenir un bail consomme aussi ce budget. Les adresses absentes consomment les mêmes budgets. Fenêtres temporaires ancrées au premier événement, réouverture à expiration sans verrouillage du compte par les échecs.

Le compteur utilise `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING`. Les baux sont admis sous un verrou consultatif transactionnel fixe, distinct de l’inscription. Aucune transaction n’est conservée pendant le calcul. Transactions de quotas bornées : verrou 500 ms, instruction 1 s, acquisition 500 ms, transaction 1,5 s. Une panne ferme l’accès sans repli mémoire.

La source est `request.socket.remoteAddress`. `X-Forwarded-For` n’est pas une autorité et `trust proxy` reste désactivé. NAT et proxy concentrent les utilisateurs ; IPv6 et rotation d’IP permettent de répartir les essais. Ces quotas ne remplacent pas les limites d’entrée de l’hébergement ; les corps malformés sont bornés par le transport mais ne consomment pas les budgets applicatifs.

### Expiration et limite physique

Un bail expire pour récupérer un propriétaire mort et sa libération est tentée dans `finally`, sans transformer une réussite commitée en échec. Les baux expirés sont nettoyés par lots. Un processus suspendu au-delà du délai peut toutefois reprendre un calcul natif alors qu’un autre occupe sa place : **le plafond physique absolu des calculs actifs n’est pas garanti**. Le propriétaire expiré ne peut plus créer de session, mais cela n’annule pas le calcul natif déjà engagé. Le plafond concerne le login, pas les autres parcours cryptographiques entre instances.

En conséquence, `readLoginConfig` et la composition `AppModule` refusent le login activé en `production`, y compris si une configuration typée est construite directement. Avant production : qualification des pauses et charges, isolation ou arrêt garanti d’un propriétaire ayant perdu son bail, ou mécanisme d’exécution renforcé approuvé. Aucun heartbeat ou délai arbitraire n’est présenté comme une preuve de cette garantie.

## Appareils, conservation et réponse perdue

Chaque succès crée un nouvel appareil `pending`, même pour le même téléphone après perte de session. Aucun identifiant client n’est repris, aucun appareil révoqué réactivé, aucun ancien appareil autorisé réutilisé. La limite de cinq appareils de confiance est indépendante de ces connexions. Aucun coffre, secret ou identité E2EE n’est téléchargé ou modifié.

Le plafond par compte inclut **toutes** les sessions et tous les appareils conservés, y compris ceux créés auparavant par les primitives internes, expirés, révoqués ou sans session active. Le login refuse si l’une des deux populations atteint le plafond. Ce choix conservateur borne les créations successives, les réponses perdues et les essais avec mot de passe compromis. Des identifiants compromis peuvent épuiser cette capacité : c’est une limite de disponibilité explicite, distincte des fenêtres d’échecs. Les opérations internes historiques ne deviennent pas implicitement soumises à ce plafond HTTP.

**Aucune session ni aucun appareil n’est automatiquement supprimé.** Le nettoyage ne touche que 100 compteurs expirés depuis plus d’une heure et 100 baux expirés par requête admise. Les reçus, opérations d’amorçage, grants et preuves historiques restent intacts ; les contraintes de référence ne sont pas contournées. Les sessions expirent et deviennent inutilisables sans suppression de leurs traces. La politique de conservation définitive et une procédure de purge auditable restent à décider avant production ; atteindre le plafond nécessite une intervention après revue, pas une suppression silencieuse. Sans trafic, le nettoyage coopératif n’avance pas.

Un commit peut réussir malgré une réponse réseau perdue ou un résultat du pilote inconnu. `OUTCOME_UNKNOWN` ne signifie pas rollback. Le token initial n’est pas récupérable depuis son hash et n’est jamais reconstruit. Une nouvelle tentative revérifie le mot de passe et peut créer une nouvelle session et un nouvel appareil, sous quotas et plafonds ; elle ne renvoie pas la session initiale. Aucun token brut persistant, coffre serveur de tokens ou protocole d’idempotence ajouté.

## Organisation et migration

- Composants de connexion : les six fichiers `apps/api/src/auth/login/{login-config,login.controller,login.module,login.service,postgres-login-credentials,postgres-login-limits}.ts`. Les deux contrats partagés se trouvent désormais dans `auth/{authentication-error,verified-login}.ts` après la revue corrective décrite ci-dessous.
- Primitive partagée : `shared/database/postgres-budget.ts` ; compteur d’inscription redirigé vers cette fonction, politique et table historiques conservées.
- Composition modifiée : `app.module.ts`, `config.ts`, filtre HTTP et repository de sessions. Le contrôleur dépend seulement de `LoginService`, pas de Prisma. `SessionHttpService` garde sa capacité de lecture/révocation.
- Validation : nouveau schéma et export dans `packages/validation`, sans dépendance ni package supplémentaire.
- Migration additive `20261117000000_login_http_limits` : `LoginBudget` et `LoginLease`, index d’expiration et contraintes de compteurs ; aucune réécriture d’identité, credential, session ou appareil existant.
- Configuration documentée dans `.env.example` uniquement ; aucun `.env` privé modifié.
- Tests : validation, unitaires login et natif, architecture, support d’inscription de comptes, PostgreSQL login, HTTP/ESM login. L’ancien test d’absence de route de login est remplacé par le contrat désactivé de cette route déclarée.

Alternatives écartées : appel direct de `createAfterAuthentication` après comparaison (ne lie pas le PHC), duplication de création de session (deux invariants à maintenir), Argon2id sous verrou (contention et déni de service), compteurs mémoire (instances divergentes), Redis et nouveau moteur générique (inutiles ici), purge automatique (rétention/audit non décidés), reprise d’un `deviceId` présenté (aucune preuve), token récupérable côté serveur (nouveau risque et protocole hors périmètre).

## Futur mobile et exposition publique

Le mobile devra utiliser HTTPS, un stockage natif sécurisé des tokens et une UX tenant compte des réponses perdues, quotas et appareils abandonnés. Perdre une session sur le même téléphone ne prouve pas une nouvelle possession de son ancien appareil : le protocole indépendant de reconnexion reste à concevoir.

Le premier appareil utilisera ultérieurement l’exposition HTTP de l’amorçage 4.4B : session valide, mot de passe revérifié et publication initiale atomique, sans ancienne association d’amorçage réussie. Aucun endpoint correspondant n’est livré ici. Les appareils supplémentaires nécessitent leur parcours renforcé distinct avec approbation e-mail. `pending` ne donne accès qu’aux opérations explicitement permises ; `authorizedAt` ne prouve pas la possession E2EE.

Avant exposition publique : garantie d’exécution/concurrence renforcée, TLS et proxy approuvés, protection réseau générale, supervision assainie des refus et pannes, rétention auditable, maintenance planifiée, tests de charge et de distribution temporelle, revue de sécurité et fermeture des prérequis cryptographiques applicables. Les tests locaux ne qualifient pas ces conditions.

## Qualification et revue

Résultats de qualification consignés ci-dessous. Les tests PostgreSQL et HTTP conservent les protections localhost, base `bunny_talks_test`, PostgreSQL 18.7 exact et schémas aléatoires supprimables exclusivement. Les comptes de test passent par l’inscription vérifiée existante ; aucun contournement de production n’est ajouté.

Revue prioritaire : photographie immuable avant Argon2id, revalidation PHC/révision/horodatage sous verrou, création commune des sessions, consommation et séparation des budgets, perte de bail, plafond des lignes conservées, sémantique de commit inconnu, absence de privilège E2EE et refus d’activation en production.

Commit recommandé : `feat(api): add guarded HTTP login with pending-device sessions`.

## Résultats exécutés — 17 novembre 2026

Environnement : Node 24.22.2, pnpm 10.34.9, PostgreSQL 18.7 temporaire compilé depuis les sources officielles après vérification du SHA-256, sur loopback. Bison, flex et m4 ont été extraits dans `/tmp` uniquement pour cette compilation ; aucune dépendance du projet ni installation système ajoutée. Les restrictions initiales de réseau ont nécessité l’exécution autorisée des tests hors bac à sable. Aucun secret privé ni `.env` modifié.

| Vérification                 | Résultat                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                  | Réussi dans tous les workspaces concernés, incluant les nouveaux tests validation/login natif, les erreurs et l’architecture |
| `pnpm typecheck`             | Réussi, API, tests, packages et mobile                                                                                       |
| `pnpm lint`                  | Réussi                                                                                                                       |
| `pnpm format:check`          | Réussi                                                                                                                       |
| `pnpm -r --if-present build` | Réussi                                                                                                                       |
| Prisma generate et validate  | Réussis ; nouvelle migration appliquée exclusivement aux schémas de test                                                     |
| `test:persistence`           | **165 tests réussis dans 11 fichiers**, dont 20 nouveaux scénarios login                                                     |
| `test:http`                  | **110 tests réussis dans cinq fichiers**, dont 31 scénarios login HTTP/ESM                                                   |
| Login HTTP ciblé             | **31 tests réussis**, incluant le serveur ESM compilé, deux instances réelles, absence de secrets et fermeture du pool       |
| `git diff --check`           | Réussi                                                                                                                       |

Les suites complètes PostgreSQL et HTTP ont aussi été exécutées en parallèle, avec leurs connexions et schémas indépendants. Les tests prouvent les limites de compteurs, l’admission concurrente des baux, leur expiration et le refus d’un ancien propriétaire, pas l’annulation physique de son travail natif. Les fautes natives sont injectées au point de vérification pour contrôler le transport ; les vrais calculs et la saturation locale du fournisseur sont couverts par les suites natives existantes. L’issue inconnue est simulée après un vrai commit, distinctement d’un rejet réel d’insertion avant commit.

Le premier passage HTTP a révélé une erreur de requête du test de fermeture : Prisma ne désérialise pas le type `void` de `pg_sleep`. Le test convertit maintenant cette colonne en texte et ferme son pool même en cas d’échec de la mesure ; aucun code de production n’a été affaibli.

Échantillon diagnostique HTTP isolé : mauvais mot de passe **101 ms**, adresse absente **68 ms**, credential absent **58 ms**, requête limitée **7 ms**. Un seul passage, avec effets possibles de chauffe et d’ordonnancement : ces valeurs ne constituent ni une distribution ni une preuve d’indiscernabilité. La requête limitée ne lit pas l’identité et n’effectue pas Argon2id. Des mesures statistiques sous charge restent nécessaires avant exposition.

Restent non qualifiés : environnement public, proxy/TLS d’entrée, plafond physique strict après longue suspension, purge auditable et rétention définitive, reconnexion à un appareil déjà autorisé, association renforcée, mobile et parcours E2EE complet. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. L’instance PostgreSQL temporaire est arrêtée à la fin de la qualification.

## Inventaire historique de l’implémentation initiale pour la revue

Fichiers créés :

- `apps/api/prisma/migrations/20261117000000_login_http_limits/migration.sql`
- `apps/api/src/auth/login/login-config.ts`
- `apps/api/src/auth/login/login-error.ts`
- `apps/api/src/auth/login/login.controller.ts`
- `apps/api/src/auth/login/login.module.ts`
- `apps/api/src/auth/login/login.service.ts`
- `apps/api/src/auth/login/postgres-login-credentials.ts`
- `apps/api/src/auth/login/postgres-login-limits.ts`
- `apps/api/src/auth/login/verified-login.ts`
- `apps/api/src/shared/database/postgres-budget.ts`
- `apps/api/tests/http/login-postgres.test.ts`
- `apps/api/tests/persistence/auth/postgres-login.test.ts`
- `apps/api/tests/support/login-fixture.ts`
- `apps/api/tests/unit/auth/login-native.test.ts`
- `apps/api/tests/unit/auth/login.test.ts`
- `docs/development/http-login.md`
- `packages/validation/src/schemas/login.schema.ts`
- `packages/validation/tests/login.schema.test.ts`

Fichiers modifiés :

- `apps/api/.env.example`
- `apps/api/prisma/schema.prisma`
- `apps/api/src/app.module.ts`
- `apps/api/src/auth/registration/postgres-registration-limits.ts`
- `apps/api/src/auth/sessions/postgres-session-repository.ts`
- `apps/api/src/config.ts`
- `apps/api/src/shared/http/http-error-filter.ts`
- `apps/api/tests/http/registration-postgres.test.ts`
- `apps/api/tests/unit/shared/architecture.test.ts`
- `docs/development/current-milestone.md`
- `packages/validation/src/index.ts`

## Revue corrective 4.4C2B — authenticité runtime et dépendances

La revue de l’implémentation initiale (`79dfa5b`) a identifié une garantie trop forte fondée sur le seul constructeur TypeScript `private`. Une fois compilé, un appel JavaScript direct pouvait instancier la classe ; un appel interne pouvait aussi présenter un objet doté d’un champ ou getter `credential` fabriqué. Le repository ne contrôlait pas cette provenance avant de relire le credential en base. Pour exploiter cette faiblesse, il fallait un accès interne capable de fournir les marqueurs exacts du credential, dont le PHC. Le contrôleur HTTP n’acceptait déjà ni preuve, ni PHC, ni `deviceId` : aucune exploitation directe par le JSON de login n’est démontrée. Cela ne justifiait pas de laisser la frontière interne sans contrôle runtime.

Le module partagé conserve maintenant une `WeakMap<object, LoginCredential>` inaccessible aux appelants. Seule la branche de `VerifiedLogin.verify` suivant une comparaison Argon2id réussie d’un vrai credential y inscrit la nouvelle instance. Le constructeur n’inscrit rien : une construction directe JavaScript, y compris via une sous-classe, ne donne aucune preuve authentique. `requireVerifiedLogin(unknown)` consulte exclusivement cette table d’identités ; ni `instanceof`, ni prototype, ni champ ou getter de l’objet reçu ne participe à la décision. Une copie, un objet structurel, `Object.create`, un prototype substitué ou un proxy restent absents de la table et sont refusés.

La photographie scalaire est figée avant l’attente Argon2id et conservée figée ; l’instance authentique est aussi gelée pour empêcher son remplacement de propriété ou de prototype. Le getter existant passe par le même contrôle. La `WeakMap` associe l’identité runtime à la photographie, ce qui évite de dépendre d’un getter même après un contrôle de marque. Les clés faibles ne maintiennent pas artificiellement les preuves en mémoire.

`PostgresSessionRepository.createAfterLogin` appelle ce lecteur avant tout accès PostgreSQL ou génération d’appareil/session, puis transmet la photographie immuable à sa création privée existante. Le compte est exclusivement celui de cette photographie ; aucun sélecteur de compte client n’est ajouté. Toutes les revalidations sous `Account FOR UPDATE` restent conservées : identité vérifiée, canonique, PHC exact, révision, horodatage, bail actif et plafonds. Une preuve authentique périmée est toujours refusée.

Déplacements justifiés :

- `auth/login/verified-login.ts` devient `auth/verified-login.ts` : preuve et photographie forment une frontière commune entre vérification du mot de passe et création de session, sans dépendre de Nest, PostgreSQL, du contrôleur ou des politiques de login.
- `auth/login/login-error.ts` devient `auth/authentication-error.ts`, avec `AuthenticationError` : les refus partagés par orchestration, quotas, repository et filtre HTTP appartiennent à cette même frontière. Les codes internes et leur mapping HTTP restent identiques.

Aucun module générique, nouvelle interface de repository ou duplication de création n’est introduit. Une `WeakSet` accompagnée d’une lecture de propriété laisserait cette lecture dépendre de l’objet ou de son prototype ; la `WeakMap` fournit directement les données authentifiées. Une signature, un token ou un chiffrement supplémentaire n’apporterait aucune garantie utile pour cette capacité locale.

Tests correctifs :

- Nouveau `tests/unit/auth/verified-login.test.ts` : véritable Argon2id correct/incorrect, immutabilité, six formes de fabrication, getter jamais consulté et refus de changement de prototype d’une preuve authentique.
- `tests/persistence/auth/postgres-login.test.ts` : six fabrications rejetées avant transaction, sans augmentation des lignes `Device`/`Session`, puis preuve authentique utilisable uniquement pour le compte photographié. Les tests existants de changement de PHC, révision et horodatage continuent à utiliser de vraies preuves.
- `tests/http/compiled-esm.test.mjs` : processus Node chargeant le JavaScript ESM compilé, comparaison native réelle, construction directe `new VerifiedLogin(...)`, sous-classe, objet fabriqué, prototype et proxy refusés avant accès au client de base. Le serveur compilé conserve également son test de vrai login HTTP avec PostgreSQL.
- Tests du contrôleur et HTTP : refus explicite des champs `credential`, `verified`, `verifier`, en plus de `deviceId` et des champs privilégiés déjà couverts.
- Tests d’architecture : aucun import de `auth/sessions` vers `auth/login`, contrats partagés indépendants des deux sous-domaines, contrôleurs sans import de preuve et graphe local toujours acyclique.

Limites : une capacité existe dans l’instance chargée du module et dans ce processus seulement ; sérialiser, cloner, transférer à un autre processus ou charger une autre instance du module ne transfère pas son authenticité. Elle n’est pas une protection contre du code arbitraire ayant compromis le processus ou remplacé le fournisseur de vérification. La lecture des credentials reste une responsabilité d’infrastructure de confiance et la revalidation PostgreSQL reste indispensable. Les preuves ne deviennent ni un protocole externe, ni des preuves de possession E2EE. Les limites initiales de production, de baux et de rétention restent inchangées ; SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

Résultats exécutés le 17 novembre 2026 sur Node 24.22.2, pnpm 10.34.9 et PostgreSQL 18.7 temporaire loopback :

| Vérification corrective                           | Résultat                                                        |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Tests ciblés unitaires et architecture            | 50 tests réussis dans quatre fichiers                           |
| Tests ciblés PostgreSQL login                     | 27 tests réussis                                                |
| `pnpm test`                                       | Réussi dans tous les workspaces concernés                       |
| Suite PostgreSQL complète                         | **172 tests réussis dans 11 fichiers**                          |
| Suite HTTP/SMTP/ESM complète                      | **114 tests réussis dans cinq fichiers**                        |
| `pnpm typecheck`                                  | Réussi, incluant les tests et le mobile                         |
| `pnpm lint` et `pnpm format:check`                | Réussis                                                         |
| `pnpm -r --if-present build`                      | Réussi                                                          |
| Imports ESM et test Node de fabrication de preuve | Réussis sur les fichiers compilés, sans ancien fichier résiduel |
| `git diff --check`                                | Réussi                                                          |

Les suites complètes PostgreSQL et HTTP ont été exécutées avec leurs schémas isolés et connexions indépendantes, sans modifier leurs garde-fous. Les contrôles PHC, révision et horodatage sous verrou restent couverts par les vrais calculs natifs ; les méthodes de vérification ne sont pas simulées dans les nouveaux tests de preuve. Aucune migration, règle de session, politique de quotas/baux, primitive Argon2id ou frontière E2EE modifiée. Aucun secret privé ni `.env` modifié.

Contrôle de fin : zéro schéma de test résiduel et zéro connexion applicative restante ; instance PostgreSQL temporaire arrêtée proprement. Aucun commit créé, aucun jalon suivant commencé ; attendre la revalidation.

Fichiers de la correction (les deux déplacements sont détaillés plus haut) :

- `apps/api/src/auth/authentication-error.ts`
- `apps/api/src/auth/login/login.service.ts`
- `apps/api/src/auth/login/postgres-login-credentials.ts`
- `apps/api/src/auth/login/postgres-login-limits.ts`
- `apps/api/src/auth/sessions/postgres-session-repository.ts`
- `apps/api/src/auth/verified-login.ts`
- `apps/api/src/shared/http/http-error-filter.ts`
- `apps/api/tests/http/compiled-esm.test.mjs`
- `apps/api/tests/http/login-postgres.test.ts`
- `apps/api/tests/persistence/auth/postgres-login.test.ts`
- `apps/api/tests/unit/auth/login-native.test.ts`
- `apps/api/tests/unit/auth/login.test.ts`
- `apps/api/tests/unit/auth/verified-login.test.ts`
- `apps/api/tests/unit/shared/architecture.test.ts`
- `docs/development/current-milestone.md`
- `docs/development/http-login.md`
