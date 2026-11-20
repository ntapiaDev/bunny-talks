# Mémoire de BoundedHttps sur Android 17 — bilan 4.5B2B

L’expérimentation est clôturée. La récupération partielle est observée sur les deux campagnes. Les données ne démontrent aucune fuite imputable à BoundedHttps et laissent ouverte la possibilité d’une rétention ou d’une récupération tardive. Le contrôle du tas JS après GC est reporté. [Bilan du transport](native-https-transport-evaluation.md)

## Campagne avec dix séries

Le dossier `~/bunny-profiler/campagne-20261119-191129/` contient les 65 relevés `dumpsys meminfo -d` et les événements du PID 19746. La charge comprend un témoin, un échauffement distinct et dix séries de cinq cycles. Sur 250 tentatives attendues, la fixture confirme 200/200 arrivées obligatoires et 38/50 arrivées d’annulation temporisée. Les 38 connexions observées se ferment prématurément après le premier fragment. Les deux places sont réutilisables aux dix contrôles hors charge. Les résultats de l’application reposent sur des confirmations manuelles.

Au repos à 120 s, le Native Heap de l’App Summary monte de 178 380 Kio (référence avant série 1) à 188 776 Kio (série 6), tombe à 178 096 Kio (série 7), puis remonte à 184 096 Kio (série 10). La baisse entre 6 et 7 atteint **10 680 Kio**, avec −12 828 Kio de Heap Alloc, −9 668 Kio de Heap Size et −10 250 Kio de PSS total. La diminution d’Alloc soutient une libération d’allocations natives au niveau du processus. Le Java Heap reste autour de 15,4 Mio aux repos. L’identité des allocations libérées en série 7 et le déclencheur de la baisse restent inconnus.

## Profil natif du chemin gzip

La capture de la nuit du 19 au 20 novembre 2026 a été vérifiée depuis `~/bunny-profiler/heapprofd-charge.IaPwvQKg/raw.pftrace` (SHA-256 `d47218d04396d3c10a3372c1672c178f7bc2dd635696a4131e945a16d669e554`). Le dossier local contient la configuration, les points de comparaison, les résultats réseau et les requêtes SQL. Trace Processor v59.1 restitue 93 instantanés du PID 24878 au taux de 32 768 octets et avec 16 Mio de mémoire partagée. Les statistiques ne relèvent aucune perte invalidante. Les quatre chemins obligatoires ont chacun cinq arrivées par bloc, et les arrivées du chemin d’annulation variable sont de 3, 2 et 5. Chaque point suit un repos de 120 s.

| Point                    | Octets cumulés alloués sur la pile 1846 | Octets encore alloués | Allocations / libérations cumulées |
| ------------------------ | --------------------------------------: | --------------------: | ---------------------------------: |
| T0 après échauffement    |                               3 932 215 |             2 359 329 |                              5 / 2 |
| T1 après le premier bloc |                               7 864 430 |             3 145 772 |                             10 / 6 |
| T2 après le second bloc  |                              11 796 645 |             5 505 101 |                             15 / 8 |

Les deltas de la pile correspondent à des unités de **786 443 octets**, la taille de la réponse gzip décodée. Chaque bloc produit cinq allocations de cette taille. Quatre sont libérées entre T0 et T1, puis deux entre T1 et T2. Les hausses nettes de la pile expliquent 48,5 % puis 97,8 % des hausses nettes toutes piles confondues dans la trace. Ces proportions portent sur le périmètre natif suivi par heapprofd. Le PSS mesure une empreinte de pages et `Heap Alloc` une comptabilité à l’échelle du processus.

### Attribution et durée de vie

Le lecteur Kotlin remplit un tableau borné sur ART, le recopie à la longueur réelle si nécessaire, puis résout sa promesse avec le résultat. Expo Modules Core 57.0.26 enregistre temporairement le tableau dans `FollyDynamicExtensionConverter.instanceMap`. `JavaCallback::invokeMap` planifie la conversion sur le thread JavaScript. `get` retire l’entrée en consommant le marqueur. Ensuite `expo::createUint8Array` demande à Hermes un `ArrayBuffer(n)`, y copie les octets par JNI et construit une vue `Uint8Array` sur ce stockage. Le callback se termine et relâche ses références sur le chemin ordinaire.

La feuille de 1846 est `JSArrayBuffer::createDataBlock`, au PC relatif `0x2b5d17` sur l’appel à `calloc`. Le mapping a été résolu avec les symboles DWARF du module Prefab de l’AAR debug Hermes x86_64 `250829098.0.17`, Build ID `9b007fe59fb3f3864762372b9b6bc9819c9647b4`. La copie JNI présente dans l’APK fournit seulement des symboles dynamiques. Le descripteur et les frames déterminent le site d’allocation, avec une symbolisation partielle pour certains cadres système. [Code de gestion des ArrayBuffer dans Hermes](https://github.com/facebook/hermes/blob/hermes-v250829098.0.17/lib/VM/JSArrayBuffer.cpp)

Une vue ou une promesse encore référencée peut maintenir le stockage accessible. Un ArrayBuffer interne devenu inaccessible devient collectable et son finaliseur libère son stockage natif. Le banc n’a pas présenté de collection de corps terminés dans le code inspecté. Une livraison abandonnée avant la conversion pourrait laisser le tableau d’origine dans le registre Expo côté Java, en amont de la pile 1846. La trace ne contient ni racines JS ni événements de GC pour les sept buffers restants. Une collecte différée est compatible avec ces résultats. La chute de la série 7 concerne un autre PID et reste sans attribution.

Deux piles secondaires progressent aussi. La pile 4752 concerne le stockage des mesures React Native dans `PerformanceEntryKeyedBuffer::add` (+344 064 puis +86 016 octets). La pile 1880 concerne les piles d’erreur `JSError::recordStackTrace`, via `consoleTaskRun` (+131 072 puis +163 840 octets). Le nom des mesures, l’origine des erreurs et les références restantes sont indéterminés.

La clôture retient ces observations comme preuves expérimentales. Elle laisse reportés le contrôle des racines JS après GC, la mesure d’un plafond d’empreinte résidente sous charge prolongée et les essais du futur transport définitif sur les deux plateformes. Les archives de capture restent hors dépôt.
