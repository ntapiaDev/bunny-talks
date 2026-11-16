# Inscription HTTP et vérification e-mail — jalon 4.4C2A

Implémentation locale pour revue critique. Aucun commit, aucune connexion HTTP ni création de session ajoutée. **4.4C2B n’est pas commencé.** L’inscription est désactivée par défaut ; ses deux routes répondent alors `503 SERVICE_UNAVAILABLE` aux corps valides. Ne pas activer une instance publique avant les qualifications d’exploitation décrites ci-dessous. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

## Audit initial

La base 4.4C1 bis possède un propriétaire Prisma/pool unique (`DatabaseModule`), un guard global de session, une exemption publique explicite, des politiques d’entrée attachées aux routes, un filtre assaini et des tests HTTP réels. Les options Express seules ne suffisent pas à imposer la casse et les slashs aux routeurs déjà créés par Nest. Les comportements historiques de `/health/live` et `/v1/session` sont donc conservés ; les nouvelles routes utilisent une politique exacte commune.

`PostgresEmailRegistration` possède déjà la canonicalisation partagée, les preuves opaques `e1`, l’expiration de 30 minutes, le contrôle obligatoire de compromission, Argon2id natif borné et une finalisation transactionnelle avec reçu durable. La demande interne historique crée toutefois une intention par appel, même pour une identité existante. Elle ne constitue pas seule une capacité publique sûre. Les adaptateurs de livraison et de compromission n’ont pas d’implémentation de production avant ce jalon.

Les migrations historiques, les primitives de session/réauthentification/amorçage et les formats cryptographiques restent inchangés. Les modèles de budget et de bail sont ajoutés par `20261116000000_registration_http_limits` ; une migration appliquée ne doit pas être réécrite.

## Contrats HTTP

| Route                                 | Corps JSON strict                                                                    | Succès                                |
| ------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| `POST /v1/auth/registration/request`  | `{ "email": "Alice@example.com" }`                                                   | `202 { "status": "accepted" }`        |
| `POST /v1/auth/registration/complete` | `{ "email": "Alice@example.com", "token": "e1.<uuid>.<secret>", "password": "..." }` | `200 { "status": "account-created" }` |

Aucun jeton, reçu interne, `accountId`, cookie, session ou appareil dans ces réponses. `account-created` constate l’existence du compte vérifié et du vérificateur Argon2id. Il ne signifie ni connexion, ni autorisation d’appareil, ni publication ou ouverture du coffre.

Les schémas Zod partagés refusent les champs supplémentaires et les types incorrects. Le jeton est borné à 128 caractères, le mot de passe à 1 024 unités UTF-16 au transport, puis à **1 024 octets UTF-8 et au moins 15 points de code** par la politique existante. La borne de transport n’exclut aucun mot de passe valide selon cette politique. Aucun trim, normalisation Unicode ou changement de casse du mot de passe. Un surrogate isolé est refusé par l’encodeur existant.

La limite JSON reste 8 Kio, y compris en flux. Pas de compression ni de corps sans type approprié. Les erreurs de validation ne sérialisent jamais les détails Zod ni les valeurs reçues. Les routes exactes refusent les paramètres de requête (`400`), les variantes de casse, slash final ou encodage de chemin (`404`), et les méthodes autres que POST (`405`, `Allow: POST`), notamment GET, HEAD et OPTIONS. Aucune preuve n’est consommée par GET. Les erreurs de parsing précèdent la politique de chemin/méthode, comme dans la fondation existante. Les autres routes conservent leur politique historique. Les réponses portent `no-store`, sans CORS ouvert ; la confiance proxy reste désactivée.

## Composition et frontières

`AppModule` transmet la même instance de `DatabaseModule` à `SessionModule` et `RegistrationModule`. Ce dernier ne crée pas de client ni de pool et n’exporte aucune capacité privilégiée.

- `RegistrationController` valide le transport avec Zod et utilise exclusivement `RegistrationHttpService`.
- `RegistrationHttpService` compose les budgets, les baux, la disponibilité indépendante de l’adresse, la temporisation et la projection publique. Il utilise l’adresse de socket, jamais `X-Forwarded-For`.
- `PostgresEmailRegistration` conserve la création d’intention et la finalisation. Avec la protection injectée par le module HTTP, l’admission par adresse et l’insertion sont atomiques ; le budget de calcul est vérifié avant Argon2id. Les anciens appels internes restent compatibles, sans prétendre être protégés contre un appelant public.
- `PostgresRegistrationLimits` porte les compteurs et baux partagés, leur coordination et le nettoyage borné.
- `SmtpRegistrationEmail` et `PwnedPasswords` implémentent les ports existants. La sonde SMTP facultative du port historique est exigée par la composition HTTP ; son absence échoue explicitement.

Il n’y a ni nouveau découpage systématique en quatre couches, ni repository exporté au contrôleur, ni nouvelle primitive cryptographique. Les règles de mot de passe restent indépendantes de Nest et d’Express.

## Transport réel SMTP

Nodemailer **10.6.0** est la seule nouvelle dépendance d’exécution. Le serveur SMTP **3.21.6** est une dépendance de développement réservée aux tests. Ces versions fournissent leurs propres déclarations TypeScript ; aucune dépendance `@types` supplémentaire n’est nécessaire.

Le transport impose TLS avec validation du certificat et TLS 1.2 minimum : TLS implicite par défaut, ou STARTTLS obligatoire lorsque `REGISTRATION_SMTP_SECURE=false`. Aucun mode SMTP en clair, certificat ignoré, transport console, JSON ou boîte de développement n’est proposé. L’expéditeur et l’enveloppe viennent exclusivement de la configuration serveur. Un message contient la preuve et sa date d’expiration, jamais le mot de passe. Les accès aux fichiers et URL sont interdits, les logs et le debug SMTP désactivés.

Le message demande de copier la preuve dans Bunny Talks. **Aucune URL n’est produite** : ni origine dérivée de Host, ni endpoint GET de consommation, ni interface mobile. Une intégration future de liens devra choisir une origine approuvée et protéger fragment, logs et navigation.

Chaque demande admise effectue la même sonde de connexion/authentification, avant toute décision dépendant de l’adresse. L’API publique documentée `SMTPConnection` permet de fermer effectivement la sonde à son délai total ; `sendMail` utilise un `AbortSignal` qui ferme la connexion d’envoi dans la version installée. Les délais DNS, connexion, bannière et socket sont également bornés. Le code public et les types installés ont été examinés ; aucun accès à une propriété privée Nodemailer n’est utilisé.

Références : [transport SMTP](https://nodemailer.com/smtp), [API SMTPConnection](https://nodemailer.com/extras/smtp-connection), [options des messages et annulation](https://nodemailer.com/message).

## Acceptation, indisponibilité et anti-énumération

`accepted` signifie qu’une demande a été traitée et, si elle est éligible, admise durablement. Cette sémantique ne garantit **ni envoi ni réception**. Pour une adresse déjà inscrite, en attente ou limitée par adresse, aucune nouvelle preuve n’est envoyée, et le même `202` est retourné. Aucune variante fournie par le demandeur ne sert de destination lorsque la clé canonique possède déjà une identité vérifiée.

Une erreur de configuration empêche l’activation. Une sonde SMTP indisponible produit `503 DELIVERY_UNAVAILABLE` indépendamment de l’existence de l’adresse. Une erreur de base avant admission est distinguée d’un résultat d’écriture incertain.

Après une insertion durable, une erreur SMTP peut survenir avant ou après acceptation de DATA. La réponse reste `202 accepted`, sans affirmer une livraison ; rendre ici un `503` uniquement pour les adresses inconnues créerait un oracle d’existence. L’intention et ses quotas sont conservés. Aucun réenvoi automatique, aucune preuve en clair persistée et aucun outbox complet n’ont été ajoutés. Un crash entre commit et envoi peut donc laisser une intention non livrée : une nouvelle demande éligible devient possible après son expiration de 30 minutes et sous les quotas. Cette disponibilité limitée est un choix explicite de ce contrat d’acceptation ; si la livraison reprise après crash devient une exigence, il faudra concevoir séparément une file durable et la protection de son secret, au lieu de promettre cette garantie ici.

La partie dépendant de l’adresse est temporisée jusqu’à `2 × délai SMTP + 2 000 ms`, plus un aléa de 0 à 100 ms : **6 secondes par défaut**. Le nettoyage, les quotas par source et l’acquisition du bail précèdent cette partie et ne consultent pas l’identité. Le bail reste occupé durant l’attente pour borner le nombre de requêtes suspendues. Un budget par adresse ne produit jamais un `429` observable ; les `429` publics concernent la source, les présentations de preuve, les budgets globaux ou la concurrence.

Les tests comparent les codes/corps des cas inconnu, existant, en attente, limité et SMTP incertain, et contrôlent localement le plancher de durée. Ils ne prouvent pas l’indiscernabilité statistique sous charge, panne ou pause du processus. La temporisation ne protège pas contre toutes les attaques de corrélation ni contre un administrateur de base ou fournisseur SMTP malveillant.

## Contrôle des mots de passe compromis

`PwnedPasswords` utilise le client fetch natif de Node. Seuls les **cinq premiers caractères hexadécimaux SHA-1** du mot de passe exact sont transmis en HTTPS à une origine fixe. La comparaison du suffixe entier se fait localement. SHA-1 est ici le format de l’API de recherche, jamais un vérificateur de mot de passe stocké.

La requête demande `Add-Padding: true`, refuse les redirections et possède un délai total de deux secondes. La lecture du flux est bornée à 128 Kio ; les réponses non 200, trop courtes, malformées, tronquées détectables, dupliquées ou trop grandes échouent fermées. Les entrées de remplissage de compteur nul ne constituent pas une compromission. Ni mot de passe ni empreinte complète ne sont journalisés. Une sonde réelle avec une valeur publique de démonstration a révélé des plages valides de plus de 2 000 lignes ; le plafond initial de lignes a été retiré et remplacé par la seule borne en octets, avec un test de régression. La sonde réelle réussit après correction. L’adaptateur ne fait pas de recherche incrémentale pendant la saisie et ne conserve pas de cache de mots de passe.

Le minimum provisoire de 15 points de code, la borne UTF-8 et l’absence de normalisation restent inchangés. Une dépendance de disponibilité au service distant demeure ; il n’existe aucun corpus miniature de repli. La k-anonymité réduit les données transmises sans masquer le préfixe, l’adresse du serveur ou le moment de la requête au fournisseur. Référence et attribution : [Have I Been Pwned — Pwned Passwords](https://haveibeenpwned.com/API/v3#PwnedPasswords).

## Anti-abus PostgreSQL

Tous les écrivains HTTP utilisent le même PostgreSQL et une clé HMAC serveur partagée. Les clés de compteurs sont des HMAC-SHA-256 avec séparation par portée, sans adresse e-mail, IP ou jeton en clair. Une rotation de clé réinitialise les budgets observables : elle doit être coordonnée, jamais utilisée comme réinitialisation de quota ordinaire.

| Budget par défaut                      | Fenêtre / portée       | Comportement                                                                                          |
| -------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| 10 demandes par source                 | 1 heure                | `429` avant SMTP et intention                                                                         |
| 300 demandes globales                  | 1 minute               | borne aussi la création de clés de compteurs                                                          |
| 3 admissions par adresse canonique     | 1 heure                | suppression silencieuse, incluant les réservations sans envoi                                         |
| 1 admission par adresse canonique      | 60 secondes            | suppression silencieuse ; une intention active empêche aussi tout nouvel envoi pendant ses 30 minutes |
| 20 finalisations par source            | 1 minute               | tous les essais, même preuve malformée                                                                |
| 10 présentations par UUID de preuve    | 30 minutes             | tous les essais, valides et invalides, entre sources et instances                                     |
| 100 présentations globales             | 1 minute               | `5 × budget de calcul`, avant allocation d’une clé de source/preuve                                   |
| 20 démarrages Argon2id                 | 1 minute, global       | après preuve et politique valides, avant calcul                                                       |
| 16 demandes / 2 finalisations en cours | ensemble des instances | baux PostgreSQL, aucune file d’attente applicative illimitée                                          |

Les alias spécifiques aux fournisseurs, notamment les suffixes `+`, restent des identités distinctes : les quotas par adresse canonique ne constituent pas un quota universel par boîte physique. Les budgets par source et globaux complètent cette limite sans modifier la décision de canonicalisation.

Les quotas par source portent sur les corps conformes aux schémas de transport. Le parsing et le rejet des entrées malformées restent bornés à 8 Kio mais doivent aussi être protégés par la limitation générale d’entrée de l’hébergement. Les présentations malformées acceptées comme chaîne de preuve consomment bien le quota de finalisation par source.

Les fenêtres sont ancrées au premier événement, avec remise à zéro atomique à expiration. Un `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING` décide l’admission sous concurrence. Les consommations partielles de budgets sont conservées lorsque la requête est refusée. L’ordre global puis source borne le stockage d’IP ou UUID aléatoires. Les opérations dépendantes de l’adresse partagent la même transaction que l’insertion ; il n’y a pas de contrôle préalable non atomique permettant un envoi concurrent supplémentaire.

Les baux sont admis sous un verrou consultatif transactionnel fixe, détenu seulement quelques instructions. Aucun réseau, Argon2id ou sommeil sous transaction/verrou. Ils expirent après 60 secondes pour récupérer un processus mort. La primitive Argon2id garde aussi sa limite locale de deux calculs. Un processus suspendu au-delà du bail peut reprendre après expiration ; le bail **n’est pas une preuve d’un plafond physique absolu des calculs actifs** dans ce cas. Le budget global des démarrages reste distinct. Avant exposition, mesurer les pauses et délais, dimensionner le déploiement et empêcher la reprise d’un processus ayant perdu son bail si l’exploitation exige un plafond physique strict.

Les transactions de budgets bornent l’attente de verrou à 500 ms, l’instruction à 1 s, l’acquisition de transaction à 500 ms et la transaction à 1,5 s. Une panne de ce mécanisme ferme l’accès avec `503`, sans repli en mémoire. PostgreSQL peut devenir un point de contention ou d’épuisement de connexions ; ces quotas ne remplacent pas une protection réseau contre le déni de service distribué.

## Intention, transaction et reprise

La canonicalisation existante est réutilisée sans duplication : clé insensible à toute casse ASCII, adresse originale conservée, points et suffixes `+` significatifs, Unicode refusé en V1. La destination de vérification est l’adresse exacte admise, pas une variante d’une identité existante. Le serveur SMTP peut normaliser la casse DNS du domaine ; la partie locale et la valeur applicative conservée restent distinctes de la clé de comparaison.

La finalisation reste celle de 4.4A : contrôle de la preuve, politique et Argon2id hors transaction, puis verrou de l’intention, relecture, expiration, index unique canonique, compte, identité, vérificateur et reçu dans un commit. Les collisions ne laissent pas de compte partiel. Un échec de commit ou du pilote ne prouve pas un rollback : `OUTCOME_UNKNOWN` demande de rejouer la même adresse et la même preuve.

Après réponse perdue, répéter exactement le POST de finalisation retourne le même `200 account-created`, y compris après redémarrage et expiration de la preuve consommée, sous réserve des quotas. Le reçu durable est lu avant tout nouveau contrôle de mot de passe ou calcul. Un autre mot de passe dans un rejeu ne le modifie pas et ne l’authentifie pas ; ce comportement historique n’est pas un changement de mot de passe. Aucun reçu n’est une capacité de connexion ou d’amorçage.

Le nettoyage coopératif supprime au plus 100 lignes par table et par demande admise par source : compteurs périmés depuis plus d’une heure, baux expirés et intentions **non consommées** expirées depuis plus de 24 heures. `FOR UPDATE SKIP LOCKED` évite les lignes en cours de traitement. Les intentions encore valides et les expirations récentes sont conservées ; **aucun reçu consommé n’est purgé**. Sans trafic, le nettoyage n’avance pas. Une politique de conservation définitive des reçus et une planification d’entretien opérationnelle restent à établir sans casser la reprise autorisée.

## Erreurs publiques

Toutes les réponses sont `{ "error": { "code": "..." } }`, sans détail Prisma, SMTP, Argon2id, Zod ni secret.

| Statut    | Code                                           | Signification                                                                                          |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 400       | `BAD_REQUEST`                                  | corps, types, champs ou requête malformés                                                              |
| 400       | `INVALID_VERIFICATION`                         | preuve incorrecte, expirée, autre adresse ou collision métier ; aucune indication publique d’existence |
| 404 / 405 | `NOT_FOUND` / `METHOD_NOT_ALLOWED`             | chemin / méthode refusé                                                                                |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | transport refusé                                                                                       |
| 422       | `PASSWORD_REJECTED`                            | politique ou compromission refusant le nouveau secret                                                  |
| 429       | `TOO_MANY_REQUESTS`                            | source, preuve, calcul ou concurrence limités                                                          |
| 503       | `DELIVERY_UNAVAILABLE`                         | disponibilité SMTP indépendante de l’adresse, avant admission                                          |
| 503       | `PASSWORD_CHECK_UNAVAILABLE`                   | contrôle de compromission indisponible, échec fermé                                                    |
| 503       | `SERVICE_UNAVAILABLE`                          | inscription désactivée, budgets/base ou ressource cryptographique indisponibles                        |
| 503       | `OUTCOME_UNKNOWN`                              | résultat d’écriture incertain ; rejouer le POST exact, sans supposer un échec de création              |
| 500       | `INTERNAL_ERROR`                               | autre erreur assainie, sans réflexion de son contenu                                                   |

Un échec SMTP après admission n’est pas une erreur publique de livraison : l’accusé `accepted` reste celui de la demande. Le client ne doit jamais l’afficher comme un e-mail livré.

## Configuration et exploitation

Voir `apps/api/.env.example`. `REGISTRATION_ENABLED=true` exige un hôte SMTP, un port valide, des identifiants non vides, une adresse d’expéditeur ASCII valide et `REGISTRATION_HMAC_KEY` contenant 32 octets aléatoires hexadécimaux minuscules. La configuration invalide échoue avant création de l’application, sans afficher de valeur. Avec l’inscription désactivée, les routes historiques restent utilisables et aucune sonde SMTP n’est faite.

Toutes les limites du tableau sont configurables par les variables `REGISTRATION_*` de l’exemple. Les bornes empêchent notamment un cooldown inférieur à 60 s, plus de deux finalisations concurrentes et un délai SMTP supérieur à 3 s. Le plancher de réponse est dérivé de ce délai, sans option d’environnement pour le supprimer. Les tests peuvent construire une composition explicite avec adaptateurs rapides et plancher raccourci ; aucun sélecteur de fixture n’existe dans le serveur.

Avant exposition publique : TLS d’entrée et protection générale des requêtes, déploiement/migration coordonnés, secret HMAC identique entre instances, protection des secrets SMTP, qualification du fournisseur réel et de sa délivrabilité, SPF/DKIM/DMARC appropriés, surveillance assainie de disponibilité, métriques de charge et pauses de processus, restauration de PostgreSQL, entretien/rétention et tests de charge. L’acceptation sans garantie de livraison doit être reflétée dans l’UX. Aucun fournisseur de production n’a été configuré et aucun e-mail réel n’a été envoyé à une boîte externe pendant les tests.

## Vérifications et revue

Les suites restent séparées : unitaires dans `pnpm test`, PostgreSQL dans `test:persistence`, Nest HTTP/SMTP/ESM dans `test:http`. Les fixtures conservent les garde-fous localhost, base `bunny_talks_test`, PostgreSQL 18.7 et schéma aléatoire exclusivement supprimable. Les premières tentatives ont échoué parce que le bac à sable bloquait le réseau puis parce qu’aucun serveur n’était lancé ; une instance 18.7 temporaire a été compilée depuis les sources officielles vérifiées par SHA-256, sans modification du `.env` privé.

Les résultats finaux exécutés sont consignés en fin de ce document. Les tests de timing contrôlent un plancher local, pas une absence universelle d’énumération. La qualification SMTP utilise un serveur local et une autorité de test approuvée explicitement ; elle ne désactive jamais TLS ni la validation de certificat.

Points de revue prioritaires : sémantique `202` après SMTP incertain, consommation atomique des budgets, suppression des demandes pour identités/pending, baux et pauses au-delà de 60 s, politique exacte des chemins, erreurs sans secrets, reprise sans authentification, conservation des reçus.

Alternatives écartées : Redis uniquement pour ce jalon (PostgreSQL suffit aux budgets partagés), compteurs mémoire (insuffisants entre instances), transport console (aucun envoi réel), SMTP développé à la main, corpus miniature ou ouverture en cas d’erreur, outbox avec preuve brute persistée (nécessiterait une nouvelle garantie et sa conception de sécurité), suppression de reçus à expiration (casserait la reprise).

Fichiers créés : les sept fichiers `src/auth/registration/{postgres-registration-limits,pwned-passwords,registration-config,registration-http.service,registration.controller,registration.module,smtp-registration-email}.ts`, la migration, `packages/validation/src/schemas/registration.schema.ts`, les nouveaux tests de schémas, `registration-http.test.ts`, `pwned-passwords.test.ts`, `postgres-registration-limits.test.ts`, `registration-postgres.test.ts`, `smtp-registration.test.ts`, le support `registration-fixture.ts` et ce document.

Fichiers modifiés : `app.module.ts`, `config.ts`, `postgres-email-registration.ts`, `registration-policy.ts`, `shared/http/{http-policy,http-error-filter}.ts`, le schéma Prisma, `apps/api/{package.json,.env.example}`, `pnpm-lock.yaml`, l’index validation, les tests d’architecture, le test HTTP historique (désactivation explicite et mesure de fermeture du pool isolée par PID) et les documents directement concernés par le jalon.

Préconditions de 4.4C2B : revue de 4.4C2A, contrat de connexion séparé, budgets adaptés à la vérification Argon2id et à l’énumération, réutilisation de la primitive de session validée, appareil initialement non autorisé et distinction stricte entre connexion et amorçage 4.4B. Aucun de ces endpoints n’est ajouté ici.

Commit recommandé : `feat(api): add protected HTTP email registration and verification`.

## Résultats de qualification — 16 novembre 2026

Environnement : Node 24.22.2, pnpm 10.34.9, NestJS 12.5.0, Prisma 7.10.1, PostgreSQL 18.7 temporaire sur loopback, schémas dédiés aléatoires. Aucun secret privé ni `.env` modifié. Le serveur temporaire est arrêté après la qualification.

| Vérification                 | Résultat                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                  | Réussi dans tous les workspaces concernés ; inclut les tests d’architecture et de répartition exhaustive des suites |
| `pnpm typecheck`             | Réussi, y compris mobile et tests API                                                                               |
| `pnpm lint`                  | Réussi                                                                                                              |
| `pnpm format:check`          | Réussi après formatage du lockfile généré par pnpm                                                                  |
| `pnpm -r --if-present build` | Réussi pour tous les packages ayant un build                                                                        |
| Prisma generate / validate   | Réussis ; migration appliquée uniquement aux schémas de qualification                                               |
| PostgreSQL réel              | **145 tests réussis dans 10 fichiers**                                                                              |
| HTTP / SMTP / ESM réels      | **79 tests réussis dans 4 fichiers**, dont 9 SMTP/ESM avec adaptateur réel                                          |
| Pwned Passwords réel         | Sonde réussie avec une valeur publique, sans mot de passe brut ni empreinte complète transmis                       |

Le premier passage HTTP global a identifié une mesure historique trop large : elle comptait tous les processus `bunny-talks-http` des suites parallèles. Le test occupe maintenant les huit places de son propre pool pour en identifier les PID, puis vérifie leur disparition après fermeture et l’unique appel à `$disconnect`. Aucune protection de production n’a été assouplie et aucun test n’a été retiré.

La qualification ESM importe tous les modules compilés, démarre le serveur historique compilé et démarre aussi une instance compilée avec le vrai adaptateur SMTP, une autorité locale de test et PostgreSQL. Cette dernière accepte la demande HTTP, soumet réellement le message SMTP, refuse une mauvaise preuve de finalisation, n’émet aucune sortie contenant les secrets et s’arrête proprement. Le fournisseur SMTP externe, la réception en boîte et les performances/indiscernabilité en production ne sont pas qualifiés.
