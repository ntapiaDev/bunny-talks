# Clôture de l’expérimentation HTTPS Android — 4.5B2B

**Expérimentation terminée le 20 novembre 2026.** Le jalon a testé si un transport natif pouvait fermer la réponse, appliquer une borne avant le pont JavaScript et isoler les requêtes des redirections et des identifiants ambiants. `BoundedHttps` a servi de prototype Android sur émulateur. Le choix du transport définitif, sa qualification iOS et Android et sa mise en service restent à effectuer. [Contrat applicatif 4.5B2A](mobile-application-http.md)

## Choix examinés

| Piste                          | Résultat de l’audit                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expo/fetch` sur Expo 57.0.25  | Déjà disponible sur les deux plateformes. L’inspection de `NativeResponse` et `ResponseSink` a montré une accumulation native sans borne avant le démarrage du flux. Le chemin Android de coupure peut écraser un état d’erreur dans la version examinée. Le contrat 4.5B2A exige une lecture incrémentale avec une borne côté transport. Réexaminer cette piste seulement si la version retenue apporte les garanties requises. |
| `react-native-blob-util` 1.1.1 | L’examen documentaire relevait le partage des cookies et l’accumulation des réponses JSON ordinaires. L’écriture sur disque ne démontre pas une limite avant stockage. La bibliothèque n’a été ni installée ni qualifiée.                                                                                                                                                                                                        |
| Module Expo local              | Le prototype Android a permis d’expérimenter un client OkHttp dédié et une borne native sur le corps décompressé. Une réalisation définitive pourrait associer OkHttp sur Android à URLSession sur iOS avec un contrat commun. Elle implique deux implémentations natives à qualifier et maintenir.                                                                                                                              |

Sources du passage initial, en complément de l’inspection du code installé. [Expo #50213 sur la coupure du corps](https://github.com/expo/expo/issues/50213) · [Expo #50212 sur l’annulation](https://github.com/expo/expo/issues/50212) · [Documentation de react-native-blob-util](https://github.com/RonRadtke/react-native-blob-util#readme) · [Modules Expo](https://docs.expo.dev/modules/overview/)

## Garanties observées sur Android 17

- Les 46 événements du prévol, conservés dans `~/bunny-profiler/prevol-https.json`, contiennent les trois contrôles positifs A HTTPS, B HTTPS et C HTTP et les **30 requêtes GET ou POST** sur les statuts 301, 302, 303, 307 et 308. Aucun suivi n’a été observé vers le chemin cible sur la même origine, vers B sur un autre port, ni vers C en HTTP. B partage le nom d’hôte de A.
- Le développeur a relevé des réponses JSON et gzip conformes, des rejets de dépassement après décompression et des coupures détectées, y compris après un préfixe JSON valide. La CA inconnue et le certificat portant un SAN incorrect ont échoué sans requête HTTP applicative observée. Les certificats et le routage étaient ceux de la fixture.
- Le montage OkHttp de l’essai utilise un client dédié sans cookies, cache ni authentificateur serveur ou proxy, sans suivi des redirections HTTP/HTTPS et sans retry de connexion. La vérification TLS et du nom d’hôte utilise les mécanismes de la plateforme. Les événements natifs identifiés au prévol ne contiennent pas de cookie. Des contrôles dédiés d’isolation ont ensuite été rapportés favorables. La preuve concerne le montage et les cas exercés.
- Les relevés bruts de la campagne longue montrent les fermetures prématurées attendues après premier fragment sur les chemins lents reçus, ainsi que la réutilisation des deux places après chacun des dix contrôles. La fixture observe ce qu’elle reçoit. Elle ne date pas les annulations intervenues avant l’arrivée d’une requête HTTP. [Audit mémoire et événements](android-https-memory-audit.md)

## Décisions et limites

Le prototype limite le corps décodé à 1 Mio par appel sur les cas de la fixture, avec une lecture supplémentaire de contrôle. Les deux places bornent les appels enregistrés. Une réservation `start` laissée sans `read` ni `cancel` peut immobiliser une place. La réponse est remise entière à JavaScript. Pour un corps court, le lecteur réserve un tableau de travail, le recopie à la longueur exacte et le pont Expo recopie les octets dans un ArrayBuffer de Hermes. La borne du corps ne fixe pas de plafond pour le PSS, les copies, les files du pont ou les réponses conservées par JavaScript. Le rapport mémoire établit une récupération partielle et l’origine du principal site d’allocation. [Audit mémoire](android-https-memory-audit.md)

Le comportement natif reste une référence expérimentale Kotlin, désormais conservée hors du répertoire d’autolinking Expo. Le module est limité à une application débogable, à l’hôte de fixture `10.0.2.2`, à ses ports de test et à un en-tête Authorization factice. La composition de l’application lance directement les diagnostics existants. La CA de test et son mécanisme d’injection ont été retirés de la configuration de l’application et du projet Android local généré. Les APK déjà construits gardent leur contenu d’origine. [Prototype Kotlin et test du lecteur](../../apps/mobile/qualification/android-prototype/android/src/main/java/fr/bunnytalks/https/BoundedBodyReader.kt) · [Résolution des modules Expo](https://docs.expo.dev/modules/autolinking/)

La fixture Node et ses tests restent disponibles pour qualifier un futur adaptateur. Elle fournit des origines distinctes, des chaînes TLS de test, des redirections, des cookies artificiels, des corps gzip, des coupures et des réponses lentes. Le canal de contrôle écoute sur loopback et les journaux ne stockent ni corps ni valeurs d’en-tête. Les tests Node vérifient la fixture. La qualification du client demeure un essai distinct sur appareil. Le générateur crée un nouveau dossier sous `/tmp` avec des clés de développement locales. [Serveur de fixture](../../apps/mobile/qualification/server.ts) · [Générateur de certificats](../../apps/mobile/qualification/certificates.sh) · [Tests de la fixture](../../apps/mobile/tests/https-fixture.test.ts)

Les qualifications iOS, appareils physiques, builds release, noms d’hôtes réels et cycles de vie en arrière-plan restent ouvertes. La mémoire en charge prolongée, les files et la concurrence restent à caractériser pour le transport retenu. Le contrôle complémentaire du GC Hermes est reporté et ne conditionne plus la clôture de l’expérience.

## Jalon suivant proposé pour revue

Sélectionner et qualifier **un adaptateur HTTPS Android et iOS avec des données factices**, derrière la fondation 4.5B2A. Privilégier une vérification courte d’un client natif dédié, avec des lectures bornées à la demande et un banc commun. Un transport existant reste préférable s’il démontre les mêmes garanties sur les versions retenues. Une réponse complète bornée simplifierait l’adaptateur pour de petits corps, mais demanderait une décision explicite sur le contrat de streaming et sur son budget de copies et de concurrence.

Avant tout envoi d’identifiants, de jetons ou de données chiffrées, décider de l’origine de confiance et de la configuration TLS par environnement. Vérifier le refus des redirections avant envoi vers la cible, l’isolation des cookies et des authentifications implicites, la borne sur les octets décompressés, la contre-pression, le rejet des réponses tronquées, l’annulation et les délais sur les deux plateformes. Contrôler la variante release, l’assainissement des erreurs et journaux, la validation des réponses métier, la gestion des résultats incertains et le stockage sécurisé des sessions. La décision de reprise reste soumise à revue humaine.

## Reprendre l'expérimentation historique 4.5B2B

Le jalon 4.5B2B est clôturé comme expérimentation Android. Le nettoyage a retiré les outils de qualification ponctuels de l'application courante, sans effacer leur historique Git.

### Sources et environnement d'origine

- **Commit expérimental complet :** [`60a129196742e06ec87ad92ee9893d75a63d0946`](https://github.com/ntapiaDev/bunny-talks/tree/60a129196742e06ec87ad92ee9893d75a63d0946) — `feat(mobile): add bounded Android HTTPS qualification prototype`.
- **Commit de clôture :** `b87b164810edb5471b82f6cce6fb4af7179408a4` — `chore(mobile): close Android HTTPS experiment and isolate prototype`.
- **Environnement testé :** émulateur Android 17, API 37, x86_64, application debug `fr.bunnytalks.mobile`, Expo 57.0.25 et React Native 0.86.3.
- **Prototype conservé :** `apps/mobile/qualification/android-prototype/`, hors composition applicative et autolinking Expo.

### Retrouver les tests Android

Le commit expérimental contient les éléments retirés lors du nettoyage :

- `apps/mobile/qualification/QualificationScreen.tsx` : écran et commandes de qualification.
- `apps/mobile/qualification/qualification-scenarios.ts` : scénarios de connexion lente, d'annulation, de cookies et de cycles mémoire.
- `apps/mobile/qualification/prepare-diagnostic.ts` et `fixture-data.ts` : préparation et vérification des réponses.
- `apps/mobile/plugins/with-qualification-ca.cjs` : injection de la CA publique de fixture dans la configuration Android debug.
- `apps/mobile/tests/prepare-diagnostic.test.ts` et `qualification-scenarios.test.ts` : tests des scénarios expérimentaux.

La fixture HTTPS, son générateur de certificats et ses tests Node restent disponibles dans la version courante.

Pour reproduire les anciens essais, rétablir les composants nécessaires dans un environnement de qualification isolé, vérifier leur compatibilité avec les versions installées, puis reconstruire un Development Build Android. L'ancien APK et les résultats historiques ne qualifient pas automatiquement une nouvelle version native.

Les certificats privés de développement restent hors dépôt. Le générateur `certificates.sh` exige un nouveau répertoire sous `/tmp`. Ne jamais utiliser de secrets réels dans cette fixture.

### Retrouver le profilage mémoire

Le commit expérimental conserve également les quatre annexes historiques de `docs/development/perfetto/` :

- `README.md` : procédure ADB, capture et analyse.
- `bounded-https-native.pbtxt` : configuration Perfetto d'origine.
- `compare-native-heap.sql` : comparaison T0/T1/T2.
- `pile-1846.tsv` : pile d'allocation Hermes symbolisée.

**Attention : la configuration initiale de 4 096 octets d'échantillonnage et 8 Mio de mémoire partagée a rencontré des erreurs sous activité HTTPS.**

La capture T0/T1/T2 exploitable utilisait :

- Échantillonnage : **32 768 octets**.
- Mémoire partagée heapprofd : **16 Mio**.
- Instantanés périodiques : **toutes les 5 secondes**.
- Durée maximale configurée : **720 secondes**.
- Protocole : échauffement de cinq cycles, puis deux blocs identiques de cinq cycles, avec 120 secondes de repos avant T0, T1 et T2.

Les résultats détaillés et leurs limites figurent dans [l'audit mémoire Android](android-https-memory-audit.md).

### Archives et traçabilité

Les données brutes et outils locaux ne sont pas intégrés au dépôt :

- Campagne mémoire : `~/bunny-profiler/campagne-20261119-191129/`.
- Capture Perfetto : `~/bunny-profiler/heapprofd-charge.IaPwvQKg/raw.pftrace`.
- SHA-256 de cette trace : `d47218d04396d3c10a3372c1672c178f7bc2dd635696a4131e945a16d669e554`.
- Script d'assistance utilisé : `bunny_perfetto_helpers.sh`, conservé séparément du dépôt.

Ces chemins documentent l'environnement historique ; ils ne garantissent pas la disponibilité future des fichiers. Vérifier leur existence et leur intégrité avant toute réanalyse.

### Conditions de réouverture

Ne reprendre ces investigations que si le transport réellement retenu présente une anomalie mémoire reproductible, si une propriété de sécurité doit être requalifiée ou si une évolution native rend les preuves précédentes insuffisantes.

Privilégier alors un test ciblé sur l'implémentation définitive plutôt que la répétition systématique de la campagne expérimentale. Les conclusions de 4.5B2B concernent exclusivement le prototype, les versions et les conditions effectivement testées.
