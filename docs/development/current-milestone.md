# État courant — jalon 4.5B1

Le premier diagnostic HTTP mobile local est proposé à la revue humaine. Il vérifie `/health/live` depuis un Development Build sur émulateur Android reconnu, sans authentification ni données sensibles. Sa composition, ses restrictions et la procédure de qualification sont décrites dans [l'architecture mobile](mobile-architecture.md). Sur l'émulateur Android 17, le développeur a confirmé depuis React Native une connexion réussie lorsque NestJS est disponible et un échec compréhensible lorsque l'API est arrêtée. Les 36 tests mobiles simulés, les vérifications du monorepo et l'export Metro Android ont réussi. Ces résultats ne constituent pas une qualification de production.

Restent à vérifier : l'annulation effective de la requête au niveau natif, le comportement Android pendant une requête volontairement lente et, si nécessaire, le manifeste détaillé de l'APK installé. La sécurité et la configuration du futur client HTTP de production restent à définir et qualifier.

Les stores et le coffre restent à requalifier sur Android après arrêt forcé, sans réinitialiser les données existantes. Les observations antérieures sont conservées dans les rapports [OpenE2EE](mobile-open-e2ee-qualification.md) et [Argon2id](native-argon2-qualification.md).

PostgreSQL local permanent et l’API disposent des fondations décrites dans les [procédures PostgreSQL](postgresql-prisma-foundation.md) et les rapports HTTP. OpenE2EE 14.5.0 et les composants du coffre restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 sont ouverts et bloquants avant production ; aucun parcours complet de récupération ou d’autorisation multi-appareils n’est validé.

L’[historique intégral des jalons](milestone-history.md) conserve les conclusions, limitations et liens antérieurs ; il décrit l’état à chaque étape, pas nécessairement l’état présent.
