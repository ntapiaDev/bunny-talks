# Isolation des diagnostics cryptographiques — étape B1

**Verdict : accepté après revue indépendante** (`02f26fe83df645d901f05152572c6ac335134827`) dans le périmètre compilé, inspecté et qualifié synthétiquement. Le rendu de l’APK produit standard reste explicitement différé afin de préserver les applications historiques présentes sur l’unique AVD. Ce report n’est pas un PASS. Aucun diagnostic historique n’a été lancé et aucune donnée des applications existantes n’a été modifiée.

Ce rapport conserve la preuve B1. Pour la suite sur le même AVD, voir le [protocole de migration synthétique](android-crypto-synthetic-migration.md).

## Étape A clôturée

La revue indépendante de la révision `211f42c3366e3112bc6716c493b4b18013f2e065` accepte la séparation des racines produit et qualification. Les exports Metro rapportés en A étaient **iOS** ; ils établissent des graphes JavaScript distincts, pas le graphe natif d’un APK ni son exécution Android. Le développeur a confirmé `pnpm --filter @bunny-talks/mobile test` : 15 fichiers PASS/15, 173 tests PASS/173 en 6,55 secondes. Les deux suites anciennement bloquées par `spawnSync bash EPERM` sont comprises dans ces résultats. Aucun nouveau test A n’a été lancé.

## Verdict de l’APK produit

| Propriété        | Observation                                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction     | `:app:assembleRelease` a réussi le 27 novembre 2026 dans `apps/mobile/android`, sans installation. Gradle : Release, compile/target SDK 36, min SDK 24. La compilation a utilisé l’arbre et le cache Gradle locaux ; un hôte/build tree éphémère séparé n’a pas été établi pour cet APK. |
| Entrée et racine | Le journal Metro indique `apps/mobile/index.ts` et `586 modules`. Le code source de l’entrée importe d’abord `random-provider`, puis `src/product/App.tsx`.                                                                                                                              |
| Identité/version | `aapt dump badging` : `fr.bunnytalks.mobile`, version `0.1.0`, code 1.                                                                                                                                                                                                                   |
| Bundle           | `assets/index.android.bundle`, 1 156 012 octets, compilé par la tâche release React Native/Hermes ; `libhermesvm.so` est présent. Le marqueur `Bunny Talks` est présent dans le bundle.                                                                                                  |
| APK              | 94 653 218 octets ; SHA-256 `4100cdc9d464c0d550ae13590ecfe65d29a387c2f243765dad978348aa0fabc0`. Copie de revue : `/tmp/bunny-talks-b1-product.apk`.                                                                                                                                      |
| Signature        | Certificat Android Debug ; SHA-256 public `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`. Ce n’est pas une signature release de production.                                                                                                                          |

Le contrôle de l’APK et du bundle n’a trouvé ni les libellés distinctifs des écrans de diagnostic, ni les marqueurs de scénarios/vecteurs inspectés (`Bunny vault diagnostic`, `public native vault payload`, nom de store diagnostique), ni les chaînes de certificat recherchées. Aucun nom d’entrée APK ne correspond à `fixture`, `diagnostic`, `qualification`, `.pem` ou `.crt`. Cette recherche de marqueurs est une vérification ciblée, pas un décompilateur exhaustif ni une preuve cryptographique d’absence de tout code expérimental. La séparation Metro et les tests statiques de A complètent cette observation.

Le bundle produit contient les éléments de l’application minimale. Son rendu à l’écran reste **différé** : l’AVD `Pixel_8` contient déjà `fr.bunnytalks.mobile` et `fr.bunnytalks.mobile.httpsqualification`, dont les données doivent être préservées. L’APK standard n’a pas été installé et aucun contrôle de rendu produit n’a été fait.

Les bibliothèques natives autoliées restent dans l’APK : `libhermesvm.so`, `libexpo-sqlite.so`, `libargon2native.so`, `libargon2jni.so`, ainsi que `libexpo-modules-core.so` (notamment ABI arm64-v8a et x86_64). Leur présence native est légitime et conserve les capacités futures ; elle ne signifie pas que les scénarios crypto ou leurs vecteurs sont dans le bundle JavaScript produit. Aucun module natif n’a été retiré.

## Verdict de l’APK crypto dédié

Le profil Expo `BUNNY_CRYPTO_QUALIFICATION=synthetic` a été prébuildé depuis une copie temporaire de `apps/mobile` située sous `apps/`, liée au `node_modules` du workspace source. L’entrée `qualification/crypto/entry.tsx` a été sélectionnée (1029 modules). Le build Release a réussi avec `qualification/crypto/android.init.gradle`.

La cause confirmée de l’échec précédent était le graphe d’autolinking natif incomplet dans le staging isolé : le manifeste généré référençait les règles de sauvegarde SecureStore, mais le module natif `expo-secure-store` et ses ressources n’étaient pas dans le graphe Gradle effectif. La configuration Expo officielle et son plugin n’étaient pas en défaut. Le prebuild depuis la copie isolée correctement enracinée a fait apparaître `expo-secure-store@57.0.4` dans la résolution Expo/Gradle ; son AAR fournit les deux ressources XML attendues. Le manifeste et les exclusions de sauvegarde n’ont pas été affaiblis et aucun projet natif source n’a été modifié durablement.

L’APK dédié contient le bundle Hermes de l’entrée synthétique, SQLCipher, SecureStore, Argon2id natif et les ressources de sauvegarde SecureStore. `aapt` a confirmé les identifiants des deux ressources dans l’APK final ; le contenu des exclusions est corroboré par les ressources de l’AAR installé. Cette inspection n’est pas une qualification de sauvegarde Android sur appareil.

| Propriété        | Observation                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identité/version | `fr.bunnytalks.mobile.cryptoqualification`, version `0.1.0`, code 1                                                                                   |
| Signature        | Certificat Android Debug ; SHA-256 public `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`                                          |
| APK construit    | 99 560 442 octets ; SHA-256 `c8fc4ad277c842748d0346e748386367d7f2b7b5d13c91589d387b592ec56777` ; copie `/tmp/bunny-talks-b1-crypto.apk`               |
| APK installé     | SHA-256 identique après extraction depuis `emulator-5554`                                                                                             |
| Provenance       | Release assemblée depuis `apps/mobile-b1-crypto/android` avec le profil synthétique et l’entrée de qualification ; bundle Hermes embarqué, sans Metro |

Le contrôle de l’APK produit standard réutilise l’artefact accepté : son empreinte reste `4100cdc9d464c0d550ae13590ecfe65d29a387c2f243765dad978348aa0fabc0`. Il n’a pas été installé sur cet AVD.

## Résultats d’exécution et persistance

ADB Windows `/mnt/c/Users/Nicolas/AppData/Local/Android/Sdk/platform-tools/adb.exe` a identifié `emulator-5554`, AVD `Pixel_8`, utilisateur 0 et `sys.boot_completed=1`. Avant installation, `pm path` a confirmé les deux paquets présents et l’absence de `fr.bunnytalks.mobile.cryptoqualification`. Seul l’APK synthétique dédié a été installé ; les chemins installés de `fr.bunnytalks.mobile` et `fr.bunnytalks.mobile.httpsqualification` sont restés identiques après les essais. L’APK produit standard n’a pas été installé. L’émulateur est resté ouvert.

Le paquet synthétique a démarré depuis son bundle embarqué (`LaunchState: COLD`, activité `MainActivity`), sans Metro. Les diagnostics ont affiché PASS pour Hermes, UTF-8 strict, SQLCipher, identité et stores locaux, chiffrement/déchiffrement, reprise, fermeture, clés absentes/incorrectes, et rejet d’une base de test non chiffrée. Le témoin Core existant a été reconnu après le nouveau runtime JS avant d’enregistrer le témoin actualisé. Les contrôles rapides du coffre ont validé la génération native, le vecteur HKDF, la publication/manifeste et les refus d’entrée altérée ou de mauvaise clé.

Le diagnostic natif du coffre a passé : création (2 KDF), ouvertures par mot de passe et récupération, réenveloppement avec l’ancien mot de passe, réouverture après réenveloppement, réenveloppement par récupération, contrôles de manifeste et deux accès finaux, rejets de mots de passe/récupération/contexte incorrects, et concordance d’un vecteur indépendant Node vers Android. Il a persisté la publication synthétique dans SecureStore. Le compteur observé est resté sous le budget du scénario (12/16 KDF avant persistance). Après `am force-stop` du seul paquet synthétique, le nouveau PID (`24070`, ancien `22966`) a vérifié le témoin Core « après nouveau runtime JS » puis a rouvert la publication persistée avec les deux accès via un nouveau contrôleur (855 ms). Aucun état divergent n’a été remplacé par des données neuves.

Ces résultats qualifient uniquement ces scénarios synthétiques sur cet AVD x86_64 et cette build Debug-signed Release. Ils ne qualifient ni Android Keystore, ni sauvegarde/restauration système, ni appareil physique, ni iOS, ni production.

## Inventaire de l’environnement historique

L’AVD `Pixel_8` est partagé avec deux applications historiques installées. Les métadonnées Package Manager ont été lues pour confirmer leur présence et préserver leur chemin d’installation ; leurs données, contenus privés, bases et valeurs SecureStore n’ont pas été ouvertes, lues, exportées ou modifiées. Aucun diagnostic historique ni mise à jour n’a été effectué. B2 reste hors périmètre.

## Procédure Android effectivement utilisée

Prérequis pour reproduire ce contrôle : démarrer l’unique AVD `Pixel_8` et rendre l’ADB Windows accessible depuis WSL. Metro, Docker, l’API et la fixture HTTPS ne sont pas requis : le paquet crypto embarque son bundle synthétique. Avant installation, confirmer explicitement l’AVD, `sys.boot_completed`, l’absence du paquet crypto et la présence des deux paquets historiques. N’installer que l’APK synthétique construit sous son identifiant distinct ; ne pas installer l’APK produit sur cet AVD.

```bash
ADB=/mnt/c/Users/Nicolas/AppData/Local/Android/Sdk/platform-tools/adb.exe
"$ADB" devices -l
"$ADB" -s emulator-5554 emu avd name
"$ADB" -s emulator-5554 shell getprop sys.boot_completed
"$ADB" -s emulator-5554 shell pm path fr.bunnytalks.mobile
"$ADB" -s emulator-5554 shell pm path fr.bunnytalks.mobile.httpsqualification
"$ADB" -s emulator-5554 shell pm path fr.bunnytalks.mobile.cryptoqualification
# Run install only if the preceding check confirms the synthetic package is absent.
"$ADB" -s emulator-5554 install /tmp/bunny-talks-b1-crypto.apk
"$ADB" -s emulator-5554 shell am start -W -n fr.bunnytalks.mobile.cryptoqualification/.MainActivity
"$ADB" -s emulator-5554 shell am force-stop fr.bunnytalks.mobile.cryptoqualification
"$ADB" -s emulator-5554 shell am start -W -n fr.bunnytalks.mobile.cryptoqualification/.MainActivity
```

L’installation n’est applicable que si les contrôles préalables confirment que `fr.bunnytalks.mobile.cryptoqualification` est absent. Entre le premier lancement et l’arrêt forcé, exécuter les scénarios synthétiques depuis l’écran et conserver les témoins assainis. L’arrêt forcé ci-dessus ne concerne que ce paquet synthétique. Ne pas désinstaller d’application, effacer de données ou fermer l’émulateur.

## Nettoyage et investigation des chemins parasites

Le fichier `app.json` racine était absent à l’inspection, ainsi que toute référence projet à `com.lardeur.bunnytalks`. Son origine ne peut donc pas être attribuée à partir de l’état actuel. Les configurations Expo de référence restent `apps/mobile/app.json` et `apps/mobile/app.config.ts`; toutes les commandes Expo de B1 ont été exécutées depuis le workspace mobile ou sa copie temporaire, jamais depuis la racine.

Les répertoires `.aws` et `.codex` étaient vides, mais `mountpoint` les identifie comme des points de montage externes. Leur suppression a échoué avec `Device or resource busy`; ils ont été laissés intacts. `HOME` était défini, tandis que `CODEX_HOME`, `AWS_CONFIG_FILE` et `AWS_SHARED_CREDENTIALS_FILE` étaient absents. La recherche du dépôt n’a trouvé aucune référence de script/configuration qui les crée. Leur montage relève donc de l’environnement externe au dépôt ; leur origine précise et leur recréation après démontage ne sont pas établies. En C, le développeur a décidé de conserver le `.gitignore` sans exclusions spécifiques pour ces montages.

Le clone temporaire `apps/mobile-b1-crypto` a été supprimé après construction et qualification ; l’APK de preuve demeure dans `/tmp`. Aucun changement de source crypto, de protocole, de dépendance ou de projet Android généré n’a été conservé.

OpenE2EE 14.5.0 et le coffre V1 restent expérimentaux. B1 ne qualifie ni iOS, ni appareil physique, ni release de production, ni Android Keystore, ni la reprise de données historiques. SEC-CRYPTO-002 et SEC-CRYPTO-003 demeurent ouverts et bloquants avant production.
