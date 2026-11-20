---
name: crypto-engineering
description: Auditer, concevoir, implémenter ou qualifier une propriété de chiffrement E2EE, d'OpenE2EE, d'identité cryptographique, de gestion des appareils, de coffre ou de récupération Bunny Talks. Ne pas activer pour un changement HTTP, Prisma ou UI sans impact sur une propriété cryptographique.
---

# Crypto engineering — procédure spécialisée

Choisir **une seule voie principale** ci-dessous selon la mission ; n'exécuter les autres vérifications que si elles sont nécessaires. L'aiguillage vers la documentation, les règles permanentes, les jalons et le format général du compte rendu relèvent d'`AGENTS.md`.

## 1. Définir la propriété à établir

- Exprimer l'invariant en termes vérifiables : acteur autorisé/interdit, état initial, opération, résultat attendu, comportement en cas d'échec.
- Identifier les frontières de confiance traversées (appareil, SDK, stockage, serveur, relais, coffre). Distinguer la preuve d'identité cryptographique de l'authentification du compte et de l'autorisation serveur.
- Préciser si l'objectif est une **étude d'API**, une **implémentation**, ou une **qualification de sécurité**. Ne pas faire d'un modèle de données ou d'une API disponible une garantie de sécurité implicite.

## 2A. Si la mission évalue le SDK ou une dépendance cryptographique

1. Relever la **version effectivement installée**, son entrée utilisée par la plateforme, ses déclarations TypeScript, sa surface publique et les comportements déterminants dans le code de **cette version**.
2. Examiner **seulement les API publiques critiques pour la propriété étudiée** : préconditions, postconditions, erreurs et, si pertinents, persistance, fanout, révocation et reprise. Étendre l’analyse à d’autres API uniquement si une dépendance technique le justifie. Distinguer contrat documenté, code inspecté et observation exécutée.
3. Lorsque la tâche le nécessite, examiner changement de format/API, migration, maintenance, provenance, licence et avis de sécurité de la version exacte. Ne pas présumer une compatibilité Signal ou une fonction simplement parce que son nom est similaire.
4. Pour toute capacité absente ou ambiguë, proposer un test falsifiable ou une adaptation isolée ; ne pas recourir aux détails internes fragiles comme contrat de production.
5. Si l’étude doit éclairer une **décision sur le SDK**, restituer synthétiquement : capacité attendue, API/version examinée, preuve documentaire/source/exécutée, limites et verdict d’usage (**utilisable dans ce périmètre / adaptation nécessaire / non utilisable / indéterminé**). Ne pas imposer un tableau complet pour une vérification ponctuelle.

## 2B. Si la mission implémente un comportement E2EE

1. Décrire le cycle de vie concerné : création, déverrouillage, usage, persistance, changement, révocation, récupération ou destruction logique.
2. Définir les invariants d'état et de transition, notamment lors d'une réponse perdue, d'un rejeu, d'une concurrence ou d'un commit partiel. Identifier qui peut authentifier une transition, et qui ne le peut pas.
3. Vérifier les frontières d'import/export et de sérialisation : identité commune du compte versus enregistrement et sessions **propres aux appareils** ; données publiques versus secrets ; contenu chiffré versus métadonnées.
4. Pour le coffre, traiter distinctement l'enveloppe mot de passe, l'enveloppe clé de récupération, les révisions, l'intégrité du manifeste et les opérations de réenveloppement. Une voie de récupération ne prouve pas l'autre.
5. Prévoir les refus et les régressions avant de généraliser le parcours nominal. Préserver la compatibilité et la possibilité de récupération des données déjà émises.

## 2C. Si la mission qualifie une propriété de sécurité

Construire une mini-matrice **scénario → invariant → observation attendue → preuve obtenue → limite**, limitée à la propriété visée. Sélectionner les cas discriminants parmi :

- **Identité** : substitution de clé/identité, épingle obsolète, import dans un store SDK vide, appareils partageant l'identité du compte sans partager leur état de session.
- **Multi-appareils** : distribution partielle, appareil hors ligne, renvoi tardif après révocation, ancien paquet déjà reçu, nouvelle autorisation, rejeu et concurrence. Ne pas promettre l'effacement de données déjà déchiffrées.
- **Coffre/récupération** : mauvais mot de passe ou secret de secours, perte de tous les appareils, rotation et réenveloppement, blob modifié ou tronqué, manifeste falsifié, version ancienne rejouée, échec intermédiaire.
- **Stockage et historique** : restauration après fermeture forcée, isolation des stores, migration de formats/sessions, archives accessibles uniquement aux appareils autorisés.

Un test qui démontre la réussite du chemin nominal ne démontre pas le rejet d'un adversaire. Un succès Node ne qualifie pas un runtime natif : associer `native-qualification` uniquement lorsqu'une propriété de plateforme doit aussi être prouvée.

## 3. Critère de fin spécialisé

Conclure, pour **chaque invariant étudié**, par l’un des états : **démontré dans le périmètre testé**, **réfuté**, **indéterminé** ou **non testé**. Associer les preuves à leur version, environnement, préconditions et observations réellement collectées. Indiquer quelle observation manque pour lever une incertitude importante ; l’absence d’anomalie observée n’est pas une garantie universelle.
