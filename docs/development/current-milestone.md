# Amorçage applicatif du premier appareil — étape 2

**État : corrections ciblées soumises à nouvelle revue ; l’étape reste ouverte.** Cette étape assemble sous Node le contrat de session, sa persistance cliente et le protocole HTTP d’amorçage/reprise. Elle ne qualifie pas le runtime natif, l’interface utilisateur ou l’aptitude à la production.

## État déclaré

- La revue indépendante de la révision `8ed8a3717bbef759db94f60bb4361a0087382bbd` accepte la qualification Android 3B dans son seul périmètre expérimental. Le rapport durable, ses 45 tests finaux, trois reprises après arrêt forcé, six refus sacrificiels et l’empreinte APK sont consignés dans [le rapport 3B](android-crypto-initialization-3b.md). Le nominal confirme la réouverture de la session locale, sans comparaison exhaustive de l’état de ratchet.
- La revue indépendante de `e56d91297950ae39367ceaebb59e395be0332ff6` accepte la première composition protocolaire et ses 15 tests. Sa vérification de récupération était simulée et n’était pas une preuve cryptographique.
- L’étape 2 ajoute `credentialRevision` à `GET /v1/session` uniquement, les schémas partagés login/session, la composition et persistance SecureStore de session, une ouverture réelle de la publication par clé de récupération et un journal SDK protégé.
- Le workflow HTTP conserve l’opération originale, journalise l’incertitude avant toute émission, ne réessaie pas automatiquement et distingue `200` terminal, `202 unknown`, rejet, conflit, divergence, session invalide et commit.
- La revue de la révision `b59cca4d57dc00eeaee87f0643eefadd07974a83` accepte le contrat serveur, les schémas, les 77 tests PostgreSQL/HTTP, la persistance de session, la vérification de récupération, le journal et l’équivalence sémantique du lockfile. Elle maintient l’étape ouverte pour les anomalies clientes corrigées ici.

## Vérifications et revues de l’étape 2

Corrections de la revue précédente : preuve d’ouverture du coffre par le mot de passe exact avant activation et rejeu ; validation de session attendue sous les deux DTO stricts ; verrou local du login et des opérations d’amorçage ; CAS distingue durabilité et acquisition ; les résultats terminaux ne régressent pas ; annulation HTTP reste incertaine ; un `401` bloque le Bearer dans l’instance courante même si la suspension durable échoue.

Vérifications de la révision précédente : typecheck mobile ; ESLint et Prettier ciblés ; 57 tests ciblés des sessions, du journal/workflow et deux cas SQLCipher sélectionnés dans la suite locale, incluant les vraies ouvertures du coffre et un CAS dont la réponse est perdue. Aucune suite serveur/PostgreSQL, HTTPS ni qualification Android/iOS n’a été relancée car les contrats acceptés n’ont pas changé.

La revue indépendante de `2cef0eda01db7f8357f15d7cfdf9fcabea895847` accepte ces corrections dans leur périmètre et maintient l’étape ouverte. La consolidation soumise à revue affine la classification des refus de login, d’activation et de reçu, centralise la revalidation dans le propriétaire de session, refuse la concurrence entre opérations sensibles, protège la propriété et la fermeture SQLCipher, stabilise les paramètres et conserve le code métier des nouveaux rejets terminaux. Voir le [contrat client d’amorçage et de reprise](http-initial-device-bootstrap.md#garanties-et-intégration-mobile).

La consolidation a été vérifiée par 111 tests dans sept suites mobiles, le typage mobile, ESLint et Prettier ciblés. La suite d’initialisation SQLCipher sous Node inclut ses scénarios de reprise par sous-processus et les nouvelles injections de fermeture et de concurrence.

La revue indépendante de `ce0c3d719658d994dde152247801ca13ca3fa39f` accepte la consolidation précédente et ses compteurs dans leur périmètre expérimental. Elle maintient l’étape ouverte pour la liaison entre le store local et la session. Le test différentiel a reproduit le défaut avec le vrai coffre et SQLCipher sous Node. Pour le même compte et le même coffre, le store D1 a journalisé l’activation sous D2 et le workflow a transmis un POST au double HTTP.

La correction soumise à revue lie l’activation et la reprise à la capacité immuable délivrée par le propriétaire du store. Elle refuse le mélange de tentatives, compare le contexte de la capacité à celui de la session et exige l’état `pending` pour une nouvelle activation. La reprise conserve la session et les données originales, y compris pour un appareil devenu `authorized`. Le CAS froid compare le digest de la publication retrouvée à celui de l’opération avant toute écriture. Les identifiants sont contrôlés par type avant les expressions régulières. Le schéma nommé des codes métier est partagé avec le contrat HTTP et les représentations V1/V2 restent compatibles.

Les suites ciblées couvrent le refus D1/D2, le mélange de deux vraies tentatives, la substitution froide avant ouverture et au niveau du store rouvert, le refus d’une autre session du même appareil, le changement de publication avant le CAS, les reprises `authorized` et les types de contexte invalides. Les 119 tests mobiles répartis sur sept suites et les 3 tests de validation de la publication réussissent. Le typage mobile et validation, ESLint et Prettier ciblés réussissent également.

Les compteurs de la consolidation précédente sont confirmés par le test d’intégration mobile après correction. Ils utilisent le vrai coffre V1 et SQLCipher sous Node. Le transport HTTP est simulé. Les ouvertures à chaud ci-dessous sont comptées en plus du store déjà ouvert par la création locale. Les lectures et écritures concernent uniquement la clé du journal d’amorçage.

| Opération observée                               | Argon2id | Ouvertures / fermetures | Lectures / écritures du journal | Requêtes d’amorçage |
| ------------------------------------------------ | -------- | ----------------------- | ------------------------------- | ------------------- |
| Création locale                                  | 2        | 1 / 0                   | 0 / 0                           | 0                   |
| Activation à chaud, réponse perdue               | 1        | 0 / 0                   | 3 / 2                           | 1                   |
| Rejeu explicite à chaud, réponse perdue          | 1        | 0 / 0                   | 2 / 0                           | 1                   |
| Reçu à froid et confirmation durable du résultat | 0        | 2 / 2                   | 2 / 1                           | 1                   |
| Résultat terminal local à froid                  | 0        | 1 / 1                   | 1 / 0                           | 0                   |

Le test ferme le store initial avant la relecture à froid. La dérivation d’activation reste nécessaire pour prouver l’ouverture de la publication exacte avec la valeur fournie à l’appel. Réutiliser les vérifications internes de création demanderait une preuve liée à cette valeur et à la durée de vie de l’opération. La composition conserve la vérification immédiate et les paramètres Argon2id existants. Ces compteurs ne mesurent ni latence ni batterie sur appareil.

L’incident antérieur `pnpm db:up` n’est pas caractérisé plus précisément que l’erreur de validation Compose disponible ; le script ou Compose n’a pas été modifié. Aucun build natif, émulateur, accès Pixel_8, changement de transport HTTPS ni commande Git n’a été exécuté.

## Limites et hygiène

La confirmation d’une sauvegarde indépendante est représentée par une capacité exigée mais son UI produit est hors périmètre. L’ouverture cryptographique prouve la capacité à ouvrir la publication testée, pas sa conservation indépendante. SecureStore et SQLite ne partagent pas de transaction atomique. La perte définitive de la session originale nécessite un parcours de réauthentification/reprise distinct. État local prêt, reçu serveur `committed` et autorisation serveur courante restent séparés.

La liaison locale couvre les compositions légitimes dans le runtime. Les travaux distincts restent la résolution durable d’un login incertain, la reconnexion sécurisée de l’appareil original, la déconnexion et le changement de compte, l’UI de confirmation, la qualification native et les mesures sur appareil.

OpenE2EE 14.5.0 et le coffre V1 restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants avant production ; le verrou iOS reste fermé. Aucun nettoyage destructif ou retrait de preuve n’est identifié pour ce jalon.

Références : [sessions HTTP](http-sessions.md), [amorçage HTTP](http-initial-device-bootstrap.md), [rapport Android 3B](android-crypto-initialization-3b.md), [historique des jalons](milestone-history.md).
