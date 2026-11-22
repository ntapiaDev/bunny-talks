# Fondation HTTPS mobile

## Implémentation et verrou iOS

Le port HTTP TypeScript valide l’origine applicative, les méthodes, les en-têtes et la réponse. L’adaptateur natif transmet le budget de réponse et le délai, annule la réservation et écarte un résultat arrivé après l’annulation ou l’échéance. La composition charge aujourd’hui `ApplicationHttps` sur Android et renvoie `configuration` sur iOS avant tout appel réseau. Le banc iOS charge directement le module Expo avec des données factices. Les véritables secrets applicatifs restent interdits sur iOS. [Contrat HTTP mobile](mobile-application-http.md) · [Composition](../../apps/mobile/src/composition/http-composition.ts) · [Adaptateur](../../apps/mobile/src/infrastructure/http/native-https-transport.ts)

Sur iOS, Swift sérialise la réservation, le délai et le règlement des promesses. Le travailleur conserve le contexte jusqu’au retour de C. Le verrou de réveil protège le retrait du multi contre `curl_multi_wakeup`. C retire l’easy du multi, détruit l’easy puis le multi avant que Swift restitue la place. C libère les buffers d’échec et transfère le buffer de succès à `Data` avec un seul propriétaire de libération. La file Swift consomme la promesse une fois. Une annulation en cours conserve la place jusqu’à la fin du travailleur. La troisième réservation est refusée immédiatement. Le plafond est de **1 048 576 octets décodés par réponse** et le module admet **deux opérations simultanées**. Les copies du pont et les résultats conservés en JavaScript contribuent aussi à la mémoire du processus. [Transport Swift](../../apps/mobile/modules/application-https/ios/CurlHttpsTransport.swift) · [C et contrat de propriété](../../apps/mobile/modules/application-https/ios/Native/BunnyHttpsNative.h)

Le C utilise libcurl 8.23.0, OpenSSL 3.5.9, la confiance système via SecTrust et zlib système pour le gzip. Les réglages limitent les échanges à HTTPS, TLS 1.2–1.3 et HTTP/1.1 avec validation de la chaîne et du nom d’hôte. Le garde avant émission, l’absence de suivi de redirection et l’isolement des connexions, des cookies et des identifiants ambiants soutiennent le contrat d’émission unique. Les erreurs publiques sont des catégories fixes. Le profil factice ajoute des diagnostics énumérés et limite le module à `https://localhost` sur les ports de la fixture. La CA est générée sur le worker et installée sur le simulateur jetable. Le pod réserve les macros du banc à `BUNNY_IOS_HTTPS_QUALIFICATION=1` avec une identité et un point d’entrée dédiés qui concordent. Si la variable est définie à `1` pour le projet standard, le podspec interrompt son évaluation. La configuration Expo standard impose les réglages ATS par défaut, sans exception déclarée. [Réglages C](../../apps/mobile/modules/application-https/ios/Native/BunnyHttpsNative.c) · [Podspec](../../apps/mobile/modules/application-https/ios/ApplicationHttps.podspec) · [ATS](https://developer.apple.com/documentation/security/preventing-insecure-network-connections)

## Preuves acceptées

| Contrôle                         | Résultat et portée                                                                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS 4.5B2C3-C                    | Build `d2c0010c-768c-4fdf-bbb3-d427fe6e0fae`, révision `7d6b6f1bd91877832d45baaa6e04dc4e8b2d8eaa`, Mach-O SHA-256 `cecfd1446564a6c7c3a8a77db4bcb851c43b4ea1e01b0d1e058e1b7913a85e3c`. iPhone 17 Simulator arm64, iOS 26.5 (23F77), Hermes, Release, Xcode 26.6 (17F113).                                  |
| Runtime, provenance et nettoyage | Compilation, 101 scénarios runtime corrélés, témoin anti-réémission et nettoyage PASS. Liaison PASS pour `_curl_multi_perform`, `_curl_version_info` et `_OPENSSL_init_ssl` et leurs fournisseurs attendus. Aucun fournisseur supplémentaire pour ces trois symboles parmi les huit frameworks inspectés. |
| Verdict global iOS               | `NOT_RUN` avec `memory-attribution-required`. Attribution par couche reportée. Relevés RSS disponibles.                                                                                                                                                                                                   |
| Android                          | 11 groupes du banc factice sur émulateur Android 17 avec Hermes. Inspection de l’APK Release standard pour l’isolement de la CA de test. Comportement réseau de cet APK à qualifier.                                                                                                                      |

[Rapport de clôture](native-https-transport.md#clôture-humaine-de-45b2c3-c) · [Sept preuves du build iOS accepté](evidence/ios-libcurl-d2c0010c/) · [Qualification Android](native-https-transport.md#revue-de-sécurité-et-consolidation)

## Approvisionner les XCFrameworks

Utiliser une copie locale du ZIP `apple-xcframeworks-44942974411-1` ou en obtenir une depuis un stockage durable explicitement approuvé. Le SHA-256 imposé est `57908367212fb83b17b830e1aa69c0e4282e7afbb4fd368294943216f625d841`. Le paquet contient quatre archives statiques de libcurl 8.23.0 et OpenSSL 3.5.9, pour `iphoneos` arm64 et `iphonesimulator` arm64, avec un minimum déclaré iOS 16.4. Conserver le ZIP original octet pour octet. [Construction de référence](native-https-transport.md#pass-de-construction-45b2c3-a)

Depuis la racine, définir `approved_zip` sur le chemin absolu de la copie et exécuter avec Python 3 ceci.

```sh
verifier=apps/mobile/modules/application-https/ios/verify_xcframeworks.py
python3 -I "$verifier" install "$approved_zip"
```

Le vérificateur contrôle l’empreinte, l’inventaire, le manifeste et les quatre archives avant de publier le ZIP dans `apps/mobile/modules/application-https/ios/vendor/xcframeworks.zip`. Une copie identique déjà installée est réutilisée. Un ZIP absent, divergent ou symbolique, un répertoire `vendor` symbolique ou un contenu inattendu entraînent un refus. Le mode `archive` vérifie la source seule. CocoaPods prépare `vendor/package/` à partir du ZIP vérifié. Le pod revérifie l’extraction avant compilation et déclare uniquement `curl-COPYING` et `openssl-LICENSE.txt` dans son bundle de ressources. `vendor/` et le projet iOS généré sont ignorés par Git. Le mode `install` travaille sur des fichiers locaux. [Vérificateur](../../apps/mobile/modules/application-https/ios/verify_xcframeworks.py) · [Podspec](../../apps/mobile/modules/application-https/ios/ApplicationHttps.podspec) · [Exclusions](../../.gitignore)

**Disponibilité le 22 novembre 2026.** Des copies locales de 9 347 881 octets ont été retrouvées dans `/tmp`, dont `/tmp/bunny-approved-14723035221.zip`. L’empreinte mesurée correspond au pin. Le manifeste a le SHA-256 `b0c44eb42ad6d837771b5bdca813d98fb6981a12d6957f088d8b0bf2b288b780`. Les quatre archives et les notices ont été contrôlées. La copie installée et le paquet extrait dans `vendor/` ont été revérifiés. La disponibilité d’une copie sur le prochain Mac et celle d’un stockage durable partagé restent à confirmer.

Si la copie approuvée devient indisponible, la préparation qui dépend du binaire est bloquée. Toute reconstruction demande une décision humaine. La recette de référence utilise les deux archives amont vérifiées, Node 24 arm64, Xcode 26.6 (17F113) et les SDK 26.5. Pour adopter un ZIP d’empreinte différente, revoir la provenance, l’épinglage et la qualification. [Recette Apple](../../experiments/libcurl-apple-xcframework/build.mjs)

## Préparer le projet iOS standard

Utiliser Node 24, pnpm 10.34.9 et les dépendances du lockfile. Pour installer les pods et compiler, prévoir un Mac Apple Silicon, Xcode avec les SDK iOS et simulateur, Ruby, CocoaPods et Python 3 dans le `PATH` de CocoaPods et de Xcode. Partir d’une copie de travail dédiée dont `apps/mobile/ios/` est absent. Après approvisionnement, générer le projet sans installation automatique des pods, puis installer les pods séparément sur le Mac autorisé.

```sh
pnpm install --frozen-lockfile
env -u BUNNY_IOS_HTTPS_QUALIFICATION -u EXPO_PUBLIC_USE_RN_FETCH \
  EXPO_NO_DOTENV=1 EXPO_OFFLINE=1 EXPO_NO_GIT_STATUS=1 \
  pnpm --filter @bunny-talks/mobile exec expo prebuild --platform ios --no-install --no-clean
(
  cd apps/mobile/ios
  env -u BUNNY_IOS_HTTPS_QUALIFICATION -u EXPO_PUBLIC_USE_RN_FETCH EXPO_NO_DOTENV=1 pod install
)
```

Le projet standard utilise l’identité `fr.bunnytalks.mobile`, le schéma `bunnytalks` et l’entrée `index.ts`. Expo découvre le module local sous `modules/application-https` et résout `ApplicationHttpsModule` et son podspec pour Apple. Le pod sélectionne la tranche arm64 par SDK, exclut le simulateur x86_64 et déclare Security, CoreFoundation, CoreServices et zlib. La cible minimale de l’app et celle du pod sont iOS 16.4. Les profils dans `eas.json` appartiennent au banc qui génère ses propres identités et entrées dans son espace temporaire. Pour une Release standard, utiliser les paramètres et les éventuels éléments de signature du projet applicatif. [Configuration Expo](../../apps/mobile/app.json) · [Autolinking Expo](https://docs.expo.dev/modules/autolinking/) · [Cible minimale Expo](https://docs.expo.dev/versions/v57.0.0/config/app/#deploymenttarget)

| Contrôle 4.5B2C4-A            | Résultat et portée                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZIP et extraction             | `PASS` sous Linux. Copie réelle acceptée. ZIP absent, ZIP altéré, incohérences de manifeste et d’archive et chemins symboliques refusés. Installation réexécutable sans remplacer la copie approuvée.                                                                                                     |
| Configuration iOS             | `PASS` sous Linux, sur la configuration Expo résolue et un projet iOS jetable généré avec `--no-install`. Identité standard, cible 16.4, Podfile et Info.plist contrôlés. L’Info.plist généré a ATS actif et aucune exception `localhost`. Aucun certificat de fixture dans les sources natives générées. |
| Module et composition         | `PASS` sous Linux. Autolinking Expo Apple et Android, refus iOS avant chargement natif et appel Android au module avec un substitut de test. Les arbres Android générés avec et sans les changements iOS sont identiques.                                                                                 |
| CocoaPods et Release standard | `NOT_RUN`. L’installation native et l’inspection des réglages effectifs, de la liaison Mach-O, des notices et des ressources de l’application requièrent l’environnement Apple prévu pour B.                                                                                                              |
| Comportement natif            | `NOT_RUN` pour la Release iOS standard, la confiance TLS, iOS 16.4, l’appareil physique et Android natif dans A. Le verdict historique d’attribution mémoire par couche reste `NOT_RUN`.                                                                                                                  |

Le jalon a exécuté 154 tests Vitest ciblant la configuration, la composition, HTTP, le diagnostic local et le staging historique, ainsi que 7 tests Python d’approvisionnement avec le ZIP réel. Le contrôle Node de la recette Apple, le typecheck mobile, ESLint et Prettier ciblés ont réussi. La génération Expo du fournisseur Swift référence `ApplicationHttpsModule`. Les contrôles de staging ont utilisé des espaces temporaires locaux.

## Reprendre les contrôles

Depuis la racine, les contrôles TypeScript, Python et Node couvrent le port, l’adaptateur, les preuves, le vérificateur XCFramework et les oracles. Les tests C exercent notamment le cadrage, le gzip, le rejet d’une seconde émission et l’ordre de nettoyage. Les compiler avec les en-têtes libcurl 8.23.0, zlib et pthreads, avec puis sans `-DBUNNY_HTTPS_QUALIFICATION=1`. Ajouter ASan et UBSan si le compilateur le permet. Les suites de fixture utilisent le loopback et des certificats générés. [Tests C et inspecteurs](../../apps/mobile/qualification/tests/) · [Harnais anti-réémission](../../experiments/libcurl-single-emission/)

```sh
pnpm --filter @bunny-talks/mobile exec vitest run tests/application-http.test.ts tests/native-https-transport.test.ts tests/https-fixture.test.ts tests/https-evidence.test.ts tests/ios-eas-archive.test.ts
node --test apps/mobile/qualification/tests/ios-libcurl-runtime.test.mjs
python3 -IB apps/mobile/qualification/tests/ios-xcframeworks.test.py
python3 -IB apps/mobile/qualification/tests/ios-libcurl-link.test.py
python3 -I apps/mobile/modules/application-https/ios/verify_xcframeworks.py archive "$approved_zip"
```

Pour reprendre la qualification iOS, fournir le chemin absolu du ZIP à `BUNNY_IOS_XCFRAMEWORK_ZIP`. Cette variable active aussi les deux tests Vitest de staging avec le ZIP approuvé. Le script prépare `ios-https-libcurl-build` par défaut ou `ios-https-libcurl-runtime` avec `--runtime` et une révision revue dans `BUNNY_IOS_RUNTIME_REVISION`. Vérifier la copie liée et l’archive inspectée avec le même mode, `--check`, `EAS_NO_VCS=1` et `EAS_PROJECT_ROOT` explicite. Un nouveau build relève d’une décision humaine et d’un environnement isolé sans secrets. L’archive URLSession conserve le Swift, le profil et le script historiques. Le parseur de traces et l’entrée partagée avec Android restent disponibles. Reprendre la révision historique pour reproduire un build URLSession. [Staging](../../apps/mobile/qualification/prepare-ios-eas.sh) · [Procédure de qualification](native-https-transport.md#carte-de-liens-et-autorisation-du-premier-build) · [Archive URLSession](../../apps/mobile/qualification/archive/urlsession/)

## Réserves et requalification

- **Avant diffusion.** Exécuter iOS 16.4 et une Release signée sur appareil physique, avec cycle de vie et interruptions. Qualifier l’origine approuvée, les refus de confiance et de nom, puis inspecter la Release standard pour l’absence de CA de fixture, de macros, d’entrée de banc et d’exception ATS. Étendre l’audit aux fournisseurs de symboles hors des trois cibles et aux duplications de code, y compris dans les frameworks livrés. [Critères Release](native-https-transport.md#séquence-de-qualification-et-critères-dacceptation)
- **Ressources.** Une connexion privée par requête peut répéter la résolution DNS, l’établissement TCP et la négociation TLS. Mesurer latence et mémoire sur des charges représentatives, au repos puis avec une et deux opérations. En l’absence d’anomalie, reporter l’attribution exhaustive par couche. Une dérive reproductible déclenche une mesure ciblée du natif, du pont ou d’Hermes selon le signal. [Relevés du simulateur](native-https-transport.md#troisième-qualification-runtime-eas)
- **Déclencheurs.** Requalifier les propriétés touchées après un changement de versions, d’empreintes ou d’options natives, de chaîne d’outils ou de cible iOS, de liaison, de confiance TLS ou d’origine, de protocole et de réutilisation des connexions, de cadrage et de compression, ou du cycle de vie Swift/Expo/Hermes. Rejouer le témoin anti-réémission et les scénarios d’interruption pertinents sur l’artefact concerné lorsque le transport ou sa liaison évolue.
- **Maintenance.** Le mainteneur du transport suit les avis officiels de libcurl et OpenSSL, vérifie l’applicabilité à la configuration embarquée et prépare la reconstruction, la mise à jour des empreintes et la requalification des propriétés touchées. Vérifier les avis avant toute diffusion et à chaque alerte. Les archives statiques évoluent par reconstruction et redistribution de l’application.

## Conditions pour 4.5B2C4-B

1. Après revue humaine de A et autorisation explicite de B, mettre la même copie approuvée à disposition sur le Mac. Relever les versions de Xcode, des SDK, de CocoaPods et le `Podfile.lock` résolu. Vérifier le pod, l’identité et les réglages effectifs de la Release standard, puis la tranche liée, la provenance, les notices et le contenu de l’artefact. Confirmer l’absence de CA, de macros, d’entrée du banc et d’exceptions ATS dans cette Release.
2. Qualifier la confiance TLS sur la Release standard avec des données factices, une origine approuvée et hors fixture, une CA non approuvée, un mauvais nom d’hôte et des chaînes invalides. Exécuter iOS 16.4 et la Release signée sur appareil physique dès que ces cibles sont disponibles.
3. Pour les étapes ultérieures, vérifier les issues métier incertaines après une coupure et la réconciliation propre à chaque opération, en conservant l’absence de renvoi automatique. Mesurer la latence et la mémoire sur des charges représentatives, notamment le coût des connexions sans réutilisation.
4. Soumettre toute ouverture de parcours sensibles à une décision humaine distincte, fondée sur la Release effectivement livrée, la liaison et la provenance, la validation des DTO, l’isolation des comptes et des appareils, le stockage sécurisé des sessions et le traitement des issues incertaines. [Contrat HTTP mobile](mobile-application-http.md) · [Modèle de menace](../security/threat-model.md)
