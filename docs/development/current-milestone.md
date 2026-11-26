# État courant — intégration native HTTPS étape A

Les sources standard d’`ApplicationHttps` utilisent URLSession sur iOS et OkHttp sur Android avec le profil JSON non compressé à longueur connue. Le banc iOS utilise la même source Swift. Le port TypeScript, les parcours métier et la sérialisation serveur sont conservés. Le verrou iOS reste fermé et l’origine native standard attend une approbation explicite. Les sources, recettes et preuves libcurl sont conservées. [Intégration, écarts et qualification suivante](native-https-foundation.md#intégration-native-étape-a) · [ADR-004](../architecture/decisions/004-bounded-mobile-api-responses.md)

Le sixième run expérimental `45826086010` reste la preuve acceptée pour la candidate Release arm64 Hermes sur iPhone 17 Simulator iOS 26.5. La matrice compte 31 `PASS`, 0 `FAIL` et 0 `NOT_RUN`, avec un verdict global `PASS` et `complete: true`. [Rapport original](evidence/ios-https-urlsession-45826086010/report.json) · [Historique](milestone-history.md)

**En attente de revue humaine.** L’étape A est vérifiée par staging Expo iOS et compilation Kotlin locale. Les témoins préparés couvrent DELETE, la reprise GET interrompue sur iOS, la troisième réservation et la récupération après une réponse mal cadrée. La compilation Swift, les contrôles sur les binaires Release standard et leur runtime HTTPS restent à exécuter. La qualification sur appareils physiques, iOS 16.4, le trajet TLS déployé, la mémoire, les performances et l’énergie reste ouverte. [Reprise de la qualification standard](native-https-foundation.md#reprise-de-la-qualification-standard)

## Résultats antérieurs applicables

Le démarrage initial de la Release iOS standard et les preuves des candidates libcurl gardent les périmètres acceptés en revue. Les résultats du profil OkHttp à longueur connue restent limités au debug Hermes sur AVD Pixel 8 API 37. Le diagnostic HTTP local se limite au contrôle de santé sans secret. [Historique iOS](milestone-history.md#jalon-45b2c4-c2-b--qualification-fonctionnelle-de-la-candidate-ios-acceptée) · [Preuve Android](native-https-foundation.md#deuxième-run-urlsession-et-diagnostic-commun) · [Diagnostic local](mobile-architecture.md)

Les fondations PostgreSQL et HTTP serveur sont documentées. Les stores et le coffre restent à requalifier sur Android après arrêt forcé. OpenE2EE 14.5.0 et le coffre restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent bloquants avant production. [PostgreSQL](postgresql-prisma-foundation.md) · [OpenE2EE](mobile-open-e2ee-qualification.md) · [Argon2id](native-argon2-qualification.md)
