# Qualification HTTPS mobile — référence active

## Architecture retenue

Le transport iOS reste **URLSession** via `modules/application-https/ios/UrlSessionHttpsTransport.swift`; Android conserve **OkHttp** via `modules/application-https/android/`. Le module Expo natif, l’adaptateur HTTP, le client applicatif et les contrats se trouvent respectivement dans `modules/application-https/`, `src/infrastructure/http/` et `src/composition/`. Le verrou iOS reste fermé aux parcours métier et aux secrets réels.

Le contrat commun livre une réponse complète sous forme d’octets stables, borne le corps décodé à 1 048 576 octets, refuse redirections, codages non acceptés et réponses incomplètes, utilise HTTPS et n’autorise pas de reprise implicite du client. Les détails normatifs restent dans l’[ADR-004](../architecture/decisions/004-bounded-mobile-api-responses.md) et les menaces dans le [modèle de menaces](../security/threat-model.md#transport-https-mobile). Aucun réglage ATS permissif ou contournement de confiance TLS n’est autorisé.

## Qualification et preuves acceptées

Les trois qualifications Apple conservées sont :

- candidate URLSession instrumentée : run `45841518053`, révision `b7dca8ed038436a950ac70e040781ca30aa28bc2`, 34 scénarios acceptés;
- démarrage de la Release standard : run `45841579254`, même révision, compilation, inspection et lancement acceptés; le runtime HTTPS applicatif est `NOT_RUN`;
- laboratoire HTTPS standard sans macro : run `45845228016`, révision `610ac5362d60c41c8360a87e411ab786c319885e`, 16 scénarios acceptés; verdict global `NOT_RUN` pour la comparaison SwiftDriver.

Les rapports originaux restent lisibles ici. [Android étape B](evidence/android-https-standard-step-b/report.json), [candidate URLSession](evidence/ios-https-urlsession-45841518053/report.json), [Release standard](evidence/ios-standard-runtime-45841579254/report.json), [laboratoire](evidence/ios-standard-https-lab-45845228016/report.json).

### Requalification de la fixture consolidée, 26 novembre 2026

L’APK debug `fr.bunnytalks.mobile.httpsqualification` 0.1.0 a été assemblé hors ligne dans une copie dédiée WSL2 pour x86_64, puis installé sur un AVD Android 17 neuf sous Windows. L’APK récupéré par ADB est identique à l’APK construit. Le manifeste désigne la configuration de confiance de fixture, dont la CA publique est injectée sous `debug-overrides` et dont l’exception HTTP est limitée à `10.0.2.2`. L’APK contient le bytecode Hermes et le profil natif OkHttp de qualification. Le build debug standard, assemblé séparément, exclut la ressource et le profil natif de fixture ainsi que la CA en PEM et DER. Le rapport conserve les empreintes et les PID Android. [Rapport assaini](evidence/android-https-consolidation-2026-11-26/report.json)

Le premier lancement a ouvert le lanceur Expo et donne 33 `NOT_RUN`. La sélection du bundle embarqué et la répétition avec un nouveau PID et une fixture vierge ont chacune terminé les 33 scénarios côté application. Les six sockets attendues étaient en écoute. Chaque snapshot contient 38 événements et 26 connexions, sans débordement. Dans les deux exécutions WSL2, l’oracle donne 30 `PASS`, `FAIL` sur `cancel-neighbour`, puis `NOT_RUN` sur `session-delete` et `framing-recovery`. Les diagnostics de ces deux derniers scénarios sont positifs. La réponse voisine commence 52 ms et 49 ms après la fermeture de la connexion annulée, alors que l’oracle exige un chevauchement. Le diagnostic direct sous Windows, avec les mêmes sources de fixture sans annotations TypeScript et le Node 20.10.0 déjà installé, donne le même verdict avec un écart de 5 ms. Le délai entre l’acceptation TCP et la réception HTTP reste sans cause confirmée. [Rapport d’échec conservé](evidence/android-https-consolidation-2026-11-26/report.json)

### Correction du scénario `cancel-neighbour`

Le scénario programme l’annulation à 1 000 ms et la fixture retient la réponse voisine pendant 1 800 ms, avec une première réponse retenue pendant 3 000 ms et l’échéance de requête à 4 500 ms. L’oracle exige que les deux réponses aient commencé avant la fermeture de la première et que la voisine se termine après. La première doit être interrompue et la troisième réservation doit être refusée sans appel natif ni réception HTTP. L’application mesure le délai entre la demande d’annulation et le rejet natif avec une horloge monotone et une borne de 700 ms. La fixture contrôle séparément la fermeture de la première réponse dans les 1 700 ms suivant sa réception HTTP. Les jalons TCP, TLS, HTTP et les événements de réponse sont mesurés sur l’horloge de la fixture. Les journaux ne supposent aucune corrélation entre ces deux horloges.

La candidate corrigée donne **33/33 `PASS`** avec une fixture WSL2 vierge et les six sockets attendues, sur un AVD Android 17 x86_64 recréé avec le profil dédié `BunnyHttpsFinal`. Le lanceur Expo a chargé le bundle Hermes embarqué via **Load embedded bundle**. Les marqueurs du PID `5418` confirment le profil natif et la fin de la matrice. L’APK construit et celui récupéré depuis l’émulateur sont identiques octet pour octet. Le rapport consigne les empreintes SHA-256 de l’APK, du bundle, de la CA publique et des entrées du banc. [Rapport de la candidate corrigée](evidence/android-https-cancel-neighbour-2026-11-26/report.json)

Sur l’horloge de la fixture, la réponse voisine commence 536 ms après la première réception HTTP. La première réponse se ferme avant sa fin naturelle à 1 020 ms, soit 484 ms de chevauchement, et la voisine se termine à 2 337 ms. Sur l’horloge de l’application, la demande d’annulation est enregistrée à 1 024 ms et le rejet natif à 1 029 ms, soit 5 ms après la demande. La réponse voisine livre 59 octets et la troisième réservation reste sans réception HTTP. [Mesures assainies](evidence/android-https-cancel-neighbour-2026-11-26/report.json)

## Procédures maintenues

### Préparer et déclencher une campagne Apple approuvée

Extraire l’archive SHA dans un répertoire vide sous `/tmp`. L’inventaire est calculé sur la racine extraite, sans ajouter de fichiers ni générer le projet natif. Publier uniquement le SHA de la révision approuvée et le digest vérifié indépendamment.

```sh
python3 -IB apps/mobile/scripts/ios-https-provenance.py "$BUNNY_REVIEWED_EXPORT"
(cd apps/mobile && EXPO_NO_GIT_STATUS=1 bash scripts/preflight-ios-standard.sh)
bash apps/mobile/qualification/stage-ios-urlsession-campaign.sh
```

Le staging affiche son répertoire temporaire. Il vérifie la composition de la candidate et prépare ses sources. Le préflight local inspecte les sources et l’autolinking. Une future exécution autorisée se déclenche dans Actions ou par ces commandes depuis un checkout autorisé, avec `BUNNY_REVIEWED_REF`, `BUNNY_REVIEWED_SHA` et `BUNNY_REVIEWED_TREE_SHA256` approuvés pour la révision ciblée.

```sh
gh workflow run ios-https-candidate.yml --ref "$BUNNY_REVIEWED_REF" \
  -f reviewed_sha="$BUNNY_REVIEWED_SHA" \
  -f reviewed_tree_sha256="$BUNNY_REVIEWED_TREE_SHA256" -f hosted_observed=true
gh workflow run ios-standard-runtime.yml --ref "$BUNNY_REVIEWED_REF" \
  -f reviewed_sha="$BUNNY_REVIEWED_SHA"
gh workflow run ios-standard-https-lab.yml --ref "$BUNNY_REVIEWED_REF" \
  -f reviewed_sha="$BUNNY_REVIEWED_SHA" \
  -f reviewed_tree_sha256="$BUNNY_REVIEWED_TREE_SHA256" -f hosted_observed=true
```

Pour `--ref`, utiliser la branche ou l’étiquette approuvée contenant le workflow. Fournir le SHA complet au champ `reviewed_sha`. Les workflows exécutent une seule tentative dans le dépôt autorisé. La candidate et le laboratoire vérifient aussi l’archive SHA, gardent la fixture en boucle locale, isolent le simulateur et inspectent les artefacts installés. L’inspection couvre notamment Mach-O, Hermes, CocoaPods, ATS, SQLCipher, les sources Swift et la carte de liens.

Déclencher `ios-https-candidate.yml` pour mesurer le runtime HTTPS URLSession candidat sur la fixture hébergée-observée. Déclencher `ios-standard-runtime.yml` pour examiner le build Release standard et son cycle d'exécution, sans ajouter le périmètre de la candidate HTTPS. Déclencher `ios-standard-https-lab.yml` pour les observations HTTPS du laboratoire Release et sa comparaison de chaîne SwiftDriver. Ces campagnes ont des rapports, critères et déclenchements manuels distincts ; les préfixes C1 et C2-B figurant dans certains noms de rapports, scopes et appareils sont des identifiants de provenance conservés.

### Préparer la fixture et requalifier Android

Utiliser un checkout de qualification, un émulateur dédié, les mêmes ports et un état de fixture neuf par campagne. Le nom d’application du build est `fr.bunnytalks.mobile.httpsqualification`, distinct du diagnostic crypto. Le port 29443 doit être accessible depuis l’émulateur sous `10.0.2.2`, avec les destinations de test sur 29444 à 29447. Garder le contrôle 29448 en boucle locale. Reporter la vérification si l’environnement ne permet pas d’établir ce trajet sans exposer les services de test.

```sh
cd apps/mobile
export BUNNY_HTTPS_WORK="$(mktemp -d /tmp/bunny-https-android.XXXXXXXX)"
bash qualification/certificates.sh "$BUNNY_HTTPS_WORK/certs"
mkdir -p "$BUNNY_HTTPS_WORK/resources/raw"
cp "$BUNNY_HTTPS_WORK/certs/ca.pem" \
  "$BUNNY_HTTPS_WORK/resources/raw/bunny_https_qualification_ca.pem"
BUNNY_HTTPS_STANDARD_JSON=1 FIXTURE_PORT=29443 FIXTURE_HOST=127.0.0.1 \
  node qualification/server.ts "$BUNNY_HTTPS_WORK/certs"
```

Dans un autre terminal, reprendre la valeur de `BUNNY_HTTPS_WORK`. Si le checkout dédié n’a pas de projet Android généré, le préparer avec `EXPO_NO_GIT_STATUS=1 pnpm exec expo prebuild --platform android --no-install` depuis `apps/mobile`. Construire la variante debug à entrée de qualification explicite.

```sh
cd apps/mobile/android
EXPO_PUBLIC_BUNNY_HTTPS_QUALIFICATION=1 BUNNY_HTTPS_STANDARD_JSON=1 \
  ./gradlew -I ../qualification/android/https-qualification.init.gradle \
  -PbunnyHttpsQualificationResources="$BUNNY_HTTPS_WORK/resources" :app:assembleDebug
```

Inspecter l’APK avant installation. Avec `BUNNY_AAPT` pointant vers `aapt` dans le SDK Android :

```sh
bunny_fixture_apk=app/build/outputs/apk/debug/app-debug.apk
"$BUNNY_AAPT" dump badging "$bunny_fixture_apk" | rg '^package:'
"$BUNNY_AAPT" dump xmltree "$bunny_fixture_apk" AndroidManifest.xml
"$BUNNY_AAPT" dump resources "$bunny_fixture_apk" | rg 'bunny_https_qualification'
unzip -Z1 "$bunny_fixture_apk" | rg '^assets/index.android.bundle$'
```

Confirmer l’identifiant dédié, la ressource XML debug, la CA publique injectée et le bundle embarqué. L’exception HTTP de la fixture est limitée à `10.0.2.2` pour observer la destination d’une redirection. Contrôler séparément que l’artefact standard produit sans l’init Gradle exclut les réglages et ressources de fixture. Sélectionner l’émulateur jetable dans `BUNNY_ANDROID_SERIAL`, vérifier son identité et l’absence de données à préserver pour le paquet dédié. Le protocole conserve les logs globaux, les données d’Expo, les stores et les APK standard.

```sh
bunny_fixture_id=fr.bunnytalks.mobile.httpsqualification
adb -s "$BUNNY_ANDROID_SERIAL" install "$bunny_fixture_apk"
bunny_installed_apk="$(adb -s "$BUNNY_ANDROID_SERIAL" shell pm path "$bunny_fixture_id" \
  | tr -d '\r' | sed -n 's/^package://p')"
adb -s "$BUNNY_ANDROID_SERIAL" pull "$bunny_installed_apk" "$BUNNY_HTTPS_WORK/installed.apk"
cmp "$bunny_fixture_apk" "$BUNNY_HTTPS_WORK/installed.apk"
adb -s "$BUNNY_ANDROID_SERIAL" shell am start -n \
  "$bunny_fixture_id/fr.bunnytalks.mobile.MainActivity"
```

Sous WSL2 avec un émulateur Windows, utiliser l’ADB du SDK Windows et vérifier que sa boucle locale atteint la fixture WSL2. Au premier lancement, si Expo affiche son lanceur, faire défiler l’onglet d’accueil jusqu’à **Load embedded bundle** et sélectionner ce bouton. La campagne utilise le bundle de l’APK sans serveur Metro. Relever le PID de cette application avec `adb -s "$BUNNY_ANDROID_SERIAL" shell pidof fr.bunnytalks.mobile.httpsqualification`. Après le marqueur `DONE`, enregistrer uniquement les marqueurs assainis du PID vérifié, puis le snapshot de la fixture. Depuis `apps/mobile`, avec ce PID dans `BUNNY_ANDROID_PID` :

```sh
adb -s "$BUNNY_ANDROID_SERIAL" logcat -d --pid="$BUNNY_ANDROID_PID" \
  | rg -F '[BunnyHttpsStandardJson] ' > "$BUNNY_HTTPS_WORK/android.log"
curl --fail --silent --show-error http://127.0.0.1:29448/runtime \
  > "$BUNNY_HTTPS_WORK/runtime.json"
node qualification/verify-standard-json.ts android "$BUNNY_HTTPS_WORK/android.log" \
  "$BUNNY_HTTPS_WORK/runtime.json" > "$BUNNY_HTTPS_WORK/report.json"
```

Les clés de la fixture et les traces de travail restent locales. Pour répéter l’essai, arrêter la fixture, puis arrêter uniquement le processus du paquet de qualification avec `adb -s "$BUNNY_ANDROID_SERIAL" shell am force-stop fr.bunnytalks.mobile.httpsqualification`. Démarrer une nouvelle fixture, relancer l’activité dédiée et relever le nouveau PID.

### Oracles et tests locaux

`verify-standard-json.ts ios <log-marqueurs> <snapshot-runtime>` rejoue l’oracle de la candidate avec la même structure. Le laboratoire lance `node qualification/verify-ios-standard-https-lab.ts fixture <phase> <certificats>` puis `node qualification/verify-ios-standard-https-lab.ts verify <phase> <log-marqueurs> <snapshot-runtime>`. Les phases sont `before-trust`, `wrong-name`, `refusals`, `nominal` et `loss`. Les runners Apple gèrent les changements de confiance et distinguent les rapports partiels.

```sh
for suite in apps/mobile/tests/*.test.py; do python3 -IB "$suite" || exit; done
EXPO_NO_GIT_STATUS=1 pnpm --filter @bunny-talks/mobile test
(cd apps/mobile/android && ./gradlew --offline --no-daemon :application-https:testDebugUnitTest)
```

### Récupérer et interpréter les rapports

Dans la page du run Actions, télécharger seulement l’artefact assaini `ios-https-urlsession-<run>-<tentative>`, `ios-standard-runtime-c1-<run>-<tentative>` ou `ios-standard-https-lab-<run>-<tentative>`. Pour le télécharger en CLI, utiliser `gh run download <run> -n <nom-artefact> -D <répertoire-temporaire>`. Comparer la révision, le profil, la complétude et les étapes à la mission, puis lire `report.json`. `PASS` concerne le périmètre déclaré. `FAIL` signale une contradiction ou un critère non satisfait. `NOT_RUN` signale un essai non exécuté ou une preuve indisponible ou insuffisante. Une collecte incomplète ne valide jamais un résultat. Le laboratoire peut passer ses 16 observations HTTPS tout en restant globalement `NOT_RUN` lorsque la comparaison SwiftDriver n’est pas disponible.

## Limites et conservation

Restent hors preuve : parcours métier iOS, comparaison exhaustive SwiftDriver, exécution iOS 16.4, appareil physique, trajet TLS déployé, confinement complet, mémoire, performance et énergie. Le verrou iOS n’est pas ouvert.

Le lot 0 est accepté. Six ZIP et `bunny-talks-https-history.bundle` sont conservés dans `~/.local/share/bunny-talks/archives/https/`; le développeur confirme également la sauvegarde indépendante hors WSL. Les SHA des 30 révisions historiques et les deux révisions documentaires, leurs runs, empreintes et procédures de restauration sont consignés dans l’[index de conservation](https-archive-index.md). Le bundle restauré couvre 32/32 révisions; 25 des 30 révisions historiques ne sont pas ancêtres de la révision terminale du laboratoire. Une copie locale WSL seule n’est pas une sauvegarde indépendante.

Pour retrouver une source historique, utiliser une copie de travail isolée restaurée depuis le bundle et vérifier le SHA complet de la révision visée. La procédure de restauration et l’intégrité du bundle ont été confirmées par le développeur; elles n’ont pas été rejouées pendant le nettoyage. Les rapports de qualification essentiels restent dans le dépôt; les prototypes, recettes détaillées et historiques de travail résident dans les révisions protégées.

## Mémoire Android et transport historique

L’expérience 4.5B2B a observé une récupération partielle sous charge sur émulateur Android 17. La série d’attente a enregistré une baisse de 10 680 Kio du Native Heap entre deux relevés. Une trace indépendante sur le chemin gzip a attribué une copie de réponse décodée au stockage natif d’un ArrayBuffer Hermes, après transfert Kotlin/Expo/JNI. Sur les deux blocs suivis, quatre puis deux allocations de 786 443 octets ont été libérées. Les racines JS et la GC n’étaient pas observées. Les campagnes laissent ouvertes la rétention et la récupération tardive, sans démontrer une fuite imputable au transport ni un plafond RSS. Les captures brutes restent dans leur emplacement historique privé. Le protocole de mesure distinguait charge, échauffement, repos de 120 secondes, PID et état de fermeture.

Les expérimentations libcurl et les tests du prototype Android restent restaurables via l’index. URLSession et OkHttp constituent les transports maintenus. Une future mesure utile sur la version retenue doit distinguer accessibilité JS, mémoire réservée et RSS après collecte, puis observer une charge prolongée. Les profils et limites du prototype gzip ne s’appliquent pas au contrat JSON à longueur connue.
