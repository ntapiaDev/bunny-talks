---
name: native-qualification
description: Concevoir ou exécuter une qualification native Expo/React Native sur Android ou iOS, notamment HTTPS, Hermes, mémoire, SQLCipher, SecureStore, Argon2id, builds et cycles de vie. Ne pas activer pour du TypeScript pur, un test Node ou une UI sans comportement natif à démontrer.
---

# Qualification native — procédure spécialisée

Ce skill sert à produire une **preuve d'exécution sur une plateforme donnée**, non à répéter les instructions générales de `AGENTS.md`. L'aiguillage documentaire, la préservation des données, les jalons et la restitution générale y sont déjà définis.

## 1. Définir la cible et l'hypothèse

1. Relever la **configuration effectivement exécutée** : plateforme et version OS, appareil ou émulateur, version de l'application installée, moteur JS, debug/release, modules natifs, PID/processus si pertinent. Un fichier source modifié ou un export Metro ne prouve pas quel binaire tourne.
2. Formuler l'observation à expliquer et **au moins une hypothèse alternative plausible**. Choisir le contrôle qui les départage avec le moins de coût et d'effets de bord.
3. Définir une réussite, un échec et un résultat **non concluant** avant l'essai. Préciser si une recompilation/réinstallation native est nécessaire pour tester exactement le changement concerné.

## 2. Adapter les vérifications au sujet

### Transport de secrets et HTTPS

- Tester TLS et validation des noms/certificats, y compris certificat non approuvé et nom incorrect ; pas de contournement `trust all`.
- Pour chaque redirection pertinente (statut, méthode et origine), confirmer **côté destination** qu'aucune requête n'a été suivie ; une exception côté client seule ne suffit pas.
- Observer les cookies et autres identifiants ambiants, la transmission d'en-têtes factices entre hôtes et les éventuelles tentatives automatiques de rejeu.
- Mesurer les octets **décompressés** et les buffers **natifs et JS**, y compris producteur plus rapide que consommateur ; une limite après mise en mémoire n'est pas une borne de transport.
- Vérifier timeout et annulation **effective côté réseau**, ainsi que fermeture prématurée, réponse tronquée, erreurs assainies et comportement en arrière-plan si pertinent.
- Les autorités de certification de test et exceptions de debug ne doivent pas affecter la configuration ni les artefacts release. Contrôler le manifeste/artefact final, pas seulement le fichier de configuration.
- Le certificate pinning n’est **pas une obligation par défaut**. S’il est explicitement retenu, vérifier son application dans le binaire et les comportements de renouvellement/rotation des certificats.

### Mémoire, Hermes et flux

- Séparer allocations JS, allocations natives, copies de réponse et coûts d'instrumentation ; relever tailles, volumes, PID et points de mesure reproductibles.
- Confronter plusieurs hypothèses : références toujours accessibles, collecte différée, cache ou rétention native, fuite durable. Distinguer **objets encore accessibles**, **mémoire réservée par le runtime** et **RSS du processus**. Une survie après une GC ou une RSS stable ne prouve ni fuite ni absence de fuite.
- Préférer une trace ou un contrôle **discriminant** à une répétition à l'identique. Comparer l'état après libération des références et collecte, sans interpréter une seule mesure bruitée comme une preuve définitive.

### Stockage sécurisé, crypto native et cycle de vie

- Tester refus d'une clé erronée, isolation des stores, persistance après **arrêt forcé**, réouverture et reprise avec le même état de données ; distinguer verrouillage logique et destruction physique.
- Pour SQLCipher, SecureStore et Argon2id, vérifier le **backend et la configuration effectivement intégrés au binaire**, ainsi que le comportement exécuté (stockage, profil KDF, durée et mémoire) ; ne pas extrapoler des vecteurs Node ou d’une API JS.
- Selon la propriété visée, étendre la qualification au cycle de vie : fermeture forcée, déconnexion/reconnexion, réinstallation ou restauration système sur **environnement jetable et contrôlé**. Ne pas supposer les mêmes comportements entre Android et iOS.
- Pour tout changement de configuration ou de module natif, distinguer code modifié, build compilé, build déployé et fonctionnalité effectivement observée.

## 3. Décision d'essai et portée de la conclusion

- Arrêter la campagne lorsque le test a répondu à la question, lorsque des répétitions ne sont plus discriminantes, ou si l'isolation de l'environnement n'est pas assurée. Proposer la **mesure minimale supplémentaire** en cas d'incertitude.
- Formuler une qualification **scénario × plateforme × appareil × mode de build × version**, avec ses exclusions explicites. Android émulateur debug ne qualifie ni iOS, ni appareil physique, ni release, ni production.
- Si le scénario porte sur la justesse du protocole, employer `crypto-engineering` en complément ; ne pas dupliquer son audit cryptographique ici.
- Pour une qualification native significative, conserver un rapport **reproductible** précisant plateforme/appareil/OS, version et mode du build, préconditions, procédure, observations, résultat et limites. Employer uniquement des données et artefacts assainis.
