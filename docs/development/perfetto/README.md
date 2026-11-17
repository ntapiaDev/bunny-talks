# Bunny Talks 4.5B2B — profil natif Android

**Protocole préparé le 19 novembre 2026.** La capture aboutie sur le PID 24878 a utilisé un intervalle de 32 768 octets et 16 Mio de mémoire partagée. [Résultat et pile complète](../android-https-memory-audit.md#cycle-de-vie-des-buffers-hermes-sur-le-pid-24878)

Le 19 novembre 2026, ADB Windows 37.0.1 a répondu depuis WSL2 pour `emulator-5554`. La cible était Android 17, API 37, image `user` x86_64, SELinux `Enforcing`, shell UID 2000. Le paquet `fr.bunnytalks.mobile` tournait sous le PID 19746. `dumpsys package` indiquait `DEBUGGABLE`, version 0.1.0 (1) et ABI x86_64. `run-as … id` a réussi. Le SHA-256 du `base.apk` installé correspond à celui du `app-debug.apk` local. L’APK remplit donc les critères documentés de heapprofd pour une image `user`. [Éligibilité et périmètre de heapprofd](https://perfetto.dev/docs/data-sources/native-heap-profiler) · [ADB Android](https://developer.android.com/tools/adb)

`perfetto --query` a annoncé `android.heapprofd` avec zéro session active. L’aide de l’émulateur confirme `--background-wait` et l’arrêt gracieux par PID. Le répertoire de traces est accessible en écriture et `/data` disposait d’environ 7,3 Gio. WSL2 a préservé les octets NUL, CRLF et `ff` aussi bien vers `adb.exe shell -T` que depuis `adb.exe exec-out`. Le contrôle HTTPS sur 9448 et Metro sur 8081 ont répondu depuis WSL. Le certificat public local passe la vérification de chaîne et de SAN IP `10.0.2.2`.

À la préparation, le contrôle court était nécessaire pour confirmer l’attachement, le transfert d’une trace non vide, la réception des instantanés, la stabilité sous instrumentation et la couverture réelle des symboles. Le service heapprofd était à l’arrêt au repos. L’implémentation AOSP documente `SIGUSR1` dans le processus central pour l’usage `userdebug`. Sur notre image `user`, la procédure s’appuie sur les instantanés périodiques. Le contrôle court peut aussi éprouver le signal si les droits du shell le permettent. [Instantanés heapprofd](https://perfetto.dev/docs/data-sources/native-heap-profiler#triggering-heap-snapshots-on-demand) · [Implémentation Android du signal](https://android.googlesource.com/platform/external/perfetto/+/refs/heads/main/src/profiling/memory/heapprofd.cc)

## 1. Vérifier les services et préparer le terminal

Dans PowerShell, avec l’émulateur déjà démarré.

```powershell
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
& $adb version
& $adb devices -l
& $adb -s emulator-5554 get-state
```

Dans WSL2, à partir du dépôt. Garder ce terminal Bash pour les fonctions des sections suivantes. Si nécessaire, adapter uniquement le chemin d’ADB Windows.

```bash
cd /home/nicolas/bunny-talks
umask 077
set -o pipefail
adb_win=/mnt/c/Users/Nicolas/AppData/Local/Android/Sdk/platform-tools/adb.exe
bunny_adb() { "$adb_win" -s emulator-5554 "$@"; }

bunny_adb get-state
bunny_adb shell 'id; getenforce; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.build.type; getprop ro.product.cpu.abilist; df -k /data'
bunny_adb shell run-as fr.bunnytalks.mobile id
bunny_adb shell perfetto --query
curl --fail --silent --show-error http://127.0.0.1:9448/events -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:8081/status
```

Si la fixture ou Metro sont arrêtés, reprendre leur configuration existante dans des terminaux distincts. Les commandes ci-dessous réutilisent le jeu local de certificats et le port Metro habituel. Garder le routage Windows/WSL qui a servi à la campagne et vérifier l’écran avant le contrôle. [Configuration de la fixture](../native-https-transport-evaluation.md#préparer-les-trois-nouvelles-vérifications-sur-android)

```bash
# Terminal fixture, uniquement si le service est arrêté
cd /home/nicolas/bunny-talks
node apps/mobile/qualification/server.ts /home/nicolas/.local/share/bunny-talks/https-qualification
```

```bash
# Terminal Metro, uniquement si le service est arrêté
cd /home/nicolas/bunny-talks/apps/mobile
EXPO_PUBLIC_HTTPS_QUALIFICATION=1 pnpm start
```

Pour l’analyse locale, le binaire officiel Linux x86_64 **Trace Processor v59.1** a été téléchargé et exécuté dans `/tmp`. Si le fichier temporaire a disparu, le récupérer et vérifier l’empreinte publiée dans le lanceur officiel. Le code applicatif n’a besoin d’aucun paquet supplémentaire. [Trace Processor CLI](https://perfetto.dev/docs/reference/trace-processor-cli)

```bash
tp=/tmp/bunny-trace_processor-v59.1
if [ ! -x "$tp" ]; then
  tp_dir=$(mktemp -d /tmp/bunny-perfetto-tools.XXXXXXXX)
  tp="$tp_dir/trace_processor"
  curl --fail --location https://commondatastorage.googleapis.com/perfetto-luci-artifacts/v59.1/linux-amd64/trace_processor_shell -o "$tp"
  printf '%s  %s\n' 2434129a3af4dc9e2034a476f7b76447b490975213e301769310d3bd0d5d6458 "$tp" |
    sha256sum --check && chmod 700 "$tp"
fi
"$tp" --version
```

## 2. Fonctions de capture

La configuration cible **un seul PID**, résolu depuis le nom exact du processus juste avant chaque trace. Elle ne demande que `libc.malloc`. Le tampon Perfetto est de 16 Mio, la mémoire partagée de 8 Mio et le fichier est plafonné à 64 Mio. L’échantillonnage est de 4 096 octets, le client ne bloque pas sur saturation du tampon et un instantané est demandé toutes les 5 s. Le délai et le plafond arrêtent la session. Les relevés prennent l’heure UTC et l’uptime Android pour rapprocher la capture et les mesures. [Paramètres Perfetto](https://perfetto.dev/docs/reference/trace-config-proto) · [CLI Android](https://perfetto.dev/docs/reference/perfetto-cli)

```bash
template=docs/development/perfetto/bounded-https-native.pbtxt
control=http://127.0.0.1:9448
archive=~/bunny-profiler
snapshot_mode=periodic

bunny_pid() {
  bunny_adb shell pidof fr.bunnytalks.mobile | tr -d '\r'
}

bunny_clock() {
  date -u +%Y-%m-%dT%H:%M:%S.%NZ
  bunny_adb shell 'date -u +%Y-%m-%dT%H:%M:%SZ; cat /proc/uptime' | tr -d '\r'
}

bunny_prepare() {
  pid=$(bunny_pid) && [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  out=$(mktemp -d "$archive/heapprofd-$1.XXXXXXXX") || return 1
  remote="/data/misc/perfetto-traces/bunny-${out##*/}.pftrace"
  sed -e "s/@PID@/$pid/g" -e "s/@DURATION_MS@/$2/g" "$template" > "$out/config.pbtxt" || return 1
  printf '%s\n' "$pid" > "$out/pid.txt"
  {
    bunny_adb version
    "$tp" --version
    bunny_adb shell getprop ro.build.fingerprint
    bunny_adb shell dumpsys package fr.bunnytalks.mobile |
      tr -d '\r' | rg 'versionCode|versionName|DEBUGGABLE|lastUpdateTime|primaryCpuAbi'
    bunny_adb shell 'p=$(pm path fr.bunnytalks.mobile | head -n 1 | cut -d: -f2-); sha256sum "$p"'
    sha256sum apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
  } > "$out/build.txt" || return 1
  bunny_adb shell perfetto --query > "$out/service-before.txt" || return 1
  rg -q '^Tracing sessions: 0 ' "$out/service-before.txt"
}

bunny_start() {
  [[ "$(bunny_pid)" == "$pid" ]] || return 1
  bunny_clock > "$out/start-before.txt" || return 1
  if ! bunny_adb shell -T perfetto --txt -c - -D --no-clobber -o "$remote" \
     < "$out/config.pbtxt" > "$out/perfetto.stdout" 2> "$out/perfetto.stderr"; then
    return 1
  fi
  recorder=$(tr -d '\r' < "$out/perfetto.stdout")
  [[ "$recorder" =~ ^[1-9][0-9]*$ ]] || return 1
  bunny_clock > "$out/start-ready.txt"
}

bunny_stop() {
  [[ "$recorder" =~ ^[1-9][0-9]*$ ]] || return 1
  bunny_adb shell "test \"\$(cat /proc/$recorder/comm)\" = perfetto && kill -TERM $recorder"
}

bunny_collect() {
  bunny_adb shell perfetto --query > "$out/service-after.txt" || return 1
  rg -q '^Tracing sessions: 0 ' "$out/service-after.txt" || return 1
  test ! -e "$out/raw.pftrace" || return 1
  bunny_adb exec-out cat "$remote" > "$out/raw.pftrace.part" || return 1
  test -s "$out/raw.pftrace.part" || return 1
  sha=$(bunny_adb shell sha256sum "$remote" | tr -d '\r') || return 1
  printf '%s  %s\n' "${sha%% *}" "$out/raw.pftrace.part" | sha256sum --check || return 1
  mv "$out/raw.pftrace.part" "$out/raw.pftrace"
}

bunny_events() {
  curl --fail --silent --show-error "$control/events" > "$out/$1-events.json"
}

bunny_reset() {
  curl --fail --silent --show-error -X POST "$control/reset" -o /dev/null
}

bunny_manual_dump() {
  local daemon
  daemon=$(bunny_adb shell pidof -s heapprofd | tr -d '\r') || return 1
  [[ "$daemon" =~ ^[1-9][0-9]*$ ]] && bunny_adb shell "kill -0 $daemon" || return 1
  bunny_clock > "$out/$1-manual-before.txt" || return 1
  bunny_adb shell "kill -USR1 $daemon" || return 1
  bunny_clock > "$out/$1-manual-after.txt"
}

bunny_checkpoint() {
  [[ "$(bunny_pid)" == "$pid" ]] || return 1
  bunny_clock > "$out/$1-before.txt" || return 1
  if [[ "$snapshot_mode" == manual ]]; then
    bunny_manual_dump "$1" > "$out/$1-manual-result.txt" 2>&1 ||
      printf 'Signal unavailable for %s. Periodic snapshots remain enabled.\n' "$1"
  fi
  bunny_adb shell dumpsys meminfo -d "$pid" | tr -d '\r' > "$out/$1-meminfo.txt" || return 1
  rg -q "MEMINFO in pid $pid " "$out/$1-meminfo.txt" || return 1
  sleep 7
  bunny_clock > "$out/$1-after.txt" || return 1
  [[ "$(bunny_pid)" == "$pid" ]]
}

bunny_inspect() {
  "$tp" --no-agent query "$out/raw.pftrace" \
    "SELECT p.pid, h.upid, h.heap_name, COUNT(*) AS rows, COUNT(DISTINCT h.ts) AS dumps, SUM(CASE WHEN h.size > 0 THEN h.size ELSE 0 END) AS allocated_bytes FROM heap_profile_allocation h LEFT JOIN process p ON p.upid = h.upid GROUP BY p.pid, h.upid, h.heap_name" \
    > "$out/profile-sources.txt" 2> "$out/analysis.stderr" || return 1
  "$tp" --no-agent query "$out/raw.pftrace" \
    "SELECT * FROM stats WHERE value != 0 AND (name LIKE 'heapprofd_%' OR severity IN ('error','data_loss'))" \
    > "$out/trace-stats.txt" 2>> "$out/analysis.stderr" || return 1
  "$tp" --no-agent query "$out/raw.pftrace" \
    "SELECT p.pid, h.heap_name, h.ts_end AS dump_ns FROM heap_profile h JOIN process p ON p.upid = h.upid ORDER BY h.ts_end" \
    > "$out/snapshots.txt" 2>> "$out/analysis.stderr"
}
```

## 3. Contrôle préalable court

Ouvrir l’écran de qualification HTTPS et rester au premier plan. Détacher les autres profileurs. Conserver les événements du passage précédent avant le premier reset. Utiliser uniquement la fixture factice pendant le contrôle. Si une commande échoue, interrompre ce passage et conserver ses journaux.

1. Exécuter `bunny_prepare controle 60000 && bunny_events avant-controle && bunny_reset && bunny_start`. Vérifier le PID et noter le lancement. L’acquittement du CLI indique le démarrage de la source, l’existence d’allocations échantillonnées sera vérifiée dans le fichier.
2. Pendant la trace de 60 s, appuyer sur **Démarrer la connexion lente**. Lire les compteurs avec `bunny_events controle-fragment`. Dès que l’événement confirme le premier fragment et une connexion ouverte, appuyer sur **Annuler après confirmation serveur**. Attendre les deux réponses de réutilisation. Relever les issues visibles avec les heures dans `$out/controle-client.txt`, puis exécuter `bunny_events controle-fin`. Ce contrôle ne lance aucun bloc de cinq cycles.
3. Tester le déclenchement manuel seulement si le service est visible et le shell peut le signaler. Dans cette session unique et avant sa fin, exécuter le bloc ci-dessous une fois. L’horodatage précède le signal. Un succès de la commande se vérifie par un instantané supplémentaire du PID cible hors cadence périodique. Si le service est absent, le signal refusé ou l’instantané indiscernable, retenir le mode périodique.

   ```bash
   bunny_manual_dump controle > "$out/manual-result.txt" 2>&1
   printf 'Code de sortie du signal : %s\n' "$?" >> "$out/manual-result.txt"
   ```

4. Après les 60 s et la finalisation de la session, exécuter `bunny_collect && bunny_inspect`. Vérifier que `bunny_pid` renvoie toujours le PID de `pid.txt`, que la fixture a répondu, que le fichier est lisible et que `profile-sources.txt` contient une seule ligne pour ce PID, un identifiant de processus interne à la trace et le tas `libc.malloc`. Les octets alloués doivent être positifs et plusieurs instantanés présents. Examiner `trace-stats.txt`, `analysis.stderr` et les journaux Perfetto. La somme de contrôle doit correspondre au fichier Android. Ce contrôle sert de point de décision sur la faisabilité. Soumettre son résultat avant la charge complète.

## 4. Trace unique après revue humaine

Démarrer une seule session avec `bunny_prepare charge 720000 && bunny_reset && bunny_start`. Les 12 minutes constituent une limite, la session peut être terminée dès que T2 est acquis. Préparer le chronométrage et la feuille d’observation avant le démarrage. Laisser l’écran au premier plan quelques secondes après l’acquittement. Garder le PID et le runtime JS stables. Toute mesure T0/T1/T2 se fait après 120 secondes de repos à partir de la fin du bloc précédent, affichage stabilisé.

| Point | Séquence avant le repos                                           | Commande à 120 s      |
| ----- | ----------------------------------------------------------------- | --------------------- |
| T0    | Un échauffement de cinq cycles via **Lancer cinq cycles mémoire** | `bunny_checkpoint T0` |
| T1    | Un bloc de cinq cycles avec le même bouton                        | `bunny_checkpoint T1` |
| T2    | Un second bloc identique                                          | `bunny_checkpoint T2` |

À chaque fin de bloc, noter immédiatement l’heure UTC de fin et lancer le délai de 120 s. Capturer les événements pendant le repos avec `bunny_events warmup`, `bunny_events block-1` ou `bunny_events block-2`. Consigner séparément les 25 comptes rendus côté application, dont les succès gzip de 786 443 octets et les catégories de rejet attendues. Utiliser les mêmes gestes pour la lecture des résultats entre blocs et laisser l’écran immobile pendant la fenêtre de mesure. Exiger cinq événements sur chacun des quatre chemins obligatoires et comparer le nombre de premiers fragments et les fermetures pour le chemin d’annulation variable. En cas d’écart, documenter la différence de charge avant toute comparaison quantitative.

Après chaque point, remettre les compteurs à zéro avec `bunny_reset` avant de lancer le bloc suivant. Garder les contrôles de réutilisation hors de la capture complète. En mode périodique, choisir pour chaque point **le premier instantané du PID cible au niveau ou après l’uptime du fichier `Tn-before.txt`**, à un maximum de 7 s de ce marqueur et avant le prochain bloc. Comparer l’uptime Android, première colonne, exprimé en secondes depuis le démarrage, à `dump_ns`, que Trace Processor convertit en nanosecondes sur l’horloge BOOTTIME de la trace Android. Garder l’écran et l’émulateur éveillés. Consigner les trois timestamps retenus ainsi que leurs écarts avec les marqueurs. Si le contrôle confirme le déclenchement manuel et que la revue retient ce mode, exécuter `snapshot_mode=manual` avant de commencer. Utiliser la même règle périodique aux trois points si un instantané manuel est ambigu. [Horloges Perfetto](https://perfetto.dev/docs/concepts/clock-sync)

Après T2, exécuter `bunny_stop`, attendre la fin de la session puis exécuter `bunny_collect && bunny_inspect`. La commande d’arrêt adresse le PID du CLI enregistré au lancement et vérifie son nom. Si la session a atteint sa limite avant T2, récupérer la trace pour diagnostic. Garder le fichier brut, la configuration, les relevés meminfo, les horloges, les informations du build, les événements et les observations client dans le dossier local privé.

### Critères d’arrêt ou de résultat non concluant

- Cible absente ou PID modifié, rechargement Metro, profil concurrent, source indisponible ou échec de démarrage. Préserver les diagnostics du passage.
- Trace illisible ou vide, mauvais PID ou tas, absence d’instantané exploitable dans la fenêtre d’un point, saturation de mémoire partagée, paquets manquants ou plafond atteint avant T2. Contrôler les statistiques heapprofd, les pertes du tampon Perfetto et les messages de Trace Processor. Une perte pendant les fenêtres comparées invalide les soldes.
- Variation manifeste des issues ou délais de la fixture sous profilage. Conserver les résultats en signalant la perturbation. En cas de surcharge au contrôle court, soumettre une cadence plus légère ou un intervalle d’échantillonnage plus grand à la revue avant tout passage complet. Garder la même configuration sur T0, T1 et T2. [Statistiques de trace](https://perfetto.dev/docs/analysis/sql-stats) · [Pertes et surcharge heapprofd](https://perfetto.dev/docs/data-sources/native-heap-profiler#troubleshooting)
- Piles dominantes illisibles après recherche des symboles. Conserver leurs octets en catégorie inconnue. Les mesures restent descriptives, avec une attribution limitée.

## 5. Analyse locale

Après sélection des trois `dump_ns` dans `snapshots.txt`, les saisir dans l’ordre. Le filtre PID et le tas doivent correspondre à la ligne unique vérifiée par `bunny_inspect`.

```bash
read -r -p 'T0, T1, T2 en nanosecondes, séparés par des espaces : ' t0 t1 t2
if [[ "$t0" =~ ^[0-9]+$ && "$t1" =~ ^[0-9]+$ && "$t2" =~ ^[0-9]+$ ]] &&
   (( t0 < t1 && t1 < t2 )); then
  printf 'T0 %s\nT1 %s\nT2 %s\n' "$t0" "$t1" "$t2" > "$out/checkpoints.txt"
  sed -e "s/@PID@/$pid/g" -e "s/@T0_NS@/$t0/g" -e "s/@T1_NS@/$t1/g" -e "s/@T2_NS@/$t2/g" \
    docs/development/perfetto/compare-native-heap.sql > "$out/compare.sql"
  "$tp" --no-agent query -f "$out/compare.sql" "$out/raw.pftrace" \
    > "$out/per-stack.txt" 2>> "$out/analysis.stderr"
fi
```

La requête cumule les deltas signés des allocations jusqu’à chaque instantané pour produire **Unreleased malloc size**. Elle cumule les octets positifs pour **Total malloc size** et les comptes signés pour **Unreleased malloc count**. Comparer les deltas T1 − T0 et T2 − T1 par pile. Un volume alloué important et un faible solde indiquent des allocations temporaires. Une croissance du solde et du nombre d’allocations encore vivantes sur les mêmes piles dans les deux blocs suggère un site d’allocation à examiner. L’échantillonnage donne des estimations. Une pile indique où l’allocation a été faite. Identifier le composant et le chemin d’appel complet avant toute attribution à BoundedHttps, surtout si la pile comporte seulement des noms génériques tels qu’OkHttp ou React Native. [Métriques et exemples SQL de heapprofd](https://perfetto.dev/docs/data-sources/native-heap-profiler#viewing-the-data)

Les colonnes `leaf_*` repèrent la feuille de la pile. Pour remonter ses parents, suivre `parent_id` depuis le `callsite_id` dans `stack_profile_callsite`, puis joindre les frames et les mappings. Les artefacts x86_64 locaux de React Native, JSI, Expo Modules Core et `libappmodules` comportent `.symtab` et des sections DWARF. `libhermesvm.so` ne présente que `.dynsym` dans le répertoire des bibliothèques fusionnées. L’AAR debug conserve également sa version Prefab avec DWARF. Vérifier son Build ID contre celui du mapping de la trace. Les bibliothèques système et vendor restent à vérifier selon les Build IDs et les symboles réellement disponibles. La commande ci-dessous produit une copie enrichie à partir des symboles locaux. Elle conserve le fichier brut et utilise `llvm-symbolizer` du NDK déjà installé. Garder les piles inconnues et les avertissements avec leurs poids. [Symbolisation et Build IDs](https://perfetto.dev/docs/learning-more/symbolization)

```bash
symbol_dir="$PWD/apps/mobile/android/app/build/intermediates/merged_native_libs/debug/mergeDebugNativeLibs/out/lib/x86_64"
ndk_llvm=/home/nicolas/Android/Sdk/ndk/27.1.12297006/toolchains/llvm/prebuilt/linux-x86_64/bin
hermes_symbols=$(find ~/.gradle/caches -type d -path '*/hermes-android-250829098.0.17-debug/prefab/modules/hermesvm/libs/android.x86_64' -print -quit)
readelf -n "$hermes_symbols/libhermesvm.so" | rg 'Build ID'
PATH="$ndk_llvm:$PATH" "$tp" bundle --symbol-paths "$hermes_symbols,$symbol_dir" --verbose \
  "$out/raw.pftrace" "$out/symbolized.tar" 2> "$out/symbolization.stderr"
"$tp" --no-agent query -f "$out/compare.sql" "$out/symbolized.tar" \
  > "$out/per-stack-symbolized.txt" 2>> "$out/analysis.stderr"
```

Pour lire une pile complète, saisir son `callsite_id`. Utiliser `raw.pftrace` à la place de `symbolized.tar` si l’enrichissement a échoué. Les frames apparaissent de la feuille vers la racine.

```bash
read -r -p 'callsite_id à examiner : ' cs
if [[ "$cs" =~ ^[0-9]+$ ]]; then
  "$tp" --no-agent query "$out/symbolized.tar" "
    WITH RECURSIVE stack(id, parent_id, frame_id, level) AS (
      SELECT id, parent_id, frame_id, 0 FROM stack_profile_callsite WHERE id = $cs
      UNION ALL
      SELECT parent.id, parent.parent_id, parent.frame_id, stack.level + 1
      FROM stack JOIN stack_profile_callsite parent ON parent.id = stack.parent_id
    )
    SELECT stack.level, mapping.name, mapping.build_id, frame.rel_pc,
           COALESCE(symbol.name, frame.deobfuscated_name, frame.name) AS function_name
    FROM stack
    JOIN stack_profile_frame frame ON frame.id = stack.frame_id
    LEFT JOIN stack_profile_mapping mapping ON mapping.id = frame.mapping
    LEFT JOIN stack_profile_symbol symbol ON symbol.id = frame.symbol_set_id
    ORDER BY stack.level"
fi
```

Les octets de heapprofd couvrent le tas instrumenté et les allocations postérieures à l’attachement. Des pages en cache ou fragmentées peuvent rester résidentes après libération, et des mappings ou d’autres allocateurs peuvent contribuer au PSS. `Heap Alloc` suit la comptabilité de l’allocateur du processus, avec son propre périmètre. Le PSS mesure des pages résidentes pondérées et le Java Heap décrit l’empreinte managée. Comparer leurs tendances en distinguant leurs périmètres. Le tas Java/ART et la rétention par racines ne sont pas mesurés par cette trace. Un écart entre le solde heapprofd et le PSS peut orienter la revue. Il ne suffit pas à chiffrer la fragmentation ou à exclure une fuite.

Conserver uniquement en local la trace brute, la copie enrichie et les captures d’écran éventuelles. La synthèse destinée à la revue contient les agrégats par famille de piles, la part inconnue, les écarts aux temps cibles, la comparabilité des blocs et les avertissements. Omettre les chemins privés, identifiants et autres données sans rapport avec le diagnostic.
