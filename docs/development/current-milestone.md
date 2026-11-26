# État courant — qualification expérimentale URLSession clôturée

La revue humaine accepte le sixième run `45826086010` pour la candidate Release arm64 Hermes sur iPhone 17 Simulator iOS 26.5. La matrice compte **31 `PASS`, 0 `FAIL`, 0 `NOT_RUN`**. Le verdict global est `PASS` avec `complete: true`. Le rapport original est archivé après vérification du ZIP. [Rapport](evidence/ios-https-urlsession-45826086010/report.json) · [Périmètre et empreintes](native-https-foundation.md#clôture-du-sixième-run-urlsession)

L’architecture cible retient URLSession sur iOS et OkHttp sur Android, avec un profil JSON standard non compressé à longueur connue, la sérialisation NestJS/Express et le port TypeScript injecté existant. Le verrou iOS reste fermé et les preuves libcurl sont conservées. [ADR-004](../architecture/decisions/004-bounded-mobile-api-responses.md) · [Historique](milestone-history.md)

**En attente de revue humaine.** La feuille de route d’intégration et de retrait progressif de libcurl est prête à examiner. Restent à qualifier DELETE, l’annulation pendant une reprise, le HTTPS des Releases standard, les appareils physiques, le runtime iOS 16.4, le trajet TLS déployé, la mémoire, les performances et l’énergie. L’usage métier et la mise en production requièrent une décision distincte. [Qualifications restantes et feuille de route](native-https-foundation.md#qualifications-restantes)

## Résultats antérieurs applicables

Le démarrage initial de la Release iOS standard et les preuves des candidates libcurl gardent les périmètres acceptés en revue. Les résultats du profil OkHttp à longueur connue restent limités au debug Hermes sur AVD Pixel 8 API 37. Le diagnostic HTTP local se limite au contrôle de santé sans secret. [Historique iOS](milestone-history.md#jalon-45b2c4-c2-b--qualification-fonctionnelle-de-la-candidate-ios-acceptée) · [Preuve Android](native-https-foundation.md#deuxième-run-urlsession-et-diagnostic-commun) · [Diagnostic local](mobile-architecture.md)

Les fondations PostgreSQL et HTTP serveur sont documentées. Les stores et le coffre restent à requalifier sur Android après arrêt forcé. OpenE2EE 14.5.0 et le coffre restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent bloquants avant production. [PostgreSQL](postgresql-prisma-foundation.md) · [OpenE2EE](mobile-open-e2ee-qualification.md) · [Argon2id](native-argon2-qualification.md)
