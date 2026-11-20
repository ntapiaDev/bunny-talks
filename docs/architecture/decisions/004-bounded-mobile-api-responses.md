# ADR-004 — Réponses bornées de l’API métier mobile

**Statut** — accepté en 4.5B2C1.

## Contexte

La fondation 4.5B2A lit des fragments via un transport injecté. Les routes d’inscription, de connexion, de session et d’amorçage renvoient de petits résultats JSON ou un 204 vide. Le prototype Android 4.5B2B a expérimenté la livraison d’un corps entier après contrôle de taille natif. Il a aussi mis en évidence plusieurs copies et une occupation mémoire qui dépend de la concurrence. [Clôture de l’expérimentation](../../development/native-https-transport-evaluation.md)

## Décision

Le port reste dans l’infrastructure HTTP de l’application mobile. Le client TypeScript reçoit le transport par injection et lui transmet une limite configurable de 1 à 1 048 576 octets décodés et le délai restant. Le futur adaptateur lit et borne le corps en natif, puis livre une seule séquence d’octets complète et stable, ou un code d’échec sans données partielles. Le client contrôle l’enveloppe, les statuts, la taille livrée, l’UTF-8 et le JSON. Les parcours valident ensuite le contenu métier. [Contrat HTTP mobile](../../development/mobile-application-http.md)

### Compatibilité avec la messagerie

Le plafond de 1 Mio s’applique à chaque réponse décodée d’une opération de cette fondation HTTP. Les historiques et les espaces partagés peuvent être synchronisés par pages, avec reprise fiable après déconnexion. Les pièces jointes chiffrées et autres transferts volumineux relèveront de mécanismes dédiés, par exemple en streaming ou vers un stockage adapté.

Les futurs parcours couvrent les Lettres asynchrones avec historique durable, le Chat instantané avec événements temps réel et les Petits mots éphémères de 24 heures. La conception devra permettre la distribution E2EE vers plusieurs appareils et les accusés de réception et de lecture. La livraison durable et la reprise après déconnexion exigent des garanties propres, indépendantes de la présence d’une connexion temps réel.

Le domaine de messagerie reste indépendant de HTTPS, du client natif et de WebSocket. L’infrastructure pourra choisir un transport adapté à chaque opération et appliquer une politique commune de sécurité et d’autorisation. Les futurs besoins concrets guideront la définition des interfaces.

## Alternatives

Garder le flux consommé par JavaScript impose un protocole de fragments, de contre-pression et d’annulation entre le natif et JavaScript pour ces petits corps. Adapter un corps déjà assemblé à ce flux ajouterait des copies et des états intermédiaires. Un contrat générique commun aux appels JSON et aux transferts volumineux augmenterait la surface à maintenir avant de connaître les besoins des transferts. Le port injecté existant suffit aux appels métier.

## Conséquences

Android et iOS devront prouver l’application de la borne sur les octets décompressés avant le pont, la détection des corps incomplets et l’annulation réelle. La borne par réponse laisse à mesurer les copies natives et JavaScript, le décodage, l’analyse JSON, la concurrence et les files. Une évolution du plafond demande une justification documentée.
