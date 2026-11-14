# Qualification native Android OpenE2EE 14.5.0

**Verdict : qualification partiellement validée.** Le diagnostic renforcé fonctionne sur un émulateur Android 17 sous Hermes, y compris après arrêt forcé du processus. La qualification concerne un Development Build et des scénarios locaux précis ; iOS, les builds release, un relay réel et la communication entre appareils physiques restent à vérifier. Ce résultat n'est ni un audit cryptographique indépendant ni une validation globale de production.

## Environnement et provenance des observations

Windows 10 exécute Android Studio et `emulator-5554` (`sdk_gphone64_x86_64`) ; Ubuntu WSL2 héberge le monorepo et Metro sur le port 8081. Le développeur indique JDK 17, Android SDK 36 et Gradle, ainsi qu'un APK de développement compilé et installé. Depuis WSL, l'ADB Windows à `/mnt/c/Users/Nicolas/AppData/Local/Android/Sdk/platform-tools/adb.exe` voit l'émulateur et le transfert `tcp:8081` ; l'ADB Linux ne le voit pas directement. La présence du package `fr.bunnytalks.mobile`, Android 17 et Metro ont été confirmés par l'agent. Les projets natifs `apps/mobile/android` et `apps/mobile/ios` sont générés par Expo et ignorés par Git ; aucune modification manuelle de ces dossiers n'a été effectuée.

**Observations du développeur :** l'ancien diagnostic a affiché dix contrôles OK lors de deux passages, dont un après `am force-stop`. L'ancien code ne comparait pas les identités et préclés à un témoin d'avant redémarrage et pouvait établir une nouvelle session si celle-ci avait disparu. Ces observations ne suffisent donc pas à prouver que les mêmes sessions et clés ont survécu.

**Reproduction par l'agent :** après chargement du JavaScript actualisé depuis Metro, un premier passage a enregistré un témoin ; un passage après `am force-stop` et relancement a vérifié ce témoin avant les échanges. Le diagnostic final a ensuite été rejoué après un nouvel arrêt forcé, avec les résultats ci-dessous. Les stores déjà présents ont été conservés. Le premier témoin a été adopté à partir de ces stores : il ne permet pas de comparer leurs identités avec celles des deux passages historiques du développeur.

## Persistance et identités

Le témoin est enregistré dans Expo SecureStore. Il contient un condensat SHA-256 calculé par l'API Expo sur les clés publiques d'identité et de préclés, IDs d'enregistrement et marqueurs publics de session (`baseKey`, compteurs), ainsi qu'un marqueur aléatoire de runtime JavaScript. Aucune clé privée, clé de base SQLCipher, plaintext ou état complet de session n'est enregistré dans ce témoin ni affiché. Les paires d'identité sont validées par `crypto-engine` et les clés publiques A1/A2 doivent correspondre ; les préclés A1/A2 et les sessions A1/B1 et A2/B1 doivent être distinctes. Les IDs et la présence des préclés sont contrôlés.

Lors d'un passage ultérieur, le condensat est comparé **avant** tout établissement de session ou échange. En présence du témoin, une session absente, une identité ou préclé modifiée, un compteur inattendu ou un état incomplet provoquent un échec ; aucune session n'est recréée pour le masquer. La première adoption autorise l'établissement des sessions manquantes et indique qu'un nouveau lancement est nécessaire. Le marqueur distingue les runtimes JS, pas à lui seul les processus Android : ici, la commande externe `am force-stop` établit que le processus a été arrêté. Le test réel a confirmé la correspondance du témoin et la reprise des échanges ; la persistance SecureStore et l'accès normal aux clés de base en sont des observations dans cet environnement.

L'initialisation de stores vierges vérifie d'abord l'absence du témoin, d'identité, d'ID d'enregistrement, de préclés et des quatre sessions connues. Un mélange de stores initialisés et vierges est refusé. Ces contrôles d'état initial et les cas de témoin modifié ou mal formé sont testés sous Node avec des doublures ; les pannes natives injectées et tous les états internes possibles ne sont pas couverts. Une interruption après avancement des sessions mais avant écriture du nouveau témoin peut produire un échec au prochain démarrage : aucun reset automatique n'est tenté. La perte simultanée des stores et du témoin est indiscernable d'une première installation.

## SQLCipher et SecureStore

Le diagnostic interroge `PRAGMA cipher_version` sur une connexion mémoire Expo SQLite et refuse la suite si aucune version n'est renvoyée. Cette étape a réussi sur l'émulateur. La lecture de `sqlite_master` d'un store existant sans clé a été refusée avec l'erreur attendue ; les essais via l'adaptateur Expo ont refusé une clé SecureStore manquante (`LOCAL_STORE_KEY_LOST`) et une mauvaise clé (`KEY_STORAGE_ERROR`). Le store a ensuite été rouvert avec sa clé réelle, ses préclés et ses sessions, puis la conversation a repris. Ces contrôles ont réussi sur l'émulateur ; ils ne couvrent pas un build volontairement dépourvu de SQLCipher.

Un fichier séparé `bunny-diagnostic-plaintext-fixture-v1.db` contient uniquement une table de test vide et un identifiant de fixture. Le diagnostic refuse de modifier un fichier existant dont l'identifiant et la structure ne correspondent pas ; il ne supprime ni ne réinitialise ce fichier. L'ouverture chiffrée de cette base volontairement non chiffrée, avec une clé de test temporaire, a été refusée avec `KEY_STORAGE_ERROR` ; une réouverture en lecture de la fixture a ensuite réussi. Le diagnostic n'accède à aucune table privée du SDK. Le chiffrement n'est jamais désactivé pour un store OpenE2EE.

L'adaptateur du SDK vérifie lui aussi la présence de SQLCipher avant ouverture et utilise SecureStore par défaut pour sa clé de base. L'observation de la reprise et des erreurs sur cet émulateur ne démontre pas toutes les garanties du Keystore, de la sauvegarde système ou des interruptions d'écriture. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants pour la production.

## Aléa et échanges

L'entrée `index.ts` importe `random-provider` avant le composant applicatif et ses imports du SDK. Elle installe `expo-crypto.getRandomValues`, vérifié à l'exécution avant la génération des identités. Les sources Expo Crypto 57.0.3 examinées utilisent `SecureRandom` sur Android ; `getRandomBytes`, qui possède un repli de développement sur `Math.random`, n'est pas utilisé. Les tests Node simulent une erreur native et vérifient sa propagation sans repli. L'indisponibilité réelle du module natif n'a pas été injectée sur Android et la qualité statistique de l'aléa ne se démontre pas par un appel réussi.

Le diagnostic Android a établi et repris des sessions distinctes A1/B1 et A2/B1. B1 a chiffré séparément le même contenu pour A1 et A2, et chacun l'a déchiffré ; les échanges de réponse et la reprise après fermeture/réouverture ont réussi. Il s'agit d'un fanout local explicite par appareil, sans relay ni API publique `send` de fanout. Le test du fanout public et les tests adversariaux d'identité restent des résultats Node du [rapport 14.5.0](open-e2ee-14-5-migration.md).

L'exécution Android finale a aussi réussi les contrôles Hermes, UTF-8 strict, `bigint`, `Map`, `Uint8Array` et Base64 exercés par le diagnostic. À titre indicatif, sur cet émulateur et ce passage : ouverture des trois stores et contrôles d'identité 797 ms, chiffrement 112 ms et déchiffrement 186 ms. Ces mesures incluent le contexte du diagnostic, ne constituent pas un benchmark et ne se généralisent pas aux téléphones.

Le diagnostic n'affiche ni erreurs brutes ni secrets. Une recherche limitée de marqueurs usuels de clés privées, de secrets et de repli aléatoire dans les 797 lignes ReactNativeJS du processus courant n'a trouvé aucun marqueur ; aucun contenu du journal n'a été affiché. Cette recherche ne prouve pas l'absence absolue de toute fuite, ni celle des autres journaux ou processus.

## Reproduction et limites

Les modifications de ce jalon portent sur le JavaScript et les tests ; les dépendances, plugins et projets natifs n'ont pas changé. Dans le Development Build existant connecté à Metro, recharger le bundle suffit : une reconstruction d'APK n'a pas été nécessaire pour les essais ci-dessus. Une modification future des dépendances natives ou des plugins nécessitera de régénérer le projet via Expo Prebuild puis de reconstruire et réinstaller l'APK, sans modifications manuelles des dossiers générés.

Depuis WSL, avec Metro déjà actif et le transfert configuré :

```sh
ADB_WIN=/mnt/c/Users/Nicolas/AppData/Local/Android/Sdk/platform-tools/adb.exe
"$ADB_WIN" -s emulator-5554 reverse tcp:8081 tcp:8081
"$ADB_WIN" -s emulator-5554 shell am force-stop fr.bunnytalks.mobile
"$ADB_WIN" -s emulator-5554 shell am start -n fr.bunnytalks.mobile/.MainActivity
```

Dans le lanceur de développement, sélectionner le serveur Metro local, puis exécuter le diagnostic. Le premier passage sans témoin affiche une information demandant un redémarrage ; après arrêt forcé, un nouveau passage doit vérifier le témoin avant les échanges. Un simple rechargement du runtime JS ne prouve pas un arrêt du processus. Ne pas effacer les données de l'application ni réinitialiser les stores pour contourner un échec. Aucun mécanisme de réinitialisation n'a été ajouté.

En cas de changement natif ultérieur, utiliser l'environnement Android configuré pour générer et compiler le projet depuis la configuration Expo ; par exemple `pnpm --filter @bunny-talks/mobile exec expo prebuild --platform android` puis la compilation Gradle dans `apps/mobile/android`, et installer l'APK obtenu avec `adb.exe -s emulator-5554 install -r <chemin-vers-apk>`. Vérifier la compatibilité et conserver les données ; `install -r` met à jour l'application existante, sans désinstallation. Les chemins du JDK/SDK et les commandes Gradle dépendent de l'environnement Windows ou WSL réellement configuré. Aucun service payant ou compte externe n'a été utilisé.

Les vérifications finales `pnpm test`, `pnpm typecheck`, `pnpm lint` et `pnpm format:check` réussissent. Les tests Node incluent les six tests mobiles du fournisseur d'aléa, du témoin et de l'état initial, ainsi que les tests de sécurité existants du moteur. Un export Metro Android a également réussi ; ce dernier n'est pas une preuve d'exécution native.

La qualification iOS, la sécurité du relay et l'autorisation réelle, les groupes, la rotation et les interruptions réelles restent à réaliser séparément. Aucun parcours de récupération complet n'est démontré.
