# ADR-004 — Réponses bornées de l’API métier mobile

**Statut** — accepté en 4.5B2C1.

La clôture de l’expérimentation URLSession retient l’architecture cible. L’intégration, l’ouverture du verrou iOS, l’usage métier et la mise en production relèvent de décisions distinctes. [Clôture et feuille de route](../../development/native-https-foundation.md#architecture-retenue)

## Contexte

La fondation 4.5B2A lit des fragments via un transport injecté. Les routes d’inscription, de connexion, de session et d’amorçage renvoient de petits résultats JSON ou un 204 vide. Le prototype Android 4.5B2B a expérimenté la livraison d’un corps entier après contrôle de taille natif. Il a aussi mis en évidence plusieurs copies et une occupation mémoire qui dépend de la concurrence. [Clôture de l’expérimentation](../../development/native-https-foundation.md#mémoire-android-et-transport-historique)

## Décision

Le port reste dans l’infrastructure HTTP de l’application mobile. Le client TypeScript reçoit le transport par injection et lui transmet une limite configurable de 1 à 1 048 576 octets décodés et le délai restant. Le futur adaptateur lit et borne le corps en natif, puis livre une seule séquence d’octets complète et stable, ou un code d’échec sans données partielles. Le client contrôle l’enveloppe, les statuts, la taille livrée, l’UTF-8 et le JSON. Les parcours valident ensuite le contenu métier. [Contrat HTTP mobile](../../development/mobile-application-http.md)

Le transport utilise l’origine HTTPS approuvée et la validation TLS de la chaîne et du nom d’hôte. Il refuse les redirections avant suivi et isole les comptes, les Bearers explicites, les cookies, les identifiants ambiants et le cache. Le délai total inclut la réservation, l’envoi, la lecture et la remise du résultat. Une expiration ou une annulation arrête le travail natif de la tâche. Chaque opération rend un seul résultat terminal, avec une réponse complète ou une erreur assainie.

Les petits JSON métier peuvent emprunter un profil sans compression avec `Accept-Encoding: identity` et des réponses standard sans `Content-Encoding`. Le profil doit pouvoir refuser les codages inattendus et les réponses incomplètes ou de cadrage ambigu. Les mécanismes de la pile native et les preuves de comportement suffisent lorsque les API publiques exposent ce qui est nécessaire. La visibilité des champs HTTP bruts, gzip, le champ de réponse `Content-Encoding: identity`, la connexion dédiée à l’appel et un protocole HTTP identique sont des choix de profil. Une session ou un client dédié et réutilisable est admis si l’isolation et l’annulation par tâche sont démontrées.

### Transports retenus et profil à longueur connue

La cible utilise URLSession sur iOS et OkHttp sur Android derrière le port TypeScript injecté existant. Les deux plateformes partagent autant que possible la fixture, la matrice, l’oracle de qualification et les parcours métier. L’API conserve la sérialisation standard de NestJS/Express sans surcouche. [Contrat mobile](../../development/mobile-application-http.md) · [Mesures sur l’API](../../development/native-https-foundation.md#qualification-et-preuves-acceptées)

Chaque réponse JSON avec corps annonce un unique `Content-Length` décimal exact, sans `Content-Encoding` ni `Transfer-Encoding`. Un 204 vide ne porte aucun de ces champs. Le natif rejette les incompatibilités visibles, refuse une longueur déclarée supérieure à la borne et livre le corps uniquement après achèvement confirmé et concordance du nombre d’octets. Les garde-fous TLS, de reprise, d’isolation et d’annulation restent applicables. Des témoins adverses vérifient le comportement face aux cadrages masqués par la pile. [RFC 9110 § 8.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6)

Le profil réduit la surface à qualifier en écartant la décompression et les cadrages multiples pour les petits JSON. Foundation apporte la confiance et les mises à jour système sur Apple. Android conserve OkHttp et Okio déjà présents. Cette répartition limite le coût de maintenance d’une pile embarquée et garde les parcours indépendants des bibliothèques natives et du framework serveur. Elle demande une veille sur les changements de comportement d’iOS et sur les versions Android effectivement résolues. Les connexions réutilisables peuvent réduire la latence à chaud, les négociations TLS et les réveils réseau. La faible consommation énergétique est un objectif à mesurer avec les coûts au repos, la mémoire et les performances sur appareil. [Protocole de mesure](../../development/native-https-foundation.md#limites-et-conservation)

Express peut fournir ces réponses par ses mécanismes usuels. Le dernier intermédiaire TLS contrôlé doit conserver la longueur exacte, désactiver la compression de ce profil et servir les erreurs avec corps sous le même contrat. S’il a déjà émis les en-têtes et ne peut plus finir la réponse, il doit interrompre l’échange ou le flux. Les en-têtes et la complétude devront être vérifiés de bout en bout sur chaque protocole déployé.

### Reprises transparentes des GET autorisés

La politique évaluée sur la candidate URLSession couvre les GET explicitement autorisés, dont `GET /v1/session`. Un profil natif qualifié peut reprendre après une erreur réseau ou de cadrage tant qu’aucune réponse exploitable n’a été livrée. La reprise reste dans l’opération initiale, pour la même origine, le même chemin et le même Bearer, avec l’échéance initiale et le même signal d’annulation. Chaque réponse invalide doit rester refusée. Toute issue terminale, expiration ou annulation met fin à l’opération. Le client applicatif conserve `retry: 'never'` et les reprises différées ainsi que les tâches d’entretien restent exclues.

Le nombre de réceptions GET sert au diagnostic et aux mesures de performance. Android peut conserver l’émission unique. L’expiration absolue et la révocation restent applicables. La mise à jour éventuelle de `lastSeenAt` est admise dans cette fenêtre. Toute extension à d’autres opérations demande une décision sur leur sémantique. Les POST sensibles et DELETE conservent leurs obligations existantes. L’application métier de cette politique reste soumise aux qualifications et à une décision humaine. [Conditions par opération](../../development/mobile-application-http.md) · [Quatrième run et critères de preuve](../../development/native-https-foundation.md#qualification-et-preuves-acceptées)

### Compatibilité avec la messagerie

Le plafond de 1 Mio s’applique à chaque réponse décodée d’une opération de cette fondation HTTP. Les historiques et les espaces partagés peuvent être synchronisés par pages dimensionnées en octets JSON UTF-8, avec reprise fiable après déconnexion. Les reçus et résultats d’amorçage du coffre sont de petites réponses. Une future lecture du coffre devra vérifier son budget de réponse, encodage compris. Les pièces jointes chiffrées et autres transferts volumineux relèveront de mécanismes dédiés, par exemple en streaming ou vers un stockage adapté.

Les futurs parcours couvrent les Lettres asynchrones avec historique durable, le Chat instantané avec événements temps réel et les Petits mots éphémères de 24 heures. La conception devra permettre la distribution E2EE vers plusieurs appareils et les accusés de réception et de lecture. La livraison durable et la reprise après déconnexion exigent des garanties propres, indépendantes de la présence d’une connexion temps réel.

Le domaine de messagerie reste indépendant de HTTPS, du client natif et de WebSocket. L’infrastructure pourra choisir un transport adapté à chaque opération et appliquer une politique commune de sécurité et d’autorisation. Les futurs besoins concrets guideront la définition des interfaces.

## Alternatives

Le choix de Foundation renonce au contrôle fin des émissions par le garde C de libcurl, à la visibilité de ses champs HTTP et à la maîtrise de la version du moteur réseau embarqué. Le profil commun renonce à servir des réponses gzip et des réponses HTTP/1.1 à découpage `chunked`, deux possibilités qu’offrait la pile libcurl. Les règles par opération et les observations côté serveur restent nécessaires pour traiter les reprises et les issues incertaines. [Preuves de l’expérience historique](../../development/https-archive-index.md)

Garder le flux consommé par JavaScript impose un protocole de fragments, de contre-pression et d’annulation entre le natif et JavaScript pour ces petits corps. Adapter un corps déjà assemblé à ce flux ajouterait des copies et des états intermédiaires. Un contrat générique commun aux appels JSON et aux transferts volumineux augmenterait la surface à maintenir avant de connaître les besoins des transferts. Le port injecté existant suffit aux appels métier.

## Conséquences

Android et iOS devront prouver l’application de la borne sur les octets décodés avant le pont, la détection des corps incomplets et l’annulation réelle. La borne par réponse laisse à mesurer les copies natives et JavaScript, le décodage, l’analyse JSON, la concurrence et les files. Une évolution du plafond demande une justification documentée. [Préparation de la qualification](../../development/native-https-foundation.md#procédures-maintenues)
