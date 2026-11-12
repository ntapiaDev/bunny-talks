# ADR-003 — Évaluation d'OpenE2EE 14.4.0

**Statut :** en évaluation ; aucun choix de production définitif.

## Contexte

Le projet examine les capacités du SDK pour le modèle multi-appareils et la récupération.

## Proposition

Isoler OpenE2EE 14.4.0 dans `crypto-engine` et vérifier ses API publiques, son comportement et sa compatibilité mobile avant toute décision de production.

## Alternatives

D'autres bibliothèques, notamment libsignal, restent candidates ; choisir maintenant sans intégration ni audit suffisant serait prématuré.

## Conséquences

Les essais doivent rester réutilisables et couvrir les pannes. La cohérence d'une paire de clés ne prouve pas l'authenticité de sa provenance. Les divergences de bornes de registration ID et la compatibilité native restent à résoudre.

L'examen de CRYPTO-002 ne démontre pas d'import conditionnel atomique avec les API publiques `IdentityKeyStore`. La préparation d'une identité ne constitue pas un import, et le comportement des stores SQLite et clé-valeur pour l'identifiant local doit être testé séparément.

## Import concurrent : options étudiées

Aucune solution de production n'est encore retenue pour SEC-CRYPTO-002 : le contrat public du store SDK ne permet pas de composer la vérification d'absence et `storeIdentityKey` dans une même transaction. Trois pistes restent à évaluer :

- **A — SQLite contrôlé par Bunny Talks.** Une création conditionnelle et l'écriture de l'identité avec son registration ID pourraient partager une transaction durable, avec contrainte d'unicité entre processus. Les stores SQLite du SDK n'exposent toutefois ni leur transaction ni leur schéma comme contrat public ; les manipuler directement serait fragile. Une implémentation de store compatible et une intégration SQLCipher Node et Expo seraient à construire et à tester. Tous les écrivains devraient l'utiliser.
- **B — Store provisoire puis publication exclusive.** Les API SDK permettent d'ouvrir un store sous un nom distinct ; l'identité et son registration ID y bénéficient de la transaction SQLite propre au SDK. Elles ne fournissent pas de publication atomique interprocessus d'un store avec son entrée de coffre. Un registre applicatif durable avec création conditionnelle, des noms uniques et une procédure de reprise seraient nécessaires. Il faudrait traiter les fichiers SQLite et leurs journaux, la clé du coffre, les ressources orphelines et les accès simultanés. Les garanties Expo et l'empêchement des écritures hors coordination restent à démontrer.
- **C — Adaptateur conforme aux interfaces publiques.** Un store ou adaptateur applicatif pourrait centraliser l'identité et proposer une création conditionnelle dans un backend transactionnel. Un simple verrou JavaScript ne protège ni les autres processus ni les écritures directes au store sous-jacent. La délégation des autres méthodes du SDK, les opérations composées et les exigences de conformité doivent être démontrées ; le backend clé-valeur public dispose d'un `atomicWrite` conditionnel, mais le store SDK existant ne compose pas les deux écritures d'identité et de registration ID dans cette opération publique. Le kit de conformité du SDK aide à tester un store personnalisé sans couvrir tous les comportements.

Une création conditionnelle doit refuser ou traiter explicitement l'identité déjà présente et coordonner tous les écrivains ; sa résistance aux interruptions et sa compatibilité mobile exigent des tests réels. Un chiffrement de base, une transaction SQLite et une exclusion entre processus sont trois garanties distinctes. Privilégier l'étude d'une primitive publique fournie par OpenE2EE ; si elle n'est pas disponible, comparer les autres options et leurs garanties avant toute décision d'architecture, sans présumer qu'un adaptateur complet est nécessaire.

## Périmètre clarifié de CRYPTO-002

Pour une initialisation vierge ou une récupération explicite, `importIdentity` refuse toute identité déjà détectée, écrit dans un store SQLite public puis vérifie la relecture. La connexion classique ne doit pas réimporter l'identité. Cette protection contre un remplacement accidentel n'est pas une création conditionnelle atomique : seuls les appels à cette fonction partageant la même instance sont sérialisés localement. Le contrôle des autres écrivains, la reprise après panne et l'authentification restent nécessaires avant la production. La comparaison des trois approches ci-dessus reste pertinente pour ces garanties supplémentaires.

CRYPTO-002 démontre un import et une persistance après réouverture avec SQLCipher sous Node dans les conditions des tests. Il ne valide ni le modèle multi-appareils ni les parcours complets d'association et de récupération.

## SEC-CRYPTO-002 — Garantie obligatoire avant production

**Statut : ouvert ; bloquant avant toute association ou récupération d'appareil en production.** La démonstration technique CRYPTO-002 ne valide pas cette exigence.

Avant utilisation en production, démontrer :

1. La création conditionnelle atomique de l'identité et de son identifiant local, ou un mécanisme équivalent dont les garanties sont établies.
2. La protection contre les remplacements silencieux par tous les chemins d'écriture pertinents, y compris entre instances et processus.
3. Une reprise sûre après panne ou interruption, y compris lorsqu'une écriture a pu réussir avant qu'une erreur soit signalée.
4. Des tests de concurrence et d'intégration sur les backends réellement utilisés.
5. Une gestion cohérente des états partiellement initialisés.

Étudier en priorité l'obtention d'une primitive publique adaptée dans OpenE2EE. Si elle n'est pas disponible, conserver l'option d'un adaptateur transactionnel conforme aux interfaces publiques ; sa réalisation exige une décision d'architecture supplémentaire.
