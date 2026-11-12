# ADR-002 — Identité durable et appareils de confiance

**Statut :** décision produit acceptée ; conception cryptographique à valider.

## Contexte

Le compte doit survivre à la perte d'appareils et permettre leur révocation individuelle.

## Décision

Les appareils de confiance partagent une identité cryptographique durable. Les identifiants d'enregistrement, préclés, sessions et clés locales de stockage sont propres aux appareils lorsque le protocole l'exige. L'historique utilise une archive indépendante. Le parcours principal d'ajout ou de récupération utilise le coffre et le secret de récupération sans ancien appareil ; le transfert par QR code est facultatif et reporté.

La possession de l'identité cryptographique commune ne suffit pas à autoriser un appareil. L'autorisation et la révocation individuelles doivent être garanties indépendamment ; leur mécanisme reste à concevoir et à valider.

## Alternatives

Une identité durable indépendante par appareil nécessiterait un autre modèle de continuité de compte ; faire dépendre la récupération de l'historique des seules sessions copiées la rendrait dépendante d'états de transport temporaires.

## Conséquences

Le transfert, la révocation et la récupération exigent une conception et des tests dédiés. La compromission d'une identité partagée augmente le risque pour tous les appareils ; la délégation et la certification restent ouvertes.
