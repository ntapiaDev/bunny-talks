# État courant — jalon 4.5B0 bis

L’harmonisation mobile 4.5B0 et la consolidation du monorepo 4.5B0 bis sont proposées à la revue humaine. La structure et ses limites sont décrites dans [l’architecture mobile](mobile-architecture.md) et [l’index documentaire](../README.md).

## État et prochaines actions

- Revoir les changements, puis requalifier les stores et le coffre sur Android après arrêt forcé, sans réinitialiser les données existantes. Les observations antérieures sont conservées dans les rapports [OpenE2EE](mobile-open-e2ee-qualification.md) et [Argon2id](native-argon2-qualification.md) ; elles ne qualifient pas la structure déplacée.
- Après revue de ce jalon, envisager séparément le diagnostic HTTP mobile 4.5B1 ; il n’est pas commencé.
- PostgreSQL local permanent et l’API disposent des fondations décrites dans les [procédures PostgreSQL](postgresql-prisma-foundation.md) et les rapports HTTP. Les suites de persistance et HTTP exigent une base de test dédiée et les garde-fous documentés.
- OpenE2EE 14.5.0 et les composants du coffre restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 sont ouverts et bloquants avant production ; aucun parcours complet de récupération ou d’autorisation multi-appareils n’est validé.

L’[historique intégral des jalons](milestone-history.md) conserve les conclusions, limitations et liens antérieurs ; il décrit l’état à chaque étape, pas nécessairement l’état présent.
