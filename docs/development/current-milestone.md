# Jalon 4.5A — PostgreSQL local persistant

Le jalon 4.5A est validé. PostgreSQL permanent est opérationnel sur `127.0.0.1:15432`, avec healthcheck `healthy` et neuf migrations appliquées. Le démarrage local recommandé devient `pnpm db:up` : prévalidation des identifiants et de la configuration Compose, attente du healthcheck et vérification des trois authentifications. Le correctif de démarrage reste en attente de revue humaine. Voir [procédures et limites](postgresql-prisma-foundation.md). La qualification Android/E2EE n'est pas commencée dans ce correctif.

# Historique — Jalon 4.4C3 — Amorçage initial E2EE par HTTP

Validé et commité : `POST /v1/vault/bootstrap` et `POST /v1/vault/bootstrap/receipt`, protégés par le guard existant. Composition des primitives 4.4B inchangées, enveloppes strictes, limite JSON de 192 Kio propre aux deux routes, budgets et baux PostgreSQL dédiés, trousseau HMAC stable et activation indépendante désactivée par défaut, interdite en production. Voir [audit, contrat, garanties, limites et vérifications](http-initial-device-bootstrap.md).

Les résultats distinguent `committed`, `rejected` et `unknown`. La relecture ne crée ni reçu ni autorisation. La session d’origine est conservée ; le suivi d’activité normal du guard reste applicable. L’autorisation serveur ne prouve pas la possession des clés privées. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

# Historique — Jalon 4.4C2B — Connexion HTTP et sessions sur appareils en attente

Implémentation et corrections validées et commitées dans `509a80e` : `POST /v1/auth/login`, vérification Argon2id réelle hors transaction, substitution anti-énumération, budgets PostgreSQL dédiés, revalidation exacte du credential sous verrou et création atomique d’une session `s1` sur un nouvel appareil `pending`. Aucune autorisation E2EE ni reprise d’appareil historique. Voir [contrat, audit, configuration, tests et limites](http-login.md).

La correction ajoute une preuve runtime enregistrée dans une `WeakMap` privée, une photographie immuable et des contrats partagés à la racine de `auth`, sans dépendance de `sessions` vers `login`. Le contrat HTTP et les revalidations PostgreSQL sont conservés. Qualification corrective : 172 tests PostgreSQL et 114 tests HTTP/SMTP/ESM réussis, ainsi que les tests unitaires, d’architecture et les contrôles de types du monorepo.

Login désactivé par défaut et activation **refusée en mode production** : les baux expirants ne garantissent pas un plafond physique absolu après suspension d’un processus. Conservation bornée sans purge des sessions/appareils, politique de rétention définitive à décider. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. À sa clôture, aucun amorçage HTTP n’était exposé.

# Historique — Jalon 4.4C2A — Inscription HTTP et vérification e-mail

Terminé, validé et commité (`f38025e`) : deux POST versionnés, validation Zod stricte, SMTP réel avec TLS obligatoire, Pwned Passwords par k-anonymité, budgets et baux PostgreSQL partagés, anti-énumération et réponse minimale de reprise. L’inscription reste désactivée par défaut. Voir [contrats, configuration, garanties, limites et résultats](http-email-registration.md). Aucune session, aucun appareil ni coffre créé. À sa clôture, 4.4C2B n’était pas commencé. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

# Historique — Jalon 4.4C1 bis — Harmonisation architecturale

Terminé et commité (`883c7e7`) avant 4.4C2A : audit du monorepo, organisation du backend par domaines, composition PostgreSQL partagée explicite, politiques d’entrée HTTP attachées aux routes et suites de tests séparées. Voir [inventaire, choix, graphes, résultats et points de revue](backend-architecture-harmonization.md). Les contrats cryptographiques, migrations et opérations transactionnelles sont conservés. Aucun parcours HTTP d’inscription ou de connexion n’est ajouté. À sa clôture, 4.4C2 n’était pas commencé.

# Historique — Jalon 4.4C1 : fondation HTTP NestJS et sessions

Terminé et commité (`b4e551f`) : liveness publique, lecture de la session courante et révocation transactionnelle par Bearer opaque, sans endpoint sensible supplémentaire. Voir [contrat HTTP, architecture, configuration, protections et vérifications](http-sessions.md). L’état `authorized` ne démontre pas la possession E2EE. Cette API n’est pas qualifiée pour des utilisateurs réels ; SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. À sa clôture, 4.4C2 n’était pas commencé.

# Historique — Jalon 4.4B : amorçage sécurisé du premier appareil

Terminé, validé expérimentalement et commité (`767ed84`) : session et mot de passe effectivement vérifiés, revalidation sous verrou, publication initiale et autorisation du premier appareil atomiques, association immuable aux reçus et récupération sans création après réponse perdue. Voir [audit, états, migration, garanties, tests et limites](initial-device-bootstrap.md). À la clôture de 4.4B : aucun endpoint HTTP, appareil supplémentaire ou parcours de récupération livré. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

# Historique — Jalon 4.4A : identité e-mail et inscription sécurisée

Terminé et commité avec la correction d’unicité e-mail insensible à la casse (`46d6681`). Voir [politique et qualification](email-registration.md). L’inscription crée le compte vérifié et son vérificateur, sans session, coffre ni autorisation. Les ports de transport d’e-mail et de liste de compromission de production restent à configurer.

# Historique — Jalon 4.3C : preuves de réauthentification transactionnelles

Jalon terminé et commité : liaison au PHC préparé exact, contrôle sous verrou de l’état serveur d’autorisation de l’appareil et récupération sans écriture. Voir [grants, intention, transaction et rejeu](reauthentication-grants.md). SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

# Historique — Jalon 4.3B : sessions persistantes et états des appareils

Jalon terminé et commité (`4bb702d`), corrections des UUID et verrou exclusif conservé : [contrat, migration, expirations et limites](persistent-sessions.md). SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. Aucun accès E2EE automatique ni preuve de réauthentification. Ce paragraphe décrit la fin de 4.3B.

# Historique — Jalon 4.3A : primitives de mot de passe serveur

Jalon terminé et commité (`a6c0a21`) : vérificateur Argon2id serveur asynchrone, profil borné et limite locale de concurrence. Voir [fournisseur, contrat, mesures et limites](../security/server-password-verifiers.md). Ce paragraphe décrit la situation à la fin de 4.3A. SEC-CRYPTO-003 reste ouvert.

# Historique — Jalon 4.2B : repository transactionnel PostgreSQL

Terminé et commité (`90d8507`) : activation initiale, réenveloppement interne atomique, CAS, reçus durables et empreinte HMAC. Voir le [contrat interne, la politique de clés et la qualification PostgreSQL](transactional-vault-repository.md). Les tests réels sur PostgreSQL 18.7 couvrent concurrence, rollbacks, réponse perdue, timeout et relecture après recréation du client Prisma. Aucun endpoint, authentification ou mécanisme d'autorisation d'appareil n'est ajouté. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. Ce paragraphe décrit le jalon 4.2B avant le début de 4.3A.

Correction historique : une enveloppe liée à une ancienne révision d'authentification reste lisible après une réinitialisation simulée ; le changement ordinaire est refusé jusqu'à une réparation future. Les services de réinitialisation et de réparation restent à concevoir.

## Historique — Jalon 4.2A : fondation PostgreSQL et Prisma

La fondation et ses limites sont décrites dans [PostgreSQL et Prisma](postgresql-prisma-foundation.md). Les tests ciblés ont réussi sur une instance PostgreSQL 18.7 temporaire ; ce jalon a été commité avant 4.2B.

# Historique — Jalon 3 : qualification Android/Hermes du coffre — 14 novembre 2026

**Historique du premier essai Noble, non validé :** les contrôles rapides (aléa natif, vecteur HKDF, ouverture du vecteur de publication par récupération et manifest) réussissent sur émulateur Android/Hermes. La dérivation Argon2id a été interrompue avant résultat après plusieurs observations ; le parcours complet et la persistance ne sont pas qualifiés. Voir le [rapport détaillé](android-vault-qualification.md). La configuration Metro cible l’entrée ESM du parseur après un échec runtime de l’entrée UMD. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. Aucun jalon suivant n’est commencé.

**Actualisation expérimentale :** un fournisseur Argon2id natif a réussi des vecteurs courts et un essai complet sur cet émulateur ; cet essai isolé précédait l’intégration expérimentale ci-dessous et ne vaut pas approbation de production. Les limites de provenance, de mémoire et de qualification iOS sont précisées dans le [rapport natif](native-argon2-qualification.md). Le jalon 3 reste ouvert.

**Intégration native commitée (`1321045`) :** le fournisseur explicite est désormais transmis aux API et vérifications internes du coffre ; les anciens appels gardent Noble comme référence. Sur émulateur Android/Hermes, les deux réenveloppements, les deux accès, les rejets et la reprise après arrêt forcé ont réussi. Un coordinateur partagé rejette les KDF concurrents. Voir les [résultats et limites](native-argon2-qualification.md#intégration-expérimentale-dans-les-api-du-coffre). Le jalon 3 reste expérimental, iOS et appareils physiques à qualifier, sans approbation de production.

**Jalon 4.1 terminé et commité (`fa2ac7f`) :** les contrats de publication et les transitions structurelles pures sont décrits dans [leur documentation](vault-publication-contracts.md). Aucune transaction PostgreSQL ni autorisation réelle ne sont implémentées ; SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

## Historique — Jalon 2 du coffre E2EE

**Terminé et commité (`3b70df4`) :** création et ouverture d’une charge opaque par les deux voies, manifest HMAC-SHA-256 et réenveloppement local du mot de passe conservant exactement contenu chiffré et enveloppe récupération. Voir la [spécification V1](../security/account-vault-v1.md). Le profil Argon2id, Hermes et les plateformes natives restent à qualifier. Aucun backend, parcours de compte, import SDK ou archive n’est ajouté. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. Cette description historique précède le jalon 3.

## Historique — Migration de sécurité OpenE2EE 14.5.0

**Jalon 1 du coffre récupérable, terminé et commité (`0cde61f`) :** les primitives et deux enveloppes de clé maîtresse sont implémentées dans `crypto-backup`. Voir les [formats, API et limites](../security/key-envelopes-v1.md). Le profil Argon2id à 64 Mio est expérimental et sa qualification Hermes reste ouverte. Le manifest est désormais ajouté par le jalon 2 ci-dessus ; contenu métier, parcours de compte, archive et restauration OpenE2EE restent hors périmètre. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. Ce paragraphe décrit la fin du jalon 1.

**Actualisation :** la qualification Android est partiellement validée sur un émulateur Android 17 avec Hermes et SQLCipher, y compris après arrêt forcé. Le diagnostic renforcé et ses limites sont décrits dans le [rapport mobile](mobile-open-e2ee-qualification.md) ; iOS et la production restent à qualifier.

La migration vers OpenE2EE 14.5.0 est terminée et validée au niveau expérimental sous Node. La revue des tests adversariaux et de la migration SQLCipher est favorable ; le [rapport de migration](open-e2ee-14-5-migration.md) décrit leurs résultats et leurs limites. La qualification React Native/Expo reste partielle : Android a été testé sur un émulateur et iOS reste à qualifier. Aucun choix de production définitif n’est arrêté.

Le POC multi-appareils sous 14.4.0, dont les résultats historiques sont conservés ci-dessous, a reçu une revue favorable. La **recommandation B** demeure de poursuivre provisoirement l’évaluation d’OpenE2EE. Voir [l’audit consolidé](../architecture/e2ee-transition-audit.md) et [ADR-003](../architecture/decisions/003-open-e2ee-evaluation.md).

Les décisions fonctionnelles actuelles retiennent un mot de passe unique, une clé maître de coffre indépendante et deux enveloppes, ainsi qu’une autorisation individuelle par e-mail des appareils supplémentaires avant accès protégé. Le premier appareil suit l’amorçage 4.4B décrit en tête de page. Le coffre direct existant est expérimental ; aucun parcours complet de récupération ou d'autorisation n'est implémenté. Les bornes de registration ID et la sérialisation d'une session réelle ont été caractérisées sous Node ; les autres chemins, la révocation après compromission, l'archive et la compatibilité mobile restent à qualifier. **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants pour la production.**

**Le POC est terminé et validé au niveau expérimental sous Node.** Les expériences démontrent l'identité commune, le fanout public, les sessions indépendantes et leur persistance. Dans la fixture et le SDK testés, un refus fiable `NOT_FOUND` clôt un envoi partiel avec des états par appareil. Cette validation ne vaut pas validation de production ; les garanties du transport réel et la stratégie d'archive restent à établir.

## Résultats du POC et limites

`multidevice-poc.test.ts` démontre les échanges directs entre trois clients et trois stores SQLCipher, le désordre, le rejeu refusé et la reprise après réouverture. `relay-fanout-poc.test.ts` exerce `send`, la découverte, la récupération des préclés et la réception par abonnement : B1 envoie deux enveloppes, déchiffrées par A1 et A2 partageant la même identité ; chacun répond. La fixture relay est une implémentation expérimentale partielle, avec capacités d'appelant liées explicitement aux appareils, sans authentification réelle ni garantie de production.

Le retrait public `removeDevice` de cette fixture supprime les préclés et messages en attente d'A2 et refuse son abonnement, ses publications et son retour après réouverture. Les envois vers A2 sont refusés, mais un ciphertext déjà obtenu reste déchiffrable avec sa session conservée. Avec une liste mise en cache, `send` de B1 tente néanmoins A2 et échoue après avoir déposé une enveloppe pour A1 ; A1 peut encore envoyer à B1. Les mécanismes SDK de signalement des refus et de comparaison des listes observés dans les sources ne sont pas exportés publiquement. Cette expérience établit une limite du relay de test et un risque de disponibilité ; elle ne démontre pas que tout relay public est incompatible. Le refus terminal `NOT_FOUND` qualifié ci-dessous permet une issue partielle explicite dans les conditions du test ; le comportement du transport réel et la gestion des listes périmées restent à valider avant l'intégration.

Un test distinct reprend une session bidirectionnelle entre deux processus Node successifs, avec fichiers secrets temporaires distincts par appareil, permissions `0600` et répertoire `0700` ; ce fournisseur n'est pas un coffre de production. La reprise des trois appareils est aussi testée dans un processus. Les tests ne prouvent ni persistance mobile ni conservation des messages ou archive.

Les IDs 16380 à 16383 fonctionnent en établissement direct, échanges bidirectionnels et reprise SQLCipher ; notre import refuse toujours 16381 à 16383. Ces résultats ne valident pas les autres voies du SDK. Une session réelle contenant des `bigint` fait échouer `SessionRecord.serialize`, tandis que le store la persiste et permet sa reprise ; le projet n'utilise pas ce helper pour la persistance normale. L'interruption d'écriture, un état de session partiel, les garanties transactionnelles et le retrait pendant un fanout ne sont pas démontrés. Une rediffusion identique a été testée dans la fixture, sans démontrer l'idempotence du futur stockage métier. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants pour la production.

## Reprise d'un envoi partiellement accepté

La fixture relay mémorise les dépôts identifiés par appelant, destinataire et `clientMessageId` d'enveloppe. Un redépôt identique retrouve le même identifiant serveur, y compris après acquittement ; une réutilisation contradictoire est refusée. Une réponse perdue après acceptation est simulée : le SDK reprend avec l'identifiant logique `clientMessageId`, réémet la copie à l'acceptation incertaine et ne crée pas de seconde copie. Une rediffusion de la même enveloppe déjà reçue ne déclenche pas un second traitement observé. Cette mémoire de déduplication est une fixture en mémoire sans expiration ni garanties de concurrence ou de durabilité ; un relay réel doit définir et garantir ces propriétés.

Après retrait d'A2, `send` dépose une copie pour A1 puis échoue pour A2. Avec l'erreur générique de la première fixture, l'erreur testée expose l'identifiant logique et `retryable`, sans liste des appareils acceptés à ce stade ; A1 reçoit effectivement le message. Rejouer avec le même identifiant, y compris après fermeture et réouverture du client et après une nouvelle découverte, ne redépose pas la copie A1 mais reste en échec sur A2. Un nouvel envoi du même texte après recréation du client découvre A1 seul, mais crée une deuxième livraison visible : il ne répare pas l'opération initiale. Les refus de liste incohérente et d'identifiant d'enregistrement périmé sont testés dans la fixture, sans démontrer leur interprétation automatique par le SDK.

La conservation de l'envoi exact et la déduplication rendent crédible la reprise d'une réponse perdue, sous réserve d'un relay durable conforme et d'une écriture métier idempotente. Avec l'erreur générique, l'appareil retiré demeure dans l'envoi mémorisé et l'issue n'est pas déterminée. Le refus terminal `NOT_FOUND` caractérisé ci-dessous permet de clore l'envoi avec une issue partielle explicite. Les marqueurs SDK permettant certains refus et comparaisons de listes ne sont pas exportés publiquement ; le transport réel et les garanties applicatives restent à qualifier.

## Refus terminal : résultat de qualification

Le relay de test peut renvoyer l'erreur publique `HostedSignalProtocolRelayHttpError` avec le code `NOT_FOUND` pour une destination inexistante. Dans l'envoi partiel testé, le SDK signale `retryable: false`, A1 dans `acceptedDevices` et A2 dans `refusedDevices` ; `onSendOutcome` signale `failed`. Une répétition avec le même identifiant après réouverture restitue ce résultat sans nouveau dépôt. A1 reçoit séparément sa copie et les nouveaux échanges continuent après découverte de la liste réduite. L'erreur générique précédente n'établissait pas le refus et restait réessayable ; ce résultat dépend donc du contrat effectif du transport, pas d'une garantie du backend Bunny Talks.

Une acceptation historique répétée après révocation retourne désormais le même reçu sans redéposer ni réactiver A2. Une requête différente avec le même identifiant et une requête jamais acceptée vers A2 sont refusées, après contrôle de l'identité de l'appelant. Ces observations concernent la fixture en mémoire ; la durabilité des reçus, leur durée et leur traitement atomique restent à réaliser côté serveur.

Le POC est terminé et validé au niveau expérimental pour poursuivre l'évaluation du SDK : l'application peut constater et conserver une issue partielle terminale, sans la présenter comme une livraison complète. `resendMessage` est public mais refuse ici faute de contenu disponible ; il ne démontre pas une réémission sûre dans toutes les configurations. La conception produit de l'issue, la persistance métier, les accusés tardifs, l'idempotence, l'autorisation et la qualification mobile restent des travaux distincts avant production.

## Travail local préexistant — CRYPTO-014

[CRYPTO-014](../security/archive-key-hierarchy.md) compare quatre modèles d'archive et recommande pour revue une architecture hybride : racines d'archive par compte et par époque, clés de contexte indépendantes, puis clés de contenu aléatoires par objet et version. Les copies personnelles restent distinctes du protocole des espaces partagés et des sessions Signal. Cette recommandation n'est ni approuvée ni implémentée ; aucun format cryptographique, protocole de groupe ou algorithme n'est arrêté dans ce jalon.

Le coffre direct et `RecoveryPayloadV1` peuvent représenter expérimentalement une identité et de 0 à 64 secrets opaques, mais ne définissent ni racines d'archive, ni catalogue de clés, ni complétude ou fraîcheur. Les adaptations, la limite de 64 et une éventuelle migration restent à décider. Une liste vide convient potentiellement à un compte sans archive, sans prouver qu'aucun historique n'existe.

La récupération sans ancien appareil, l'autorisation individuelle, l'import sûr, la protection contre le rejeu et la rotation après compromission restent à concevoir. Une racine compromise peut exposer l'historique de son époque ; une rotation issue de cette racine ne rétablit pas la confidentialité. Un ancien appareil peut conserver le secret de récupération et des copies de clés. La fraîcheur après perte totale ne peut pas être déduite d'un ancien coffre authentique fourni par le seul serveur.

Le moteur direct V1 conserve sa source d'aléa explicite, sans fournisseur inclus ; une source silencieusement défaillante peut produire sel et nonce nuls. Les garanties de mémoire, de compatibilité mobile et de sécurité du parcours complet ne sont pas démontrées. Un changement ordinaire du mot de passe conserve les autres appareils connectés et autorisés ; la révocation est distincte et le secret de récupération indépendant du mot de passe.

La recommandation CRYPTO-014 reste soumise à revue ; elle ne constitue pas une autorisation d'implémentation.
