# Identité e-mail et inscription sécurisée — jalon 4.4A

**Actualisation 4.4C2A :** le [parcours HTTP d’inscription](http-email-registration.md) ajoute des adaptateurs réels SMTP/Pwned Passwords et des protections distribuées. Le présent document conserve les résultats et limites historiques de la primitive 4.4A.

Statut historique : jalon terminé et commité (`46d6681`), sans endpoint ni qualification de production. Aucun fournisseur d’e-mail ni corpus de mots de passe compromis de production n’est configuré. L’[amorçage 4.4B](initial-device-bootstrap.md) est désormais implémenté pour revue séparée. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

## Audit et décisions conservées

La base 4.3C possède un `Account.id` stable, un `PasswordCredential` révisionné, des sessions persistantes liées aux appareils et des grants transactionnels liés au réenveloppement exact du coffre. Elle ne possède aucun identifiant e-mail ni date de vérificateur. Les contraintes SQL complètent Prisma ; les tests utilisent des schémas PostgreSQL 18.7 aléatoires dans une base dédiée. Le schéma partagé `emailSchema` valide un format avec Zod sans canonicalisation.

Le compte reste accessible par e-mail et mot de passe. Ce même mot de passe ouvre localement le coffre V1 avec un traitement et un sel indépendants du vérificateur serveur. La clé de récupération reste indépendante. L’autorisation individuelle et l’amorçage du premier appareil restent distincts de la connexion. Aucune 2FA générale, aucun OPAQUE, aucun changement du format cryptographique V1.

Les documents produit et architecture évoquent aussi une autorisation ultérieure par e-mail liée à une demande d’appareil. La présente preuve d’inscription n’est pas cette preuve : aucun grant, droit d’appareil ou droit E2EE n’en découle.

## Modèle retenu et alternatives

- `EmailRegistration` : intention temporaire identifiée par UUID serveur, adresse déclarée, empreinte de preuve, dates d’émission/expiration. Après finalisation, la même ligne conserve le reçu historique et la consommation (`accountId`, `completedAt`). Une seule structure porte l’attente et le reçu ; aucun mot de passe ni PHC n’y est stocké.
- `EmailIdentity` : adresse vérifiée unique, forme d’affichage, date de vérification et relation un-à-un vers `Account`.
- `Account.id` : UUID aléatoire serveur pour les nouveaux comptes, indépendant de l’adresse. Le contrat historique ASCII de 1 à 128 caractères reste accepté pour les comptes existants.

Un `AuthIdentifier` générique ajoute une abstraction inutile avec un seul moyen de connexion prévu. Ajouter des champs d’attente et de vérification à `Account` créerait des comptes incomplets avant preuve et mélangerait adresse déclarée et identité vérifiée. Le modèle dédié évite ces deux problèmes. Un changement futur d’adresse modifiera l’identité de connexion via un parcours séparé, sans changer `Account.id` ni le contexte cryptographique. Les reçus gardent leur adresse historique ; ils n’imposent pas que l’adresse du compte reste identique à vie.

## Politique d’adresse V1

`loginEmailSchema` et `canonicalizeLoginEmail` complètent le schéma existant sans modifier son contrat. Le service applique toujours cette politique ; la fonction SQL `valid_login_email` en protège aussi les écritures persistées.

- Sous-ensemble ASCII accepté par le validateur Zod existant : partie locale non citée, lettres, chiffres, `_`, `+`, `-`, points séparateurs et apostrophes aux positions acceptées par ce validateur. Ni commentaires, ni adresses littérales IP.
- Longueur totale maximale : 254 octets/caractères ASCII ; partie locale : 64 ; labels DNS : 63. Domaine à plusieurs labels, labels sans tiret initial/final, dernier label alphabétique d’au moins deux caractères.
- Adresse entière convertie en minuscules ASCII pour la clé de comparaison. Forme d’affichage vérifiée conservée exactement. Aucune suppression de points, suffixes `+`, espaces ou autre réécriture.
- Unicode dans la partie locale ou le domaine, espaces et caractères de contrôle refusés explicitement. Aucune conversion IDNA implicite. Une représentation ASCII `xn--` respectant les règles précédentes peut être fournie ; les TLD punycode ne sont pas acceptés par le validateur actuel. SMTPUTF8 et prise en charge IDNA complète demanderaient une décision ultérieure.
- `EmailIdentity.canonical` possède un index unique PostgreSQL en collation `C`. La comparaison est déterministe et insensible à la casse ASCII sur toute l’adresse, indépendante de la locale du serveur.

`Alice@Example.com`, `alice@example.com` et `ALICE@EXAMPLE.COM` désignent une seule clé. Les points et suffixes `+` restent significatifs. Certains fournisseurs distinguent la casse locale : la clé ne prouve donc jamais la possession de la variante saisie. Tout futur e-mail sensible de connexion, récupération ou changement de mot de passe devra être envoyé exclusivement à l’adresse exacte vérifiée et enregistrée, jamais à la variante saisie par le demandeur.

## Ports et frontière de confiance

`PostgresEmailRegistration` compose Prisma et les primitives existantes. `requestVerification(address)` accepte seulement une adresse ; `finalize({ email, token, password })` refuse les champs supplémentaires, notamment `accountId`, `emailVerified` et `verifier`. Le service choisit l’identité stable et calcule le PHC avec `createPasswordVerifier`. Aucun repository de création arbitraire n’est exposé à la présentation.

`RegistrationEmailTransport.submitVerification` est le seul port recevant le jeton brut. Son succès signifie acceptation par l’adaptateur, pas réception dans une boîte. Le résultat retourné au demandeur contient seulement `verification-requested`. Sans adaptateur, l’opération échoue avant écriture. Après échec de transport, une intention non consommée peut rester jusqu’à expiration : la livraison peut être incertaine. Aucun faux envoi, aucune boîte fictive ou sortie de jeton dans une réponse ne sert de solution de repli. `RecordingTransport` existe exclusivement dans les tests.

`PasswordBlocklist.isBlocked` est un port obligatoire pour accepter un nouveau mot de passe : absence, erreur ou réponse non booléenne donnent `POLICY_UNAVAILABLE`. L’adaptateur doit être configuré par la composition serveur de confiance, comparer le secret entier et utiliser une liste entretenue de valeurs courantes, attendues ou compromises. Les tests emploient un corpus minimal explicitement limité aux fixtures. Il ne constitue pas un contrôle de production. Aucun service externe ne reçoit de mot de passe pendant ces tests.

Prisma et les adaptateurs sont des capacités serveur privilégiées. Ces contrats ne protègent pas d’un administrateur SQL malveillant ni d’une couche HTTP qui déciderait d’utiliser directement Prisma. Avant exposition, la présentation doit dépendre du service, jamais prendre les adaptateurs, PHC, indicateurs de vérification ou identifiants stables depuis le client. Aucun endpoint ne doit transformer les résultats internes en session ou autorisation E2EE implicite.

## Parcours et transactions

1. Le serveur valide et canonicalise l’adresse, génère un UUID et 32 octets CSPRNG indépendants. Le jeton opaque versionné `e1.<uuid>.<secret base64url canonique>` réutilise les primitives `session-token`, sans accepter les versions session `s1` ou réauthentification `r1`.
2. Il écrit l’intention avec SHA-256 du secret aléatoire, puis appelle le transport hors transaction. Le jeton brut n’est pas persisté. SHA-256 convient ici à un secret aléatoire de 256 bits ; il ne remplace jamais Argon2id pour un mot de passe humain.
3. Le destinataire fournit ce jeton, l’adresse et le mot de passe choisi. Le service vérifie l’empreinte à temps constant, la liaison à l’adresse et la validité temporelle. La preuve est liée à l’intention par son UUID immuable et sa table/version d’inscription ; aucun compte cible n’est fourni par le client.
4. Hors transaction : validation exacte du mot de passe, contrôle de liste, calcul natif Argon2id avec sel propre. Le mot de passe n’attend jamais en base pendant la vérification de l’e-mail.
5. Transaction `ReadCommitted` courte : verrou `FOR UPDATE` de l’intention, relecture et revalidation de la preuve et de l’expiration après attente, contrôle de l’adresse, création de `Account`, `EmailIdentity`, `PasswordCredential`, puis consommation de l’intention et conservation du reçu. Commit unique. Aucun appel réseau ou KDF sous verrou.
6. Le résultat `account-created` signifie seulement que le compte vérifié et son vérificateur existent. Aucun `Device`, `Session`, `VaultState`, publication, opération de coffre ou grant n’est créé. Le parcours produit complet d’inscription reste à terminer.

La durée de preuve est de 30 minutes, strictement : `createdAt <= now < expiresAt`. PostgreSQL impose cette durée, des dates finies et les combinaisons de champs valides. Un trigger interdit la réaffectation de l’intention, la modification de l’empreinte et le retour d’un reçu à l’attente. La consommation exige une identité correspondante, sa date de vérification et un vérificateur daté présents dans la transaction. Les clés étrangères restreignent les suppressions de comptes référencés.

Les timeouts suivent 4.3C : attente de verrou 1 s, instruction 3 s, transaction 5 s, acquisition de transaction 2 s. Les erreurs inconnues sont remplacées par `OUTCOME_UNKNOWN` sans détail du pilote ni secret. L’insertion ciblée `ON CONFLICT (canonical) DO NOTHING RETURNING` classe une collision confirmée sur cet index en `EMAIL_UNAVAILABLE` dans la transaction, qui est alors annulée. Avec Prisma 7.10.1 et l’adaptateur PostgreSQL testés, une collision Prisma directe produit `P2002` et `meta.driverAdapterError.cause` porte `23505`, `UniqueConstraintViolation` et le nom d’index. Ces métadonnées dépendent de l’adaptateur : la classification utilise le conflit SQL ciblé plutôt que cette structure ou le message. Les autres contraintes et erreurs incertaines restent `OUTCOME_UNKNOWN` ; aucune exception de commit n’est interprétée comme un rollback. Aucun échec réseau/commit n’est interprété comme une preuve de rollback.

## Concurrence et reprise

| Situation                                             | Résultat et reprise                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intention abandonnée                                  | Aucun compte et aucune réservation unique de l’adresse ; une autre intention peut réussir. La première expire.                                                |
| Crash après lecture de la preuve ou Argon2id          | Aucun état « vérifié » intermédiaire n’est persisté. Reprendre avec la même preuve encore valide ; un nouveau sel peut être calculé.                          |
| Échec après création du compte, avant le vérificateur | La transaction annule compte et identité. La preuve reste utilisable.                                                                                         |
| Deux consommateurs de la même preuve                  | Le verrou sérialise ; un seul crée le compte, l’autre retrouve son reçu.                                                                                      |
| Deux preuves distinctes pour la même adresse          | L’index unique PostgreSQL arbitre ; le perdant ne conserve ni compte partiel ni consommation.                                                                 |
| Commit réussi, réponse perdue ou erreur après commit  | Rejouer avec la même preuve et adresse ; le reçu durable restitue le même `accountId`, y compris après redémarrage Prisma et expiration initiale.             |
| Jeton consommé, autre mot de passe fourni             | Le reçu seul est relu, sans nouveau KDF, changement de vérificateur, session ou autorisation. Ce n’est pas une nouvelle vérification ni une authentification. |
| Nouvelle preuve pour une adresse déjà enregistrée     | Refus ; aucun changement de compte, de mot de passe, d’adresse, de session ou d’appareil.                                                                     |
| Compte créé, coffre absent                            | État persistant attendu pour 4.4B ; le compte ne doit jamais être recréé pour terminer l’amorçage.                                                            |

Le reçu n’est pas une capacité d’amorçage ou de connexion. Le jeton consommé est invalide pour toute nouvelle mutation ; sa connaissance n’autorise que la récupération du résultat historique. Les reçus sont conservés sans expiration de lecture dans cette primitive. Une politique de rétention devra être décidée avant purge ; même après suppression d’un reçu, l’identité unique empêche une nouvelle création pour l’adresse enregistrée. Un changement futur d’adresse ne doit pas convertir un ancien reçu en preuve pour la nouvelle adresse.

## Mots de passe et recommandations

La politique provisoire du prototype applique au moins 15 points de code Unicode et au plus 1 024 octets UTF-8, avec l’encodeur `encodeEnvelopePassword` du coffre V1. Une paire de substitution valide compte pour un point ; un surrogate isolé est refusé. Espaces, Unicode et NUL restent acceptés selon le contrat du coffre. Aucun trim, changement de casse, normalisation, règle de composition ou troncature. Les formes NFC et NFD restent des secrets distincts. La vérification des comptes existants garde ses bornes techniques ; le minimum de création ne modifie pas rétroactivement leur authentification.

Le [NIST SP 800-63B-4, section 3.1.1](https://pages.nist.gov/800-63-4/sp800-63b.html#passwords) demande 15 caractères en facteur unique, comptés par points de code, et la comparaison à une liste de valeurs courantes/compromises. Il recommande de permettre au moins 64 caractères, Unicode et espaces, et recommande NFC. Les [conseils OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#implement-proper-password-strength-controls) vont dans le même sens : longueur, liste de compromission, absence de troncature et de règles de composition arbitraires.

La borne de 1 024 octets accepte au moins 256 points de code Unicode quelconques. Nous conservons une divergence explicite concernant NFC pour rester compatibles avec le coffre V1. Changer l’encodage nécessiterait une migration coordonnée. Ni conformité NIST complète ni qualification de production n’est revendiquée ; le corpus entretenu, les contrôles d’abus et le déploiement réel restent absents.

Avant la V1 publique, une étude sécurité/UX comparera les recommandations NIST, OWASP, CNIL et ANSSI au modèle de menace Bunny Talks, notamment les seuils 12, 14 et 15, phrases de passe, listes de secrets compromis, indicateur de robustesse, gestionnaires de mots de passe, saisie mobile, pédagogie de la clé de récupération et performances KDF sur appareils modestes. La décision finale doit être cohérente entre inscription, changement et récupération. Une copie du coffre permet des attaques hors ligne : la limitation serveur ne suffit pas ; le coût Argon2id client ne compense pas un mot de passe faible, et la clé de récupération indépendante ne renforce pas directement ce mot de passe. Le seuil actuel ne suffit pas seul à qualifier la production.

## Date du vérificateur et migration

La migration historique `20261115030000_email_registration` crée les deux tables, leurs contraintes/index/triggers et ajoute `PasswordCredential.verifierUpdatedAt` nullable. La migration suivante `20261115040000_email_casefold` vérifie les collisions historiques avant toute modification, puis transforme les clés sous transaction sans changer les adresses originales. En cas de collision, elle échoue et exige une résolution manuelle ; aucun compte ne doit être fusionné automatiquement. Elle actualise aussi les intentions et reçus, temporairement sous désactivation transactionnelle du trigger d’immuabilité. Prévoir une fenêtre coordonnée : les anciennes versions de l’application ne sont pas compatibles avec la nouvelle règle. Aucun ancien compte n’est supprimé ou associé à une adresse inventée. Les anciennes migrations sont inchangées.

Les lignes déjà présentes gardent `NULL`, signifiant « date exacte inconnue ». Le défaut concerne les insertions ultérieures uniquement. Un trigger serveur couvre toutes les écritures : une insertion reçoit la date courante PostgreSQL ; un PHC effectivement différent reçoit une nouvelle date, y compris un futur renouvellement de profil ; un PHC inchangé, une révision seule, un rejeu ou une tentative de modifier uniquement la date la laissent inchangée. Un rollback annule aussi la date. Il ne s’agit pas d’une date métier de choix du mot de passe. La précision est la milliseconde et cette date ne sert pas de compteur de concurrence ; `revision` conserve cette responsabilité.

Les anciens écrivains de vérificateurs bénéficient du trigger sans modification de leur code ; les anciens services d’identité e-mail ne sont toutefois pas compatibles avec la nouvelle canonicalisation. La date reste nullable dans Prisma pour l’historique. Le déploiement doit appliquer la migration avant le nouveau service ; génération/validation ne déploient rien. La migration encadre ses opérations dans `BEGIN`/`COMMIT` pour éviter un schéma partiellement appliqué. Les opérations DDL prennent des verrous : prévoir une fenêtre et un diagnostic des transactions longues. Ne pas réécrire une migration appliquée ni employer un reset ; en cas d’échec ou de commit incertain, examiner l’état réel avec les outils Prisma avant reprise et, pour toute correction déployée, ajouter une migration versionnée. Les tests de migration conservent explicitement un compte et un vérificateur antérieurs.

## Conditions avant exposition publique

Restent à implémenter et qualifier : TLS, limitation des demandes et essais avant les opérations coûteuses, anti-énumération (codes, corps et temps de réponse), protection contre l’abus d’envoi, budgets Argon2id entre processus, transport réel, corpus entretenu et stratégie d’indisponibilité, gestion des liens sans fuite dans journaux/analytics/Referer, journalisation sans adresse ou secret superflu, nettoyage et politique de rétention des intentions et reçus. Les erreurs internes ne constituent pas un contrat HTTP sûr.

Le nettoyage futur doit supprimer par lots uniquement les intentions non consommées dont `expiresAt <= now`, avec coordination des transactions ; il ne doit pas supprimer les reçus sous prétexte que leur preuve a expiré. Le refus d’une preuve expirée et l’absence de réservation de l’adresse fonctionnent déjà sans tâche de nettoyage, mais la croissance des données et l’abus d’envoi ne sont pas contrôlés. Aucun ordonnanceur ni nettoyage des données locales de l’utilisateur n’est exécuté dans ce jalon.

## Contrat historique transmis à 4.4B

Le futur amorçage devra authentifier le compte par mot de passe au moyen d’une session valide et obtenir une capacité spécifique, non substituable par le reçu d’inscription. Il devra verrouiller le compte dans une transaction couvrant publication et première autorisation et traiter explicitement :

| État constaté                                                     | Exigence pour 4.4B                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Identité vérifiée, aucun coffre et aucun appareil jamais autorisé | Candidat à un premier amorçage ; l’absence seule ne vaut pas autorisation.                                                         |
| Première publication légitime                                     | Preuve d’amorçage liée au compte et à l’appareil demandeur ; publication et activation coordonnées et reprenables.                 |
| Même demande après réponse perdue                                 | Retrouver un reçu exact, sans publier ni autoriser deux fois.                                                                      |
| Demande distincte après premier amorçage                          | Refuser un second amorçage ; utiliser le futur parcours d’ajout.                                                                   |
| Coffre actif ou appareil déjà autorisé                            | Refuser le premier amorçage, même avec mot de passe et preuve d’inscription.                                                       |
| Tous les appareils perdus ou révoqués                             | Parcours distinct ; ne pas assimiler zéro appareil actuellement autorisé à « jamais amorcé ». Préserver l’historique et le coffre. |
| État partiel ou incohérent                                        | Refuser l’activation automatique et diagnostiquer ; ne pas effacer pour recommencer.                                               |

L’association durable d’amorçage est depuis implémentée en 4.4B, en réutilisant les reçus existants ; l’inscription seule ne fournit toujours pas cette capacité. Le repository bas niveau `publishInitial` de 4.2B reste interne et exige toujours un contrôle d’autorisation par son futur service appelant. Aucun transfert de clés, reset par e-mail, récupération de coffre ou approbation d’un appareil supplémentaire n’est ajouté.

## Vérifications et points de revue

Les suites unitaires couvrent formats/canonicalisation et politique UTF-8 ; les suites PostgreSQL utilisent des preuves réellement persistées, sans booléen de vérification. Elles couvrent création, Argon2id natif, détournement, expiration, concurrence entre connexions, reprise Prisma, rollbacks SQL, erreur après commit, cycle SQL et date du vérificateur. La suite de réauthentification vérifie aussi la mise à jour de cette date lors d’un réenveloppement et son maintien lors des reprises/rollbacks.

Relire particulièrement la politique de casse ASCII, le traitement des jetons consommés comme simples reçus, les triggers de cycle de vie/date, l’arbitrage d’unicité et les ports obligatoires. Les tests ne démontrent pas la livraison réelle, les défenses HTTP, la qualité d’une liste de compromission, le dimensionnement en charge ni les garanties E2EE futures.

Vérifications exécutées le 15 novembre 2026 : `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm -r --if-present build`, validation/génération Prisma et `git diff --check` réussis. Les sept suites de persistance ont réussi avec **83 tests** sur PostgreSQL **18.7** compilé localement, dans une instance isolée créée pour ce jalon sous `/tmp`, port local 55439 et base dédiée `bunny_talks_test`. Chaque suite crée et supprime uniquement son propre schéma aléatoire. La suite partagée de validation compte 32 tests réussis et celle de politique de mot de passe 15. Les cinq modules serveur compilés d’inscription, politique, réauthentification, coffre et sessions ont été importés réellement sous Node ESM ; la politique compilée a été exécutée. Aucun fournisseur externe, déploiement de migration dans la base applicative ou changement des secrets locaux de l’utilisateur.

## Inventaire pour revue

Fichiers créés :

- `apps/api/prisma/migrations/20261115030000_email_registration/migration.sql`.
- `apps/api/src/postgres-email-registration.ts` et `apps/api/src/registration-policy.ts`.
- `apps/api/tests/postgres-email-registration.test.ts`, `apps/api/tests/email-registration-migration.test.mjs` et `apps/api/tests/registration-policy.test.ts`.
- `docs/development/email-registration.md`.

Fichiers modifiés :

- `apps/api/package.json` et `apps/api/prisma/schema.prisma`.
- `apps/api/src/session-token.ts`.
- `apps/api/tests/postgres-reauthentication.test.ts`.
- `packages/validation/src/schemas/email.schema.ts` et `packages/validation/tests/email.schema.test.ts`.
- `docs/architecture/architecture-overview.md`, `docs/development/current-milestone.md` et `docs/security/server-password-verifiers.md`.

À la livraison de 4.4A : aucune dépendance ajoutée et aucun début d’implémentation 4.4B. Le commit est désormais créé ; message historique : `feat(auth): add verified email registration and verifier timestamps`.
