# État courant — jalon 4.5B2A

Le diagnostic 4.5B1 est validé pour la connectivité HTTP locale depuis React Native sur l’émulateur Android 17 : le développeur a observé le succès avec NestJS disponible et un échec compréhensible lorsque l’API est arrêtée. Cette observation ne qualifie ni la production ni l’annulation native. Les résultats historiques et les limites du diagnostic figurent dans [l’architecture mobile](mobile-architecture.md).

Le jalon courant 4.5B2A fournit une [fondation HTTP applicative](mobile-application-http.md) HTTPS, testée avec un transport simulé mais non composée dans l’application. Aucun transport natif n’est qualifié. La copie des morceaux reçus protège leur contenu contre la réutilisation des buffers par le transport ; les limites de taille, les délais et le refus des réponses incorrectes sont testés en simulation. L’export Metro ne qualifie pas cette fondation non composée.

Avant de transmettre des secrets, il reste à choisir et qualifier sur Android et iOS un transport qui refuse les redirections avant leur suivi, vérifie TLS, omet les identifiants ambiants et fournit une lecture bornée avec annulation. Il faut aussi définir la configuration et les certificats de développement, valider les réponses métier et concevoir le stockage sécurisé des sessions. Aucun secret ne doit emprunter le HTTP local du diagnostic. L’annulation native et le comportement Android pendant une requête lente restent à vérifier pour le diagnostic.

Les stores et le coffre restent à requalifier sur Android après arrêt forcé, sans réinitialiser les données existantes. Les observations antérieures sont conservées dans les rapports [OpenE2EE](mobile-open-e2ee-qualification.md) et [Argon2id](native-argon2-qualification.md).

PostgreSQL local permanent et l’API disposent des fondations décrites dans les [procédures PostgreSQL](postgresql-prisma-foundation.md) et les rapports HTTP. OpenE2EE 14.5.0 et les composants du coffre restent expérimentaux. SEC-CRYPTO-002 et SEC-CRYPTO-003 sont ouverts et bloquants avant production ; aucun parcours complet de récupération ou d’autorisation multi-appareils n’est validé.

L’[historique intégral des jalons](milestone-history.md) conserve les conclusions, limitations et liens antérieurs ; il décrit l’état à chaque étape, pas nécessairement l’état présent.
