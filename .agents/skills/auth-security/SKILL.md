---
name: auth-security
description: Concevoir, implémenter ou auditer les transitions d'authentification et d'autorisation serveur de Bunny Talks (inscription, mots de passe, sessions, réauthentification, appareils). Ne pas activer pour une route métier ordinaire ou la seule cryptographie E2EE.
---

# Auth security — procédure ciblée

Ce skill porte sur la question : **qui est autorisé à effectuer quelle transition de compte, dans quel état, avec quelle preuve et quel effet serveur ?** Il ne valide ni les propriétés du protocole E2EE ni le comportement d'un transport mobile natif. Les règles générales et l'aiguillage documentaire relèvent d'`AGENTS.md`.

## 1. Fixer les acteurs et les autorités

1. Définir la demande, l'acteur (anonyme, compte authentifié, appareil en attente/autorisé/révoqué, administrateur), les états initiaux et le résultat attendu.
2. Séparer explicitement **possession d'une session**, **identité du compte**, **preuve de réauthentification**, **autorisation de l'appareil** et **droit à l'opération**. Aucun de ces éléments n'implique automatiquement les autres.
3. Identifier ce que chaque preuve permet, sa durée de vie, son périmètre, sa consommation éventuelle et la source de vérité serveur. Une adresse e-mail vérifiée ne suffit pas à autoriser un appareil E2EE.
4. Tracer les frontières pertinentes : requête HTTP, guard/contrôleur, service applicatif, opération transactionnelle, base, e-mail et stockage de session.

## 2. Construire la transition sûre

- **Refus par défaut** : validation stricte des entrées, autorisation à chaque opération sensible, séparation entre comptes et absence d'accès à des ressources privilégiées via un simple identifiant fourni par le client.
- **Sessions** : examiner création, expiration, invalidation, réutilisation d'un jeton révoqué et portée de la déconnexion ; ne pas déduire une révocation générale d'une révocation de session courante. Vérifier la prévention de la fixation de session et la rotation uniquement selon le mécanisme effectivement utilisé.
- **Identifiants et preuves temporaires** : pour les mécanismes concernés, vérifier le stockage des vérificateurs de mots de passe avec le KDF retenu, l'aléa et le stockage des jetons, leur liaison au compte/à l'opération, leur expiration, leur consommation atomique et le refus de leur réutilisation. Les jetons de renouvellement éventuels demandent une analyse propre ; ne pas en introduire par principe.
- **Sessions web, si applicables** : si des cookies sont utilisés, vérifier les attributs `Secure`, `HttpOnly`, `SameSite` et les protections CSRF adaptées ; ne pas imposer cette architecture à l'application mobile.
- **Inscription et récupération** : distinguer intention, preuve e-mail, changement d'identifiants et création d'une session ou d'une autorisation ; ne pas considérer une étape préparatoire comme un parcours terminé.
- **Actions sensibles** : établir une réauthentification suffisamment récente et liée à l'opération, à son compte et à sa version/état lorsque nécessaire. Refuser l'utilisation d'une preuve périmée ou destinée à une autre action.
- **États d'appareils** : différencier appareil détecté, en attente, autorisé et révoqué ; empêcher qu'une connexion ou une simple publication cryptographique élève implicitement les droits.
- **Concurrence et fiabilité** : traiter les requêtes simultanées, reçus/idempotence, expiration pendant l'opération, réponses perdues et issue inconnue. Garantir les transitions atomiques nécessaires et ne pas relancer aveuglément une mutation ambiguë.
- **Anti-abus et confidentialité** : vérifier limites de tentative et de ressources, résistance à l'énumération, erreurs assainies et absence d'exposition des jetons, preuves et mots de passe. Éviter de considérer un rate limit comme une garantie d'autorisation.
- **Auditabilité proportionnée** : pour une transition sensible, déterminer si un événement d'audit durable est nécessaire et quelles informations minimales permettraient d'identifier l'acteur, le compte concerné, l'action et son résultat. Distinguer trace de sécurité et log technique, sans exposer de secrets ni créer une infrastructure de journalisation hors périmètre.

## 3. Produire des preuves adaptées

Définir les cas à partir des transitions réellement concernées, plutôt que recopier une suite de tests générique :

- **Nominal** : acteur et preuve valides, état serveur attendu, réponse conforme.
- **Refus** : acteur anonyme, autre compte/appareil, preuve expirée, réutilisée, incorrecte ou révoquée ; absence d'effet privilégié et de fuite d'information.
- **Concurrence** : double requête, course avec révocation, changements d'état simultanés, unicité des résultats et absence de demi-transition durable.
- **Résultat incertain** : coupure/timeout après possible commit, réponse perdue, rejeu ; vérifier les reçus ou mécanismes de reprise existants plutôt que supposer un rollback.
- **Persistance** : l'état d'autorisation doit survivre à la recréation du service/connexion lorsque c'est une garantie recherchée.

Adapter les essais au niveau de preuve nécessaire : logique pure, HTTP/guard, transaction PostgreSQL réelle ou intégration. Un mock seul ne démontre ni les contraintes SQL ni l'atomicité du commit.

## 4. Frontières avec les autres skills

- Associer `crypto-engineering` lorsque la mission touche à l'identité cryptographique, aux clés, à la confiance E2EE des appareils ou au coffre. **Autorisation serveur et confiance cryptographique sont distinctes** : une autorisation serveur ne prouve pas une transition E2EE sûre, et la possession de clés E2EE ne confère pas une permission serveur. Le modèle conserve une identité cryptographique de compte commune, avec des états et sessions propres aux appareils.
- Associer `native-qualification` seulement si la mission doit démontrer, sur Android/iOS, la sécurité du transport, le stockage des jetons ou une autre propriété native.
- Associer `architecture-boundaries` seulement si la mission crée ou modifie une frontière architecturale significative ; ne pas le déclencher pour chaque contrôleur.

## 5. Critère de fin spécialisé

Pour les transitions concernées, la conclusion doit répondre : **qui peut agir, sur quelle preuve, à quel moment, avec quel effet durable, et quel refus est démontré ?** Classer comme non démontrées les garanties simplement inférées d'une API, d'un guard, d'un mock ou d'une réponse HTTP nominale.
