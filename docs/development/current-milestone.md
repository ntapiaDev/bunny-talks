# État courant — qualification HTTPS standard clôturée

La revue humaine accepte la candidate URLSession (34 PASS), le démarrage de la Release standard iOS (PASS, `httpsRuntime: NOT_RUN`) et le runtime HTTPS de laboratoire (16 PASS). Le verdict global du laboratoire reste `NOT_RUN` pour la comparaison SwiftDriver. L’étape A et les 33 scénarios instrumentés Android restent acceptés, avec l’inspection et le démarrage de l’APK Release standard sur AVD. Le verrou iOS reste fermé. [Clôture Apple et rapports originaux](native-https-foundation.md#clôture-humaine-de-la-qualification-https-standard) · [Preuve Android](native-https-foundation.md#résultats-android-locaux)

Le parcours métier standard, la comparaison SwiftDriver exhaustive, l’exécution iOS 16.4, les appareils physiques, le trajet TLS déployé, le confinement intégral et les mesures de mémoire, de performances et d’énergie restent ouverts. La commande SwiftDriver standard sera collectée à l’occasion d’une future qualification utile.

Le retrait du banc historique attend la validation de la stratégie de conservation. [Plan de retrait HTTPS](native-https-foundation.md#plan-de-retrait-des-composants-https-historiques)

## Résultats antérieurs applicables

Le démarrage initial de la Release iOS standard et les preuves des candidates libcurl gardent les périmètres acceptés en revue. Les résultats du profil OkHttp à longueur connue restent limités au debug Hermes sur AVD Pixel 8 API 37. Le diagnostic HTTP local se limite au contrôle de santé sans secret. [Historique iOS](milestone-history.md#jalon-45b2c4-c2-b--qualification-fonctionnelle-de-la-candidate-ios-acceptée) · [Preuve Android](native-https-foundation.md#deuxième-run-urlsession-et-diagnostic-commun) · [Diagnostic local](mobile-architecture.md)

Les fondations PostgreSQL et HTTP serveur sont documentées. Les stores et le coffre restent à requalifier sur Android après arrêt forcé. OpenE2EE 14.5.0 et le coffre restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent bloquants avant production. [PostgreSQL](postgresql-prisma-foundation.md) · [OpenE2EE](mobile-open-e2ee-qualification.md) · [Argon2id](native-argon2-qualification.md)
