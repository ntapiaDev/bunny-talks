# Initialisation cryptographique locale — qualification Android 3B

**Verdict : prêt pour revue** dans le périmètre testé. La campagne finale sur l’APK corrigé passe pour les capacités Expo ajoutées en 3A : ouverture, garde SQLite, provisionnement SecureStore, transfert de garde, reprise native et préservation sur les refus sacrificiels testés. Elle réutilise les preuves Node et Android B1 pour le coffre et le protocole, avec un seul contrôle d’intégration nominal.

## Périmètre et environnement

- AVD autorisé : `Pixel_8`, serial `emulator-5554`, démarrage terminé, Android 17/API 37, ABI `x86_64`.
- Campagne exécutée le 28 novembre 2026.
- Application : `fr.bunnytalks.mobile.cryptoinitialization`, Release, version `0.1.0`, bundle Hermes embarqué. Le lancement observé était `COLD` depuis `MainActivity`, sans serveur Metro.
- Versions déclarées/résolues : Expo `57.0.25`, expo-sqlite `57.0.3`, expo-secure-store `57.0.4`, expo-file-system `57.0.7`, `@sonnetstationsolutions/expo-argon2` JS `0.1.1` (module Android `0.1.0`). L’autolinking a résolu exactement une occurrence de chacun des quatre modules ciblés.
- SQLCipher est activé par le plugin `expo-sqlite` et `expo.sqlite.useSQLCipher=true`; le binaire contient `libexpo-sqlite.so` avec les symboles SQLCipher inspectés. L’APK contient également `libhermesvm.so`, les modules FileSystem/SecureStore et les bibliothèques natives Argon2id.

Avant installation, les trois applications protégées étaient présentes et le paquet 3B absent. Seul le paquet 3B a été installé puis mis à jour avec la même clé Debug. Les chemins Package Manager des trois autres paquets sont restés identiques après la campagne ; leurs données privées n’ont pas été lues ni ouvertes.

## APK et provenance

Le staging a été créé sous `apps/` depuis `apps/mobile`, lié au `node_modules` du workspace, avec le profil `initialization` et `qualification/crypto/entry.tsx`. Le build Release hors ligne utilise la garde `android.init.gradle`. Une première exécution Android a révélé une erreur du banc : la composition enveloppe les refus de l’adaptateur dans `LocalCryptoInitializationError(UNAVAILABLE)`. Le diagnostic a été corrigé pour capturer la catégorie au point d’ouverture et distinguer les refus adaptateur, les échecs SDK et les erreurs étrangères. Les contextes de la campagne finale sont suffixés `v2` pour ne pas réutiliser les stores synthétiques créés avant cette correction. Le second APK est le candidat final conservé.

| Propriété                              | Résultat                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Identifiant / version                  | `fr.bunnytalks.mobile.cryptoinitialization`, `0.1.0` (`versionCode 1`)                                                   |
| Configuration                          | Release, compile/target SDK 36, min SDK 24                                                                               |
| Signature                              | Certificat Android Debug ; empreinte SHA-256 publique `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| Taille                                 | 99 606 414 octets                                                                                                        |
| SHA-256 APK construit                  | `e955eb5ac4271517409d6b6efb135850dcf4e5fde105d366493ef28cb1b28656`                                                       |
| SHA-256 APK extrait après installation | Identique à l’artefact construit                                                                                         |
| Bundle                                 | `assets/index.android.bundle`, Hermes embarqué ; `libhermesvm.so` présente                                               |
| Artefact conservé                      | `/tmp/bunny-talks-3b-cryptoinitialization.apk`                                                                           |

La signature Debug n’est pas une signature de production. Les chaînes d’aide React Native mentionnant Metro sont présentes dans le bundle, mais le cold launch observé n’a requis aucun serveur Metro.

## Résultats de la campagne finale

| Scénario ciblé                                                             | Verdict et observation                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Création concurrente, reprise, enveloppes et échange                       | **PASS**. Un seul gagnant, une réservation, une provision de clé, une identité et un passage `ready`. Métadonnées protégées refusées, métadonnée ordinaire conservée, préclés et session persistées ; échange chiffré local réel puis réouverture par mot de passe et clé de récupération avec publication, identité et session identiques. Les assertions confirment 2 KDF à la création, 1 à la reprise mot de passe et 0 à la reprise récupération. |
| Transfert de garde                                                         | **PASS**. Un autre contexte s’ouvre alors que le premier client possède toujours son store.                                                                                                                                                                                                                                                                                                                                                            |
| Contention entre connexions SQLite natives                                 | **PASS**. Une connexion SQLite Expo indépendante tient `BEGIN IMMEDIATE`; l’ouverture du second contexte échoue comme `UNAVAILABLE`, puis réussit après libération. Cela qualifie cette contention dans le processus/application observés, pas l’exclusion interprocessus.                                                                                                                                                                             |
| Arrêt après `reservation`                                                  | **PASS**. Après témoin `pending`, l’identité est absente. Le nouveau PID reprend sans nouvelle réservation ni clé, écrit l’identité et `ready`, et conserve la publication.                                                                                                                                                                                                                                                                            |
| Arrêt après `identity`                                                     | **PASS**. L’identité publique correspond au témoin ; la reprise écrit uniquement `ready` et conserve la publication.                                                                                                                                                                                                                                                                                                                                   |
| Arrêt après `ready`                                                        | **PASS**. La reprise conserve publication et identité sans écriture d’initialisation.                                                                                                                                                                                                                                                                                                                                                                  |
| Fichier absent / clé absente / fichier vide / fichier tronqué de 17 octets | **PASS**, refus classifié `FILE` ou `KEY` selon le cas. L’absence de clé ne recrée pas la base ; l’oracle confirme l’état des fichiers et des slots SecureStore inchangé après chaque refus.                                                                                                                                                                                                                                                           |
| Corruption alignée de 512 octets                                           | **PASS**, échec classifié à la frontière `SDK`. Le condensat du fichier altéré et les entrées SecureStore restent inchangés après l’échec d’ouverture.                                                                                                                                                                                                                                                                                                 |
| Clé erronée de forme valide                                                | **PASS**, échec classifié à la frontière `SDK`. Fichier, annexes inventoriées et slots SecureStore restent inchangés après le refus.                                                                                                                                                                                                                                                                                                                   |

L’oracle de fichiers exige maintenant la présence positive du fichier de coordination et d’au moins un témoin du store ciblé ; deux inventaires vides ne peuvent pas réussir. Les frontières d’arrêt ont été confirmées par le témoin persistant avant arrêt, puis par changement de PID après redémarrage. Les arrêts forcés n’ont concerné que le paquet 3B.

## Mesures et contrôles

- Mesures monotones observées dans le nominal : ouverture de création `141 ms` et `559 ms` lors des deux tentatives concurrentes, provisionnement SQLCipher `16 ms`, ouvertures de reprise `66 ms` et `69 ms`.
- Mesure visible sur un refus SDK : ouverture de création `508 ms`, provisionnement `19 ms`, reprise `66 ms`, retard maximal du minuteur JS `161 ms`, scénario `2 005 ms`.
- Au cours de la préparation de l’arrêt `ready`, le retard maximal affiché était `171 ms`. Le minuteur est arrêté avant l’attente de l’arrêt forcé ; les mesures n’incluent pas le temps d’attente.
- Suites ciblées après correction : 45 tests PASS ; `tsc --noEmit` PASS.
- Le premier appel de test a involontairement exécuté d’autres suites malgré le filtre demandé : les deux suites HTTPS ont rencontré `spawnSync bash EPERM`, et deux attentes locales reflétaient l’ancien code d’erreur SDK. Ces contrôles HTTPS n’ont pas été relancés. Le banc a ensuite été ciblé explicitement et les 45 tests concernés ont passé.

## Limites et éléments non testés

- Pas de test interprocessus natif, d’écrivain externe, de conflit entre processus Android, ni de crash au milieu d’un commit SQLite/SecureStore.
- Les frontières arrêtées sont des appels persistants achevés, pas des interruptions arbitraires pendant une transaction.
- La corruption alignée et la mauvaise clé ont conservé les données dans ces observations. Cela ne démontre pas une préservation universelle face à la corruption, aux migrations SDK, à une restauration système, à un appareil physique ou à un autre OS.
- Pas de qualification iOS, appareil physique, sauvegarde/restauration Android, batterie ou aptitude production. Les verrouillages iOS restent fermés.
- OpenE2EE `14.5.0`, le coffre V1, SEC-CRYPTO-002 et SEC-CRYPTO-003 conservent leur statut expérimental/ouvert ; les deux derniers restent bloquants avant production.

## Fichiers modifiés et propreté

- `apps/mobile/src/infrastructure/crypto/expo-local-store.ts` : classification séparée des erreurs levées par l’ouverture SDK.
- `apps/mobile/qualification/crypto/diagnostics/initialization-diagnostics.ts` : corruption alignée, oracle positif, contention SQLite native, transfert de garde et distinction des erreurs à la frontière adaptateur.
- `apps/mobile/tests/expo-local-store.test.ts` : attente alignée sur la catégorie SDK désormais distincte.
- `docs/development/current-milestone.md` et ce rapport : état de pilotage et preuve 3B.

Le staging temporaire et son cache Gradle ont été supprimés après conservation de l’APK indiqué ci-dessus. Aucun nettoyage de données d’application ou des trois paquets protégés n’a été effectué.
