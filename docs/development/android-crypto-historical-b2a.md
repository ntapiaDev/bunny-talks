# Investigation de l’état historique Android — B2-A

**Archive de qualification.** La revue indépendante de la révision `84454c018761404327ef113ebdf76bfd485fb3e0` accepte l’investigation B2-A. La compatibilité de signature est établie. La présence et l’intégrité de l’état historique restent inconnues. B2-B a été abandonné sans exécution ni PASS au profit d’une future qualification de migration sur l’état synthétique B1. Le candidat historique est conservé comme preuve de compilation et d’inspection statique, sans installation.

Aucun paquet n’a été lancé, installé, arrêté de force ou désinstallé pendant B2-A. Aucune base, clé privée ou valeur SecureStore historique n’a été lue ou exportée. L’AVD n’a été ni arrêté, ni sauvegardé, ni restauré.

## Clôture de B1

B1 est accepté après revue indépendante de la révision `02f26fe83df645d901f05152572c6ac335134827` dans son périmètre : APK produit inspecté, APK crypto dédié inspecté, scénarios synthétiques OpenE2EE/SQLCipher/SecureStore/coffre passés sur `Pixel_8`, reprise après arrêt forcé du seul paquet synthétique et préservation des applications préexistantes. Le rendu de l’APK produit standard demeure différé ; ce n’est pas un PASS. Les accès par mot de passe et récupération à la publication persistée ont réussi, mais aucune comparaison de digest de publication avant/après redémarrage n’est revendiquée. Le détail B1 demeure dans le [rapport B1](android-crypto-isolation-b1.md).

## Inventaire ADB et compatibilité

ADB Windows utilisé depuis WSL : `/mnt/c/Users/Nicolas/AppData/Local/Android/Sdk/platform-tools/adb.exe`.

| Élément                       | Observation en lecture seule                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Serial / AVD                  | `emulator-5554` / `Pixel_8` ; SDK Android 37 (Android 17), utilisateur Android 0                                                                                         |
| Build système                 | `google/sdk_gphone64_x86_64/emu64xa:17/CE2A.260420.051.A2/16418371:user/release-keys`                                                                                    |
| Emulator                      | Android Emulator `37.2.13.0`, build `16740729`                                                                                                                           |
| Config AVD                    | `C:\Users\Nicolas\.android\avd\Pixel_8.ini` et `C:\Users\Nicolas\.android\avd\Pixel_8.avd\config.ini`                                                                    |
| Image système                 | `C:\Users\Nicolas\AppData\Local\Android\Sdk\system-images\android-37.0\google_apis_playstore\x86_64\`                                                                    |
| Stockage AVD                  | Partition données configurée à 10 Gio ; Play Store activé ; ABI `x86_64`                                                                                                 |
| Snapshot déjà présent         | `default_boot`, daté du 21 novembre 2026. Il n’a pas été chargé ni modifié et précède l’installation actuelle des applications ; ne pas le traiter comme sauvegarde B2-A |
| Application historique        | `fr.bunnytalks.mobile`, version `0.1.0`, `versionCode=1`, `targetSdk=36`; premier install 14 novembre, dernière mise à jour 18 novembre 2026                             |
| Autres applications présentes | `fr.bunnytalks.mobile.httpsqualification` et `fr.bunnytalks.mobile.cryptoqualification`; leurs états n’ont pas été ouverts ni modifiés                                   |

L’APK extrait de `fr.bunnytalks.mobile` vérifie la signature APK v2. Son certificat public SHA-256 est `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` ; le digest de clé publique est `06104aa0b28fac286bae06b08313ac69c37c35a6462853db32d2ec5fa7b1ed0e`. Le keystore local `apps/mobile/android/app/debug.keystore`, alias `androiddebugkey`, expose le même certificat public. L’APK candidat expose le même certificat et la même clé publique : la compatibilité de signature Android avec l’installation est donc établie pour cet artefact de test signé avec le certificat Android Debug. Ce certificat de debug ne convient pas à une distribution de production.

La présence du paquet n’établit pas celle de ses bases, de ses clés ni de ses témoins. Aucune donnée applicative n’a été sondée pour l’inventorier.

## Provenance du candidat historique

En B2-A, le prebuild Expo a été exécuté depuis une copie temporaire du workspace mobile sous `apps/`, liée au `node_modules` de la source. Gradle a assemblé une Release pour `fr.bunnytalks.mobile`, avec un bundle Hermes de 1031 modules issu de `qualification/crypto/entry.tsx`. L’autolinking incluait `expo-secure-store@57.0.4` et `expo-sqlite@57.0.3`. AAPT a confirmé l’identité, la version et les ressources `secure_store_backup_rules` et `secure_store_data_extraction_rules`. Le profil historique a été retiré en C.

| Artefact candidat  | Valeur                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- |
| Paquet / version   | `fr.bunnytalks.mobile`, `0.1.0`, `versionCode=1`                                       |
| Taille / SHA-256   | 99 559 574 octets / `b6761e0dcb027f3ac65a0c8512db4c8e886b956774a87e1d535328b81dd07945` |
| Certificat SHA-256 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`                     |
| Chemin de revue    | `/tmp/bunny-talks-b2a-historical.apk`                                                  |
| Installation       | **Aucune**                                                                             |

Le candidat affichait un écran bloquant avant tout appel aux stores. Les tests du profil et du classifieur avaient passé 10 cas sur 10. Le build et ces tests n’établissaient aucune propriété de l’état persistant historique.

## Limites observées dans les dépendances installées

- **`@open-e2ee/signal-protocol-sdk@14.5.0`.** Dans `dist/local/store/expo/adapter.js`, `expoStore()` appelle `ExpoSignalProtocolStore.open()`, qui délègue à `openSqliteStore()`. Le premier usage peut créer une clé et un fichier. `dist/local/store/sqlite/open-store.js` appelle `openMigratedSqliteDatabase()` dans `migrations.js`. Dans `dist/local/store/expo/driver.js`, `createExpoSqliteDriver().exists()` ouvre le fichier pour lire `PRAGMA page_count` et supprime la base si le nombre de pages est nul. La documentation distribuée dans `local/store/expo/README.md` décrit cette limite du test d’existence. L’API publique examinée ne garantit pas une prélecture sans mutation.
- **`expo-secure-store@57.0.4`.** Dans `src/SecureStore.ts`, `getItemAsync()` appelle le module natif. Dans `android/src/main/java/expo/modules/securestore/SecureStoreModule.kt`, le chemin de lecture appelle `deleteItemImpl()` et renvoie `null` si l’entrée AES correspondante manque dans Android Keystore ou si le déchiffrement lève `BadPaddingException`.

Les témoins OpenE2EE, le coffre diagnostique historique et la publication du coffre natif sont des états distincts. Une lecture authentifiée réussie après ouverture ne permet pas de conclure que l’ouverture a préservé l’état préalable. L’analyse de ces chemins doit être reprise pour les versions réellement utilisées lors d’une migration.

## Préservation future de l’unique AVD

Ces commandes décrivent la préservation de Pixel_8 pour une future campagne autorisée. Elles n’ont été exécutées ni en B2-A ni en C. Ne jamais charger l’ancien `default_boot` comme rollback. Une sauvegarde logique Android d’application, un snapshot AVD et une copie à froid de l’AVD ne sont pas équivalents.

### Snapshot AVD

Quand `Pixel_8` est démarré et ADB en ligne, vérifier de nouveau le serial et le nom, puis enregistrer un snapshot distinct via la console de l’émulateur :

```bash
ADB=/mnt/c/Users/Nicolas/AppData/Local/Android/Sdk/platform-tools/adb.exe
"$ADB" devices -l
"$ADB" -s emulator-5554 emu avd name
"$ADB" -s emulator-5554 emu avd snapshot save pre-migration-YYYY-MM-DD
"$ADB" -s emulator-5554 emu avd snapshot list
```

Android documente qu’un snapshot AVD inclut l’état de l’appareil virtuel et les données utilisateur ; il dépend de la même image système, configuration et version/possibilités d’émulateur. Ce constat ne constitue pas une qualification de transfert ou restauration d’une clé Android Keystore non exportable. Conserver le snapshot sur ce même AVD et garder l’image exacte disponible. [Documentation officielle des snapshots](https://developer.android.com/studio/run/emulator-snapshots), [commandes console AVD](https://developer.android.com/studio/run/emulator-console).

### Copie intégrale à froid

Pour une copie de fichiers cohérente, sauver d’abord le snapshot ci-dessus, puis fermer proprement l’émulateur après autorisation et confirmer que `emulator-5554` est absent d’ADB et qu’aucun `emulator.exe` Pixel_8 ne tourne. Ne pas copier les disques AVD pendant qu’ils sont utilisés.

Copier dans un nouveau répertoire de sauvegarde, sans `/MIR` ni écrasement, ces deux éléments :

- AVD : `C:\Users\Nicolas\.android\avd\Pixel_8.avd\` ;
- référence AVD : `C:\Users\Nicolas\.android\avd\Pixel_8.ini`.

Avec PowerShell, choisir une destination neuve par horodatage :

```powershell
$SourceAvd = Join-Path $env:USERPROFILE '.android\avd'
$BackupRoot = Join-Path $env:USERPROFILE ('BunnyTalks-AVD-Backups\Pixel_8-pre-migration-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $BackupRoot
robocopy (Join-Path $SourceAvd 'Pixel_8.avd') (Join-Path $BackupRoot 'Pixel_8.avd') /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
Copy-Item (Join-Path $SourceAvd 'Pixel_8.ini') $BackupRoot
Get-ChildItem $BackupRoot -File -Recurse | Get-FileHash -Algorithm SHA256 | Export-Csv (Join-Path $BackupRoot 'sha256.csv') -NoTypeInformation
```

Vérifier le code de sortie Robocopy (`0–7` : copie effectuée sans échec ; `8+` : échec) et le manifeste avant toute installation. Le fichier AVD référence une image SDK stockée hors de `.avd` : `C:\Users\Nicolas\AppData\Local\Android\Sdk\system-images\android-37.0\google_apis_playstore\x86_64\`. Pour une restauration ultérieure, conserver aussi l’installation correspondante de cette image et l’émulateur `37.2.13.0`, ou les réinstaller exactement. La copie d’un AVD n’est pas une preuve de restauration de clés Keystore sur une autre installation hôte.

### Sauvegarde Android d’application

Auto Backup Android est une sauvegarde applicative pilotée par manifeste/service système ; elle ne contient ni l’état de démarrage complet de l’AVD, ni une garantie de transfert de clés Keystore. Elle ne remplace ni le snapshot de cet AVD ni sa copie à froid. Ne pas utiliser `adb backup` comme substitut à cette procédure. [Présentation officielle de la sauvegarde Android](https://developer.android.com/identity/data/backup), [règles Auto Backup](https://developer.android.com/identity/data/autobackup).
