# ADR-002 — Identité durable et appareils de confiance

**Statut :** décision produit acceptée ; conception cryptographique à valider.

## Contexte

Le compte doit survivre à la perte d'appareils et permettre leur révocation individuelle.

## Décision

Les appareils de confiance partagent une identité cryptographique durable. Les identifiants d'enregistrement, préclés, sessions et clés locales de stockage sont propres aux appareils lorsque le protocole l'exige. Une archive indépendante du transport est à étudier pour l'historique. Après authentification et autorisation individuelle par e-mail, un nouvel appareil accède au coffre et le déverrouille avec le mot de passe, sans ancien appareil. La clé de récupération indépendante permet notamment de retrouver le coffre après réinitialisation du mot de passe ; le transfert par QR code est facultatif et reporté.

La possession de l'identité cryptographique commune ne suffit pas à autoriser un appareil. L'autorisation et la révocation individuelles doivent être garanties indépendamment ; leur mécanisme reste à concevoir et à valider.

## Alternatives

Une identité durable indépendante par appareil nécessiterait un autre modèle de continuité de compte ; faire dépendre la récupération de l'historique des seules sessions copiées la rendrait dépendante d'états de transport temporaires.

## Conséquences

Le transfert, la révocation et la récupération exigent une conception et des tests dédiés. La compromission d'une identité partagée augmente le risque pour tous les appareils ; la délégation et la certification restent ouvertes.

**Actualisation du 13 novembre 2026 :** la révocation serveur ne retire pas une copie de clé privée et ne suffit pas à empêcher toute usurpation. En cas de compromission de l'identité commune, une rotation exceptionnelle et une nouvelle vérification de confiance par les correspondants peuvent être nécessaires. Les parcours opérationnels, l'exclusion des futures distributions et les garanties contre un serveur actif restent à valider. Voir [l'audit de transition](../e2ee-transition-audit.md).
