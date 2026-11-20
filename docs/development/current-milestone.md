# État courant — 4.5B2C1 validé au niveau TypeScript

**4.5B2C1 est validé au niveau TypeScript.** La fondation HTTP reçoit un corps complet sous forme d’octets. Le futur adaptateur devra borner le corps décompressé avant livraison, appliquer le délai restant et arrêter réellement la requête sur annulation. Le plafond est de 1 048 576 octets décodés par réponse. Les médias et les transferts volumineux relèveront de mécanismes distincts. Les tests TypeScript vérifient les politiques transmises et les contrôles du client avec un transport simulé. Cette validation ne qualifie aucun transport natif et n’autorise pas l’utilisation de secrets réels. [Contrat HTTP mobile](mobile-application-http.md) · [ADR-004 accepté](../architecture/decisions/004-bounded-mobile-api-responses.md)

**4.5B2C2 reste à engager.** Il devra sélectionner et qualifier le transport natif Android et iOS avec des données factices et sans brancher les parcours réels. L’origine et la confiance TLS par environnement, la limite avant le pont, les délais, les annulations natives, l’absence de rejeu automatique, les copies et la concurrence restent à qualifier pour l’implémentation retenue.

Le diagnostic 4.5B1 est validé pour la connectivité HTTP locale depuis React Native sur l’émulateur Android 17 : le développeur a observé le succès avec NestJS disponible et un échec compréhensible lorsque l’API est arrêtée. Cette observation ne qualifie ni la production ni l’annulation native. Les résultats historiques et les limites du diagnostic figurent dans [l’architecture mobile](mobile-architecture.md).

Le jalon 4.5B2A a fourni la première fondation HTTPS applicative. Les tests simulés vérifiaient les limites, les délais, le rejet des réponses invalides et la stabilité des octets copiés lorsque le transport réutilisait ses buffers. La fondation reste hors composition.

**4.5B2B est terminé comme expérimentation Android.** Les essais avec données factices ont établi le comportement du prototype sur les cas de redirection, TLS, cookies, limite de corps et annulation exercés. La trace montre des libérations partielles de buffers Hermes. Le contrôle du tas après GC est reporté. Le prototype conservé est hors de la composition et de l’autolinking. Le choix du transport définitif et sa qualification sur Android et iOS restent ouverts. [Clôture 4.5B2B](native-https-transport-evaluation.md)

Avant de transmettre des secrets, il faut aussi valider les réponses métier, traiter les issues incertaines et concevoir le stockage sécurisé des sessions. Le HTTP local du diagnostic reste réservé à un contrôle de santé sans secret. L’annulation native et le comportement Android pendant une requête lente restent à vérifier pour ce diagnostic.

Les stores et le coffre restent à requalifier sur Android après arrêt forcé, sans réinitialiser les données existantes. Les observations antérieures sont conservées dans les rapports [OpenE2EE](mobile-open-e2ee-qualification.md) et [Argon2id](native-argon2-qualification.md).

PostgreSQL local permanent et l’API disposent des fondations décrites dans les [procédures PostgreSQL](postgresql-prisma-foundation.md) et les rapports HTTP. OpenE2EE 14.5.0 et les composants du coffre restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 sont ouverts et bloquants avant production ; aucun parcours complet de récupération ou d’autorisation multi-appareils n’est validé.

L’[historique intégral des jalons](milestone-history.md) conserve les conclusions, limitations et liens antérieurs ; il décrit l’état à chaque étape, pas nécessairement l’état présent.
