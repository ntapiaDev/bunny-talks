# Évaluation du transport HTTPS natif — jalon 4.5B2B

L’audit initial date du 17 novembre 2026. Les sections historiques décrivent l’inspection du prototype et les essais de la fixture. Le 19 novembre, les événements serveur et les mesures brutes du PID 19746 confirment la charge obligatoire, la réutilisation des places et une récupération native suivie d’une remontée. La trace du PID 24878 attribue la hausse dominante au stockage des réponses dans Hermes. Leur accessibilité après collecte reste à établir. **Aucun transport n’est qualifié pour des identifiants réels.** [Audit mémoire Android](android-https-memory-audit.md)

## Comparaison et décision provisoire

| Candidat                 | Version, licence et intégration                                                                                                                                                                                                                                                                                                       | Évaluation                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expo/fetch`             | Expo installé 57.0.25, licence MIT ; React Native installé 0.86.3 ; déjà présent, Android et iOS, New Architecture active dans le projet Android.                                                                                                                                                                                     | Écarté pour le contrat actuel : tampon natif non borné avant le démarrage du flux ; chemin Android de lecture interrompue susceptible de marquer le corps comme terminé. Des garanties supplémentaires restent à mesurer.                                                                                                                                                                         |
| `react-native-blob-util` | Version publiée 1.1.1, MIT ; sa documentation annonce RN >= 0.84, New Architecture uniquement, Android minSdk 24 et iOS 15.1. Development Build et autolinking, CocoaPods sur iOS ; OkHttp de RN sur Android. Non installé ni compilé ici avec Expo 57.0.25/RN 0.86.3.                                                                | Écarté en l'état : sa documentation annonce le partage des cookies avec les autres requêtes de l'application, et la réponse JSON ordinaire est conservée en mémoire. L'écriture sur fichier puis lecture du fichier ne garantit pas une limite avant stockage. Les détails natifs de la version exacte n'ont pas pu être consultés ; compatibilité effective et autres propriétés non démontrées. |
| Module Expo local        | Pas de version publiée ni de licence tierce nouvelle ; utilise les dépendances et licences de la plateforme et d'OkHttp déjà embarqué, à inventorier pour la livraison. Kotlin/OkHttp sur Android, Swift/URLSession sur iOS ; reconstruction native et CocoaPods nécessaires. Expo Modules annonce le support de la New Architecture. | Piste recommandée pour une expérimentation ultérieure, pas une décision de production : contrôle précis possible, mais code, sécurité, compatibilité, essais et maintenance des deux plateformes à la charge du projet.                                                                                                                                                                           |

Sources : [Expo SDK 57](https://expo.dev/changelog/sdk-57), [Expo Modules](https://docs.expo.dev/modules/overview/), [documentation blob-util](https://github.com/RonRadtke/react-native-blob-util#readme), [publication 1.1.1](https://github.com/RonRadtke/react-native-blob-util/releases/tag/1.1.1), [package npm](https://www.npmjs.com/package/react-native-blob-util). La version 1.1.1 est récente et maintenue selon sa publication ; ses changements récents touchent notamment les nouvelles tentatives de POST, ce qui justifie de suivre les versions et d'examiner les mises à jour. Ne pas activer `trusty` ni supposer qu'un paramètre de certificat personnalisé équivaut au contrat. Une bibliothèque plus large introduirait également des permissions et fonctions natives sans rapport avec ce besoin.

## Preuves dans Expo 57.0.25 installé

Les chemins suivants sont relatifs à `apps/mobile/node_modules/expo/` ; ils décrivent le package installé, pas nécessairement le binaire présent sur l'émulateur.

- `android/src/main/java/expo/modules/fetch/NativeRequest.kt` désactive `followRedirects` et `followSslRedirects` si le mode n'est pas `FOLLOW`, et utilise `CookieJar.NO_COOKIES` si les credentials ne sont pas `INCLUDE`. C'est une preuve de configuration du code, pas une observation réseau ni une preuve de l'absence de tous les autres mécanismes d'authentification ambiante. Sur iOS, `ios/Fetch/NativeResponse.swift` passe `nil` au gestionnaire de redirection hors mode `follow` ; `ExpoURLSessionTask.swift` désactive `httpShouldHandleCookies` hors `include`. La configuration iOS utilise néanmoins une session partagée avec stockage de cookies : absence d'effet ambiant à vérifier expérimentalement.
- Android `NativeResponse.kt` pompe les octets dès les en-têtes. Avant `startStreaming`, il les ajoute à `ResponseSink.kt`, dont la liste n'a pas de limite. Les événements suivants n'établissent pas non plus une contre-pression de bout en bout. iOS `NativeResponse.swift` et `ResponseSink.swift` ont aussi une file non bornée avant le flux. La limite JS de `application-http.ts` arrive donc trop tard pour garantir une borne native.
- [Expo #50213](https://github.com/expo/expo/issues/50213) décrit deux défauts. Dans la version installée, Android `pumpResponseBodyStream` enregistre l'`IOException` et passe à `ERROR_RECEIVED`, puis `onResponse` passe inconditionnellement à `BODY_COMPLETED`. Selon le moment de la coupure et le mode de lecture, une erreur peut être écrasée ; le flux déjà démarré émet aussi `didFailWithError`, donc ne pas généraliser ce constat à tous les flux. Sur iOS, `ExpoFetchModule.swift` attend uniquement `.bodyCompleted` pour `text()` et `arrayBuffer()` alors que l'échec passe à `.errorReceived` : la cause du blocage des lecteurs tamponnés demeure. Le flux est distinct et n'est pas qualifié pour autant.
- [Expo #50212](https://github.com/expo/expo/issues/50212) : `FetchErrors.ts` étend toujours `Error`, et `fetch.ts` enveloppe l'erreur native avec sa `cause` plutôt que l'erreur elle-même. Avant réponse, l'annulation en cours peut perdre la raison ; après réponse, `response.abort(signal.reason)` traite séparément le flux. Le client applicatif assainit les erreurs et maintient son propre timeout, mais cela ne démontre pas l'arrêt du travail natif.
- Le client Android est construit depuis `OkHttpClientProvider` dans `ExpoFetchModule.kt` et ajoute `TransparentCompressionInterceptor` (gzip, br, zstd). Aucun contournement TLS ou vérificateur de nom personnalisé n'a été constaté dans les fichiers examinés ; les réglages effectifs hérités et les certificats valides/invalides doivent encore être vérifiés. La limite doit porter sur les octets **décompressés**, sans supposer que `Content-Length` correspond à ceux-ci. La décompression iOS et son coût restent à qualifier.

Le contrat applicatif exige des octets décodés progressivement, la validation TLS, aucun identifiant ambiant et l'arrêt avant suivi d'une redirection. Il copie les morceaux et borne leur somme côté JS ; il annule dans `finally`, y compris sur dépassement et timeout. `Promise.race` borne l'attente de l'appelant mais ne prouve pas que la requête ou les lectures natives cessent. Une réponse JSON tronquée mais syntaxiquement complète ne doit pas être acceptée silencieusement.

## Protocole reproductible proposé

À implémenter dans un outil isolé de NestJS et PostgreSQL. Utiliser uniquement des valeurs factices, un serveur HTTPS A, une destination HTTPS B et une destination HTTP C, chacun avec compteur de requêtes indépendant ; disposer d'un canal de contrôle local séparé pour remettre les compteurs à zéro et les lire. Identifier chaque cas par un identifiant aléatoire non sensible ; journaliser uniquement identifiant, méthode, chemin, présence des en-têtes et nombre d'octets, jamais leur valeur. L'en-tête artificiel `Authorization: Bearer fixture-only` n'est pas un secret. Isoler les interfaces d'écoute et arrêter les serveurs après essai.

1. Générer hors dépôt une CA de développement et une feuille avec SAN IP `10.0.2.2` ; garder les clés privées sous `/tmp` avec permissions restrictives. Configurer A et B avec un certificat valide pour leur hôte et la CA locale. Prévoir une seconde CA non approuvée et un certificat signé par la CA approuvée mais sans SAN correspondant. Vérifier la chaîne et les SAN avec `openssl verify` et `openssl x509`; ne jamais désactiver TLS ou la vérification de nom. Vérifier d'abord, depuis l'émulateur, le routage vers A et B ; `10.0.2.2` désigne l'hôte de l'émulateur Android standard et l'accès WSL2 peut nécessiter une configuration réseau supplémentaire.
2. En build debug seulement, utiliser une configuration Android `networkSecurityConfig` avec `debug-overrides` et une ressource CA **publique** réservée au debug, sans remplacer les ancres de production. Le manifeste et les ressources générés doivent être contrôlés dans l'APK debug et l'APK release fusionnés : aucun certificat ou override de développement en release, `android:debuggable=false`, ancres système inchangées. Le mécanisme et ses limites sont décrits par [Android](https://developer.android.com/privacy-and-security/security-config#debug-overrides). Toute modification native exige reconstruction et réinstallation sans effacer les données. Aucune configuration native ni APK release n'a été créée ou vérifiée ici.
3. Définir des endpoints A pour JSON UTF-8 avec octets multilingues, envoi en morceaux temporisés, corps dépassant la limite après décompression, corps gzip compressé, `Content-Length` annoncé puis fermeture prématurée après un préfixe JSON syntaxiquement valide, et réponse lente maintenant la connexion ouverte. Comparer les octets reçus à la fixture ; observer côté serveur fermeture effective, après une fenêtre fixée, lors d'un abort volontaire, d'un timeout et d'un dépassement. Mesurer le pic mémoire natif et JS avec producteur plus rapide que consommateur, avant et pendant la lecture ; une lecture par événements sans contre-pression ni plafond est insuffisante.
4. Pour chaque statut 301, 302, 303, 307 et 308, envoyer GET puis POST avec corps factice et en-tête Authorization factice : même hôte, autre hôte B et HTTPS vers HTTP C. Remettre les compteurs à zéro entre chaque cas ; vérifier que A a reçu une seule requête, et **B/C ou le chemin cible sur A zéro**, y compris après délai et annulation. Une erreur côté client seule n'est pas une preuve. Tester aussi une réponse 3xx sans `Location`.
5. Préinstaller un cookie factice via une session de contrôle, puis demander à A de renvoyer `Set-Cookie` ; inspecter les requêtes suivantes et le stockage via le contrôle, sans exposer les valeurs dans les journaux. Vérifier également l'absence d'authentification implicite et de cache partagé. Une réponse valide doit réussir avec la CA et le SAN corrects ; la CA inconnue et le mauvais SAN doivent échouer sans requête HTTP applicative reçue. Un certificat public valide connu constitue un contrôle séparé, sans secrets et sans dépendre d'un service tiers pour les cas sensibles.
6. Exécuter chaque cas sur Android puis iOS, en variant l'arrivée avant et après le premier appel de lecture, en répétant les courses et en enregistrant versions exactes, variante, horodatage, compteurs, erreurs assainies, mémoire et arrêt serveur. Comparer également les délais et annulations pendant résolution, connexion, en-têtes et corps. Une simulation Node peut valider la fixture mais ne qualifie pas un client natif.

## Projet minimal de module, sans implémentation

Construire un client dédié sans cookies, cache ni authentificateur implicite ; Android : OkHttp avec redirections HTTP et HTTPS désactivées et confiance/vérification de nom par défaut ; iOS : session dédiée sans stockage de cookies ni credentials et délégué de redirection refusant le suivi. Ne pas remplacer les vérificateurs TLS. Les paramètres exacts et leur effet sont à auditer sur les versions effectivement utilisées.

Proposer une lecture à la demande avec taille maximale native fixe et contre-pression réelle ; limiter les octets décompressés avant leur transfert JS, propager la fermeture prématurée comme erreur, annuler et fermer la réponse native à chaque sortie. Borner également les files de messages et les requêtes simultanées. Les événements poussés sans accusé de réception ne suffisent pas à assurer cette borne. Définir explicitement le traitement des encodages, des réponses 204, des statuts 3xx et de la fermeture anticipée ; vérifier les courses entre annulation, erreur et fin. Ce projet nécessite une revue de conception avant intégration, une qualification sur les deux plateformes et une maintenance suivie des mises à jour Expo/RN et des bibliothèques natives.

## Résultats et limites

- **Garantie démontrée par inspection** : la configuration native Expo installée désactive les suivis automatiques Android pour le mode approprié ; iOS refuse le suivi dans son délégué. Ce constat est limité au code examiné et ne remplace pas les compteurs réseau.
- **Défaut bloquant** : les files Expo préalables au flux ne sont pas bornées ; la limite applicative ne garantit donc pas une mémoire native bornée. Le chemin Android de coupure peut écraser l'état d'erreur. Blob-util documente l'envoi de cookies partagés et la conservation en mémoire de JSON.
- **Non démontré** : TLS et noms d'hôtes réels, isolation complète des credentials, octets et décompression, contre-pression, arrêt effectif après timeout, compatibilité compilée blob-util, état effectif release et comportement des deux plateformes. ADB hors bac à sable démarre mais `adb devices -l` ne liste aucun appareil ; aucun POC ni test natif n'a été exécuté. L'export Metro ne constitue pas une compilation native ni une qualification Android. iOS reste ouvert.
- **Amélioration facultative** : automatiser ultérieurement les compteurs et mesures mémoire dans une suite d'intégration locale. Aucun contrôle temporaire n'a été ajouté à l'application.

## Actualisation — prototype Android à accumulation bornée

La revue humaine autorise l'étude de petites réponses complètes. Les sections précédentes décrivent l'audit initial ; la fixture et le prototype existent désormais. **4.5B2B reste ouvert, aucune qualification sur appareil n'a été observée.** Aucun travail iOS n'est entrepris.

### Stratégie et contrat

La stratégie B est retenue pour le prototype : lecture progressive native du corps décompressé dans un tableau fixe de 1 à 1 048 576 octets, lecture d'un octet supplémentaire pour détecter un dépassement, puis transfert unique du tableau final. Le lecteur ne transforme pas les octets UTF-8. Un EOF normal termine la lecture ; toute erreur de lecture détectée est propagée, même après un préfixe JSON valide. Une longueur annoncée supérieure aux octets transmis doit être détectée par OkHttp. Un serveur qui déclare une longueur plus courte que les données qu'il voulait transmettre peut produire une réponse HTTP valide : cette intention n'est pas détectable universellement.

La stratégie A (flux à la demande avec contre-pression) permettrait de consommer immédiatement les morceaux, mais introduirait un protocole de lecture, des états et une coordination d'annulation supplémentaires. Pour les petites réponses JSON complètes, B assure la borne du tampon sans ce protocole. **B ne satisfait pas littéralement la clause de streaming sans accumulation préalable de `HttpTransport`.** `application-http.ts` reste inchangé et aucun adaptateur n'est composé ; une éventuelle évolution du contrat devra être revue séparément, sans présenter ce prototype comme compatible avec le contrat actuel.

Le client est dédié : `OkHttpClient.Builder`, sans réutilisation du provider RN, sans cookie jar, cache, authentificateur serveur ou proxy, ni retry de connexion. Les deux réglages de suivi des redirections sont faux. Les vérificateurs TLS et de nom restent ceux d'OkHttp/Android. Les connexions inactives ne sont pas conservées (`ConnectionPool(0, ...)`), les corps sont fermés dans `use`. Un timeout global de Call couvre l'exécution et les lectures ; `cancel` invoque `Call.cancel`. Deux réservations maximum sont admises sous verrou, sans file applicative ; une lecture unique est permise par identifiant. Les appels doivent suivre `start` puis `read`, ou `cancel` ; une réservation abandonnée doit être annulée. `OnDestroy` annule les appels. Seuls les builds débogables et l'hôte `10.0.2.2`, ports 9443–9447, sont acceptés. L'en-tête Authorization est fixé à une valeur factice ; aucune API de token réel n'est exposée.

OkHttp négocie/décompresse gzip par son mécanisme par défaut ; les autres encodages restant déclarés sont refusés. La borne s'applique aux octets lus après décompression, avec un octet de contrôle en plus. Les données applicatives occupent jusqu'à L octets de tampon, puis une copie de n <= L pour les corps plus courts. S'ajoutent les buffers Okio/TLS/gzip, les en-têtes, la conversion Expo du `ByteArray` vers JavaScript, puis le décodage texte et l'analyse JSON. Pas de base64 ni de tableau de nombres JS volontaire. L’inspection de `expo-modules-core` 57.0.26 (`android/src/main/cpp/types/JNIToJSIConverter.cpp`, `createUint8Array`) établit une allocation `ArrayBuffer(n)` et une copie JNI des n octets, puis une vue `Uint8Array`. Le pic des seuls corps peut donc atteindre L + 2n par appel pour un corps court, avant libération des tableaux et hors décodage/JSON. Le coût réel du pont et du GC reste à mesurer ; deux appels actifs ne bornent pas la mémoire des réponses que JavaScript déciderait de conserver après résolution. Le prototype borne le corps accumulé, pas le RSS total du processus.

Sources de configuration : [OkHttp 4.9.2](https://github.com/square/okhttp/tree/parent-4.9.2/okhttp/src/main/kotlin/okhttp3), [modules locaux Expo](https://docs.expo.dev/modules/get-started/), [debug-overrides Android](https://developer.android.com/privacy-and-security/security-config#debug-overrides). `dependencyInsight` résout ici OkHttp **4.9.2**, licence Apache-2.0, dans le relevé initial. Le graphe de l’application debug vérifié lors de l’audit mémoire sélectionne **4.12.0** dans `:app:debugRuntimeClasspath`. Cette version héritée doit être suivie lors des mises à jour Expo/RN ; aucune mise à niveau n'est introduite dans ce sous-jalon. Aucun nouveau SDK HTTP n'est installé. `@types/node` 24.19.2 sert au typage strict du serveur et JUnit 4.13.2 aux tests JVM du lecteur ; ces dépendances sont réservées au développement/test.

### Fichiers et fixture exécutables

- `apps/mobile/qualification/server.ts` : A HTTPS 9443, B HTTPS 9444, C HTTP 9445, CA inconnue 9446, mauvais SAN 9447 ; contrôle HTTP **loopback seulement** 9448. `/json`, `/invalid`, `/gzip`, `/oversize`, `/truncated`, `/length`, `/slow`, `/cookie`, `/challenge`, `/destination`, `/redirect/{301|302|303|307|308}/{same|host|http}`. `/truncated` coupe après `{}` sans Content-Length, avant le terminateur chunked ; `/length` annonce 1000 octets puis coupe après `{}`. `/slow` reste ouverte et émet progressivement jusqu'à fermeture. Compteurs en mémoire plafonnés à 4096 événements ; au-delà, refus 503 et remise à zéro nécessaire. Aucun corps ni valeur d'en-tête n'est stocké. `closed` observe la fermeture, `finished` la fin normale du serveur.
- `qualification/certificates.sh` : crée un nouveau dossier avec droits restrictifs, deux CA et trois certificats serveur de sept jours. La CA inconnue et le mauvais SAN sont des cas distincts. Toutes les clés restent hors dépôt.
- `modules/bounded-https/` : configuration d'autolinking Android, build Gradle, lecteur Kotlin, module Expo, tests JVM et interface TypeScript paresseuse.
- `qualification/QualificationScreen.tsx` et `src/composition/App.tsx` : écran activable en développement avec `EXPO_PUBLIC_HTTPS_QUALIFICATION=1`. Il ensemence uniquement les cookies du domaine de fixture via Expo, lance les cas GET/POST, TLS, abort, timeout et concurrence, et affiche des résultats sans messages d'erreur bruts. Le JSON invalide est transporté intact puis détecté côté JS ; le transport ne fait pas d'analyse métier.
- `plugins/with-qualification-ca.cjs` et `app.json` : plugin produisant les ressources et la référence manifeste **dans `src/debug` uniquement**, si `BUNNY_QUALIFICATION_CA` est fourni. Il refuse une configuration de sécurité préexistante différente. Les ressources générées persistent dans le projet natif local : enlever la variable ne les efface pas. Le source set release ne les inclut pas. Pas de confiance envers toutes les CA utilisateur.
- `tests/https-fixture.test.ts`, `tsconfig.json`, `package.json`, `pnpm-lock.yaml` : tests et typage du serveur.

### Procédure développeur Android

Depuis la racine, avec Node 24 et OpenSSL :

```sh
bash apps/mobile/qualification/certificates.sh /tmp/bunny-https-ca
node apps/mobile/qualification/server.ts /tmp/bunny-https-ca
```

Le dossier doit être nouveau. Par défaut le serveur écoute sur loopback. Si le réseau WSL2 de l'émulateur l'exige, lancer avec `FIXTURE_HOST=0.0.0.0` et limiter l'accès aux ports au réseau local de développement ; le contrôle 9448 reste loopback. Vérifier le routage Windows/WSL2 indépendamment de TLS. B utilise `https://10.0.2.2:9444`, origine distincte de A par son port ; aucun tunnel ADB supplémentaire n'est requis par le scénario. Tester un véritable autre nom d'hôte exige un nom résolu par l'émulateur et un certificat avec SAN correspondant : ce scénario distinct reste à configurer et qualifier. L'écran lance des contrôles positifs A/B et C ; si C échoue à cause de la politique HTTP debug ou du réseau, résoudre la configuration ou effectuer un contrôle positif indépendant depuis l'émulateur avant toute conclusion sur la redirection HTTP.

Préparer puis reconstruire le Development Build sans désinstaller ni effacer ses données :

```sh
cd apps/mobile
BUNNY_QUALIFICATION_CA=/tmp/bunny-https-ca/ca.pem pnpm exec expo prebuild --platform android --no-install
cd android
./gradlew :bounded-https:testDebugUnitTest :app:assembleDebug :app:processReleaseMainManifest
adb install -r app/build/outputs/apk/debug/app-debug.apk
cd ..
EXPO_PUBLIC_HTTPS_QUALIFICATION=1 pnpm start
```

Vérifier avant installation l'identifiant `fr.bunnytalks.mobile` et la compatibilité de signature avec le build existant. Si `install -r` refuse la signature, **ne pas désinstaller** : reconstruire avec la bonne clé. Attention : Expo peut régénérer le projet natif lors du prebuild ; conserver toute modification native locale avant cette commande. Le plugin et le module sont les sources pérennes des changements de ce sous-jalon.

Dans un autre terminal, lire les compteurs :

```sh
curl -X POST http://127.0.0.1:9448/reset
curl http://127.0.0.1:9448/events
```

Remettre à zéro avant de lancer l'écran. Vérifier pour chaque 301/302/303/307/308 GET et POST : une seule requête source par cas ; après les trois requêtes positives initiales, aucune requête supplémentaire vers `/destination` sur A/B/C après attente. Contrôler positivement la disponibilité de B/C séparément puis remettre à zéro. Le simple libellé « refus » de l'écran ne prouve pas la cause du refus : les contrôles positifs et compteurs sont indispensables.

Vérifier `/json` et `/gzip` : statut 200, mêmes octets et texte multilingue ; `/invalid` : octets reçus mais analyse JSON refusée ; `/oversize`, `/truncated`, `/length` : refus. Pour `/slow`, constater `closed=true`, `finished=false` peu après le timeout ou l'annulation, et absence de nouvelles écritures réseau. Le résultat de la promesse seul n'établit pas l'arrêt effectif. La CA inconnue et le mauvais SAN doivent être refusés avec zéro requête HTTP reçue ; le port 9443 doit réussir avant de tirer ces conclusions.

Utiliser les scénarios dédiés décrits en fin de rapport pour vérifier l’isolation des cookies, l’annulation et la mémoire. Le contrôle `/challenge` doit produire une seule tentative. Authorization est le marqueur factice fixé par le module.

Enfin contrôler le manifeste fusionné release et, avant toute distribution, un APK release avec `aapt dump xmltree`/APK Analyzer : pas de référence `bunny_qualification_network`, pas de ressource CA de fixture, pas de `debuggable=true`. Un manifeste fusionné seul ne certifie pas un APK final. Fermer la fixture et supprimer les clés temporaires après les essais ; relancer Metro sans le drapeau pour retrouver les diagnostics habituels.

### Vérifications réalisées et revue

Résultats observés dans l'environnement Codex le 17 novembre 2026 :

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` : réussis. Le premier contrôle de formatage avait signalé le lockfile après ajout des types Node ; il a été formaté.
- `pnpm test` : relance réussie, **654 tests, 66 fichiers**, dont 49 tests mobiles et les quatre tests de fixture. La première exécution simultanée à la compilation Android lourde avait échoué sur deux timeouts de 30 secondes dans `packages/crypto/backup/tests/account-vault.test.ts`. Aucun paramètre cryptographique ni délai de test n'a été modifié ; la relance a réussi. La charge est une explication plausible, pas une cause prouvée.
- Autolinking : module `bounded-https` détecté. `:bounded-https:testDebugUnitTest` : trois tests JVM réussis (octets multilingues et limite exacte, arrêt à L+1, erreur après préfixe JSON valide). Ces tests exécutent le lecteur Kotlin, pas le réseau Android ni le pont Expo.
- `:app:assembleDebug` : réussi, puis build incrémental réussi après correction de l'ordre fermeture/libération/résolution. APK local produit, **aucune installation effectuée**. Le prebuild a régénéré le projet Android local ; les sources pérennes sont le module et le plugin. Les données des appareils n'ont pas été manipulées.
- `:app:processReleaseMainManifest` et `:app:processReleaseResources` : réussis. Vérification de l'archive `linked-resources-binary-format-release.ap_` : aucune entrée `bunny_qualification`. Manifeste fusionné release : aucune référence `networkSecurityConfig` de qualification et aucun `debuggable=true`. `aapt dump xmltree` et `unzip -l` sur l'APK debug confirment sa configuration debug et la présence du certificat public et du XML de qualification. Aucun APK release final n'a été assemblé ou installé.
- Export Metro Android avec `EXPO_PUBLIC_HTTPS_QUALIFICATION=1` : réussi. Les avertissements Gradle concernent notamment des API dépréciées des dépendances et le décalage des outils SDK ; ils n'ont pas empêché les builds. L'installation pnpm a signalé le conflit de peer dependency déjà présent entre React 19.2.3 et react-dom 19.3.1 ; aucune mise à niveau React n'a été entreprise.
- `adb devices -l` hors bac à sable : liste vide. Aucun essai sur appareil Android, aucune mesure mémoire sur appareil et aucune observation TLS/annulation native disponibles.

**Garantie démontrée dans son périmètre :** lecteur Kotlin borné et propagation d'une erreur de lecture dans les tests JVM ; fixture HTTPS opérationnelle dans les tests Node ; compilation et empaquetage debug ; absence de CA de qualification dans les ressources release compilées et le manifeste fusionné inspectés. La configuration du client dédié est établie par lecture du code, pas par observation réseau Android.

**Garantie non démontrée :** fonctionnement du pont sur Hermes, octets et gzip reçus sur appareil, refus TLS avec les trois certificats, redirections empêchées avant deuxième requête, isolation effective des cookies, arrêt réseau après timeout/abort, concurrence observée et plateau mémoire. La procédure ci-dessus doit fournir les compteurs, mesures et résultats avant toute conclusion de qualification. La réponse native complète n'est pas encore compatible avec le contrat actuel de streaming.

**Défaut bloquant avant intégration :** absence de ces observations Android et absence d'une décision explicite sur le contrat de transport. Le module n'est pas prêt pour l'authentification réelle. **Amélioration facultative :** automatiser les observations sur émulateur et les relevés mémoire après la revue de ce prototype.

Points de revue prioritaires : enregistrement synchrone puis lecture unique des Call, libération des places après fermeture avant résolution de promesse, borne après décompression, gestion des erreurs et refus des redirections, coût des copies Expo, confinement de la CA au source set debug et mécanisme de préservation des données lors d'une installation `-r`. Les fichiers nouveaux et modifiés sont inventoriés ci-dessus. Le jalon reste ouvert et toute extension attend la revue humaine.

Message de commit proposé après revue : `feat(mobile): add bounded Android HTTPS qualification prototype`.

### Fiabilisation du banc

Le diagnostic compare chaque octet des réponses JSON et gzip à la fixture UTF-8 et affiche uniquement des catégories natives autorisées. Les contrôles positifs et les compteurs restent indispensables : un échec réseau seul ne prouve ni un refus TLS ni un refus de redirection. La distinction entre origine différente par port et véritable nom d’hôte différent doit être conservée pendant la revue.

Vérifications de cette correction : cinq tests ciblés de la fixture réussis, trois tests JVM réexécutés avec succès, `pnpm typecheck`, `pnpm lint`, `pnpm test` et `pnpm format:check` réussis. L'export Metro Android avec l'écran expérimental a réussi. Le code Kotlin et les ressources natives étant inchangés, aucune nouvelle compilation APK n'a été nécessaire. Aucun essai Android n'a été observé pendant cette correction ; les contrôles positifs et les compteurs doivent encore être relevés sur l'émulateur.

### Diagnostic : étapes séparées

Le chargement du module `BoundedHttps` et l’ensemencement du cookie Expo sont signalés séparément. L’ensemencement dispose d’un délai de 1,5 seconde : un échec réseau ou TLS, une réponse autre que 200 ou un délai dépassé rend la qualification cookie non concluante, mais laisse les tests natifs se poursuivre si le module est disponible. Ce délai borne l’attente JavaScript et déclenche une demande d’annulation ; il ne prouve pas l’arrêt effectif du travail natif Expo. La réception d’une réponse 200 ne prouve pas à elle seule que le cookie a été enregistré : le contrôle du cookie jar et des compteurs demeure nécessaire. Si le chargement du module échoue, les tests natifs sont signalés comme non exécutés. Les erreurs et traces brutes ne sont pas affichées.

### Observations Android rapportées le 18 novembre 2026

Le développeur a fourni une synthèse d’un passage du prototype sur l’émulateur Android 17. Les 46 événements et les résultats ci-dessous sont consignés d’après cette synthèse. Les événements bruts n’ont pas été fournis avec la demande.

| Observation        | Résultat rapporté                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connectivité       | Trois contrôles positifs, HTTPS A et B et HTTP C                                                                                                             |
| Corps des réponses | Octets JSON et gzip conformes. Dépassements et réponses tronquées refusés                                                                                    |
| Redirections       | 15 GET et 15 POST sur les cinq statuts et les trois destinations. Aucun suivi observé                                                                        |
| Cookies            | Aucun cookie envoyé par les requêtes natives identifiées. L’enregistrement par Expo et l’isolation des `Set-Cookie` restent à vérifier                       |
| TLS                | Les deux essais de certificats invalides (CA inconnue et SAN incorrect) ont échoué sans requête HTTP applicative reçue sur ces serveurs                      |
| Connexions lentes  | Trois fermetures sans terminaison normale. Les données fournies ne permettent pas d’attribuer une fermeture à une annulation demandée après début de réponse |

Le passage ne couvre ni la mémoire du processus sur des cycles répétés ni la réutilisation des places après une annulation confirmée. B utilise une origine distincte par le port. Un test vers un autre nom d’hôte demanderait un routage et un certificat de fixture adaptés.

### Préparer les trois nouvelles vérifications sur Android

Depuis la racine, relancer le serveur de fixture à jour avec `node apps/mobile/qualification/server.ts /tmp/bunny-https-ca` en adaptant le dossier au jeu de certificats de la CA déjà embarquée dans le Development Build. Dans un autre terminal, démarrer Metro depuis `apps/mobile` avec `EXPO_PUBLIC_HTTPS_QUALIFICATION=1 pnpm start`. Ouvrir l’écran de qualification Android et vérifier la connectivité avec **Exécuter les fixtures**. Conserver le résultat et les compteurs de ce passage avant de les réinitialiser. Le passage historique à 46 événements comprenait l’ancien scénario d’annulation temporisé. La commande dédiée d’annulation manuelle le remplace.

Les commandes de contrôle s’exécutent sur l’hôte de la fixture. Attendre la fin des requêtes du scénario précédent avant de réinitialiser. Les événements contiennent des chemins de fixture, des indicateurs et des mesures de temps.

```sh
curl -fsS -X POST http://127.0.0.1:9448/reset
curl -fsS http://127.0.0.1:9448/events
```

#### Annuler après le premier fragment

1. Réinitialiser les compteurs et appuyer sur **Démarrer la connexion lente**. L’appel dispose de 60 secondes.
2. Lire `/events` depuis l’hôte. Relever l’événement `/slow/cancel` sur A avec `responseStarted=true`, `closed=false` et `finished=false`. Le premier fragment a été écrit côté serveur. Avant cette observation, laisser l’appel en cours.
3. Appuyer sur **Annuler après confirmation serveur**. L’écran doit indiquer le rejet de la lecture. Relever ensuite le même événement avec `closed=true` et `finished=false`. Comparer `closedAfterMs` à l’instant de l’action et au délai natif de 60 secondes. Un refus avant l’action, un événement absent ou une fermeture indistinguable du timeout rend l’essai non concluant.
4. Après le rejet, l’écran lance deux lectures en parallèle. Vérifier deux réponses 200 aux octets conformes et les événements `/reuse/one` et `/reuse/two` terminés. Ces requêtes prennent les deux places, ce qui contrôle que la place initiale est redevenue disponible. Refaire le passage si l’une des lectures échoue et conserver les deux relevés serveur pour la revue.

#### Vérifier l’isolation des cookies

Réinitialiser les compteurs, appuyer sur **Vérifier l’isolation des cookies**, puis relever les six événements du chemin affiché `/cookies/<id>/`. L’identifiant aléatoire isole les chemins entre passages et les deux cookies expirent après deux minutes. Les scénarios utilisent exclusivement les marqueurs artificiels de la fixture et laissent intact le reste du stockage.

| Étape          | Client              | Indicateurs attendus dans les compteurs                          |
| -------------- | ------------------- | ---------------------------------------------------------------- |
| `baseline`     | Expo avec `include` | Les deux marqueurs sont absents                                  |
| `seed`         | Expo avec `include` | Réponse terminée qui émet le premier `Set-Cookie`                |
| `expo-probe`   | Expo avec `include` | `expoFixtureCookie=true` et `nativeFixtureCookie=false`          |
| `native-probe` | BoundedHttps        | `cookie=false`                                                   |
| `native-set`   | BoundedHttps        | `cookie=false`. Réponse terminée qui émet le second `Set-Cookie` |
| `expo-after`   | Expo avec `include` | `expoFixtureCookie=true` et `nativeFixtureCookie=false`          |

Exiger six réponses 200 et les événements correspondants avant d’interpréter le tableau. Le maintien du premier marqueur dans `expo-after` confirme que le stockage partagé est actif lors du contrôle final. Classer le passage comme non concluant si le contrôle positif échoue ou si un événement manque. La présence d’un cookie sur un appel natif ou du second marqueur dans `expo-after` malgré les contrôles positifs contredirait l’isolation attendue.

#### Échantillonner la mémoire sans redémarrer

La campagne du 19 novembre a appliqué les relevés à 10, 60 et 120 secondes, avec un contrôle de réutilisation des deux places après chaque dernier relevé. [Charge et relevés de la campagne](android-https-memory-audit.md#campagne-du-19-novembre-2026)

Le lecteur alloue un tampon de 1 Mio au plus par lecture, comme établi par le code et les vérifications JVM antérieures. Les copies du corps, TLS, Okio, la décompression, le pont Expo et le runtime contribuent à la mémoire globale. Cette procédure mesure leur effet combiné sur le processus Android du prototype. Aucun plafond global ni résultat après GC n’est encore établi.

### Vérifications et limites au 18 novembre

Le 18 novembre 2026, les 12 tests ciblés et les 61 tests mobiles ont réussi, ainsi que `pnpm typecheck`, `pnpm lint`, `pnpm format:check` et l’export Metro Android. Les tests ciblés couvrent la fermeture après écriture du premier fragment côté fixture, les indicateurs de présence des cookies, la réponse gzip de charge, l’ordre des appels et la libération d’une réservation partielle. Les tests Node ne font pas intervenir le stockage Android ni le module natif.

La liste ADB était vide lors de ces vérifications locales. Les trois nouvelles séquences attendaient alors leurs observations Android, dont les deux relevés de fermeture et de réutilisation, la matrice des six événements de cookies et les séries mémoire. Le code et la configuration natifs étant hors du changement, les tests JVM et la reconstruction native n’ont pas été relancés. Aucune anomalie bloquante n’a été reproduite dans les vérifications locales. Après une éventuelle qualification Android de ces séquences, le jalon garde ouverts la qualification iOS, l’écart avec le contrat applicatif de streaming et l’autorisation d’utiliser des identifiants réels.

### Décision mémoire soumise à revue le 19 novembre 2026

Les 65 relevés du PID 19746 et les événements archivés couvrent un témoin au repos, un échauffement distinct et dix séries de cinq cycles. Sur 250 tentatives attendues hors échauffement et contrôles, la fixture enregistre 200/200 arrivées obligatoires et 38/50 arrivées d’annulation temporisée, toutes fermées après le premier fragment, avant terminaison normale. Les deux places sont réutilisables aux dix contrôles hors charge. Les résultats applicatifs sont confirmés manuellement par série.

Entre les repos des séries 6 et 7, le Native Heap baisse de 10 680 Kio, Heap Alloc de 12 828 Kio et Heap Size de 9 668 Kio. La récupération est établie au niveau du processus. De la série 7 à la série 10, le Native Heap regagne 6 000 Kio. Private Other contribue aussi au bilan du PSS. Aucun défaut de libération propre à BoundedHttps n’a été mis en évidence. Un seul point bas laisse ouverte la possibilité d’une rétention persistante sur certaines piles.

**Recommandation.** Conserver les acquis fonctionnels de cette expérience Android et garder la qualification mémoire ouverte. Un seul profil heapprofd ciblé est proposé à la revue humaine pour comparer les octets natifs encore alloués par pile après deux charges équivalentes. L’intégration au contrat HTTP applicatif et la qualification iOS restent ouvertes. [Mesures et protocole proposé](android-https-memory-audit.md)

### Revue des buffers Hermes du 20 novembre 2026

La symbolisation du profil natif identifie le constructeur d’ArrayBuffer appelé par Expo lors de la livraison d’une réponse. Sur quinze allocations de 786 443 octets, huit ont été libérées et sept subsistent après le second bloc. Les références qui pourraient maintenir ces sept buffers accessibles au GC restent inconnues. Aucune correction du transport n’est étayée. La proposition est un unique contrôle du tas JS après collecte en debug avant la qualification mémoire limitée. [Cycle de vie et piles secondaires](android-https-memory-audit.md#cycle-de-vie-des-buffers-hermes-sur-le-pid-24878)
