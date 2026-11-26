# État courant — qualification HTTPS standard étape B

La revue humaine accepte l’étape A à la révision `f468f303b3e0ce8ecb5fdb9172343aef4356d63f`. Le plan Android instrumenté compte 33 PASS et l’APK Release standard a été construit, inspecté, installé et démarré sur AVD. La préparation Apple et les limites de ces preuves sont décrites dans la fondation HTTPS. Le verrou iOS reste fermé. [Préparation et résultats](native-https-foundation.md#qualification-https-standard-étape-b--préparation-locale)

## Résultats antérieurs applicables

Le démarrage initial de la Release iOS standard et les preuves des candidates libcurl gardent les périmètres acceptés en revue. Les résultats du profil OkHttp à longueur connue restent limités au debug Hermes sur AVD Pixel 8 API 37. Le diagnostic HTTP local se limite au contrôle de santé sans secret. [Historique iOS](milestone-history.md#jalon-45b2c4-c2-b--qualification-fonctionnelle-de-la-candidate-ios-acceptée) · [Preuve Android](native-https-foundation.md#deuxième-run-urlsession-et-diagnostic-commun) · [Diagnostic local](mobile-architecture.md)

Les fondations PostgreSQL et HTTP serveur sont documentées. Les stores et le coffre restent à requalifier sur Android après arrêt forcé. OpenE2EE 14.5.0 et le coffre restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent bloquants avant production. [PostgreSQL](postgresql-prisma-foundation.md) · [OpenE2EE](mobile-open-e2ee-qualification.md) · [Argon2id](native-argon2-qualification.md)
