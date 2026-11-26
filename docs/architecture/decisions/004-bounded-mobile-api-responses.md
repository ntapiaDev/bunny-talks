# ADR-004 — Réponses bornées de l’API métier mobile

**Statut** — accepté en 4.5B2C1.

La révision de préparation du profil JSON métier fixe les exigences communes ci-dessous. Le choix du transport iOS dépend encore de la qualification native et d’une revue humaine.

## Contexte

La fondation 4.5B2A lit des fragments via un transport injecté. Les routes d’inscription, de connexion, de session et d’amorçage renvoient de petits résultats JSON ou un 204 vide. Le prototype Android 4.5B2B a expérimenté la livraison d’un corps entier après contrôle de taille natif. Il a aussi mis en évidence plusieurs copies et une occupation mémoire qui dépend de la concurrence. [Clôture de l’expérimentation](../../development/native-https-transport-evaluation.md)

## Décision

Le port reste dans l’infrastructure HTTP de l’application mobile. Le client TypeScript reçoit le transport par injection et lui transmet une limite configurable de 1 à 1 048 576 octets décodés et le délai restant. Le futur adaptateur lit et borne le corps en natif, puis livre une seule séquence d’octets complète et stable, ou un code d’échec sans données partielles. Le client contrôle l’enveloppe, les statuts, la taille livrée, l’UTF-8 et le JSON. Les parcours valident ensuite le contenu métier. [Contrat HTTP mobile](../../development/mobile-application-http.md)

Le transport utilise l’origine HTTPS approuvée et la validation TLS de la chaîne et du nom d’hôte. Il refuse les redirections avant suivi et isole les comptes, les Bearers explicites, les cookies, les identifiants ambiants et le cache. Le délai total inclut la réservation, l’envoi, la lecture et la remise du résultat. Une expiration ou une annulation arrête le travail natif de la tâche. Chaque opération rend un seul résultat terminal, avec une réponse complète ou une erreur assainie.

Les petits JSON métier peuvent emprunter un profil sans compression avec `Accept-Encoding: identity` et des réponses standard sans `Content-Encoding`. Le profil doit pouvoir refuser les codages inattendus et les réponses incomplètes ou de cadrage ambigu. Les mécanismes de la pile native et les preuves de comportement suffisent lorsque les API publiques exposent ce qui est nécessaire. La visibilité des champs HTTP bruts, gzip, le champ de réponse `Content-Encoding: identity`, la connexion dédiée à l’appel et un protocole HTTP identique sont des choix de profil. Une session ou un client dédié et réutilisable est admis si l’isolation et l’annulation par tâche sont démontrées.

Le client applicatif ne rejoue aucun appel. Après perte de connexion, le profil natif peut reprendre `GET /v1/session` au sein de la même opération, pour la même origine et le même Bearer, sous l’échéance initiale et avec le même signal d’annulation. Cette autorisation exclut toute reprise différée et toute tâche d’entretien de session. L’expiration absolue et la révocation restent applicables. Le nombre de réceptions est une observation diagnostique et de performance. La mise à jour éventuelle de `lastSeenAt` est admise dans cette fenêtre. Les opérations sensibles conservent leurs garanties propres. Une perte de réponse du login n’autorise aucune réémission susceptible de produire une deuxième connexion. Les autres changements de sémantique de reprise passent en revue. [Conditions par opération](../../development/mobile-application-http.md)

### Compatibilité avec la messagerie

Le plafond de 1 Mio s’applique à chaque réponse décodée d’une opération de cette fondation HTTP. Les historiques et les espaces partagés peuvent être synchronisés par pages, avec reprise fiable après déconnexion. Les pièces jointes chiffrées et autres transferts volumineux relèveront de mécanismes dédiés, par exemple en streaming ou vers un stockage adapté.

Les futurs parcours couvrent les Lettres asynchrones avec historique durable, le Chat instantané avec événements temps réel et les Petits mots éphémères de 24 heures. La conception devra permettre la distribution E2EE vers plusieurs appareils et les accusés de réception et de lecture. La livraison durable et la reprise après déconnexion exigent des garanties propres, indépendantes de la présence d’une connexion temps réel.

Le domaine de messagerie reste indépendant de HTTPS, du client natif et de WebSocket. L’infrastructure pourra choisir un transport adapté à chaque opération et appliquer une politique commune de sécurité et d’autorisation. Les futurs besoins concrets guideront la définition des interfaces.

## Alternatives

Garder le flux consommé par JavaScript impose un protocole de fragments, de contre-pression et d’annulation entre le natif et JavaScript pour ces petits corps. Adapter un corps déjà assemblé à ce flux ajouterait des copies et des états intermédiaires. Un contrat générique commun aux appels JSON et aux transferts volumineux augmenterait la surface à maintenir avant de connaître les besoins des transferts. Le port injecté existant suffit aux appels métier.

## Conséquences

Android et iOS devront prouver l’application de la borne sur les octets décodés avant le pont, la détection des corps incomplets et l’annulation réelle. La borne par réponse laisse à mesurer les copies natives et JavaScript, le décodage, l’analyse JSON, la concurrence et les files. Une évolution du plafond demande une justification documentée. [Préparation de la qualification](../../development/native-https-foundation.md#préparation-du-profil-json-urlsession-et-okhttp)
