# CRYPTO-010 — Caractérisation des composants de sécurité

**Actualisation du 13 novembre 2026 — état historique :** les affirmations ci-dessous sur les packages et dépendances décrivent CRYPTO-010. `crypto-backup` existe depuis et contient notamment le coffre direct expérimental, qui ne satisfait pas la cible actuelle à deux enveloppes. Voir [le jalon courant](../development/current-milestone.md).

**Statut historique CRYPTO-010 :** résultats expérimentaux Node pour revue ; aucun composant n'est approuvé pour un coffre de production. À ce jalon, aucun package `crypto-backup` ni API de coffre n'avait été créé. Le [format direct V1](recovery-vault-direct-v1.md) demeure expérimental et SEC-CRYPTO-002/003 restent ouverts.

## Périmètre et dépendances

Les dépendances directes suivantes sont installées **uniquement pour les tests** dans `crypto-engine` ; leurs manifests installés ne déclarent pas de dépendance d'exécution :

| Package             | Version exacte | Licence    | Modules et limites                                                                                           |
| ------------------- | -------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `jsonc-parser`      | 3.3.1          | MIT        | UMD et champ ESM ; parseur tolérant orienté JSONC, sa configuration et ses erreurs doivent être contrôlées.  |
| `canonicalize`      | 5.0.0          | Apache-2.0 | ESM, Node ≥ 22 ; dépend de `String.prototype.isWellFormed`, dont la disponibilité Hermes doit être vérifiée. |
| `json-canonicalize` | 3.0.1          | MIT        | Exports ESM/CommonJS ; configuration et validation supplémentaires indispensables.                           |

Les licences et versions ont été vérifiées dans les manifests installés et les sources des projets. Les tests sous Node n'établissent ni la compatibilité Metro/Hermes, ni l'état de sécurité de la chaîne d'approvisionnement, ni la conformité complète JCS. Les dépendances ne sont pas promues en production. [jsonc-parser](https://github.com/microsoft/node-jsonc-parser), [canonicalize](https://github.com/erdtman/canonicalize), [json-canonicalize](https://github.com/snowyu/json-canonicalize.ts).

## Parseur JSON et limites

`jsonc-parser.visit` émet les deux noms décodés pour les doublons simples et les doublons avec échappements ; il ne les refuse pas lui-même. L'appelant peut tenir un ensemble de noms par objet et rejeter les répétitions, les champs inconnus et les nombres de champs excessifs. Avec `disallowComments: true` et `allowTrailingComma: false`, les commentaires, virgules finales et exemples tronqués produisent des événements d'erreur. Le parseur essaie de poursuivre après une erreur : l'appelant doit refuser tout résultat si une erreur est signalée, ou interrompre immédiatement par exception contrôlée.

Les callbacks d'ouverture d'objet permettent de compter la profondeur et de lever une exception avant les objets suivants. Retourner `false` à un callback de début masque les événements d'un sous-arbre, mais ne constitue pas une interruption globale de l'analyse ; l'étude de 3.3.1 montre aussi que la gestion de suppression dépend des callbacks de fin fournis. Ne pas utiliser cette option comme contrôle de sécurité sans test détaillé. Les limites ne sont pas imposées par défaut.

Une chaîne ou un nom est scanné et décodé **avant** le callback qui transmet sa valeur ; un rejet basé sur sa longueur ne prouve donc pas une interruption avant allocation du token. Le parseur reçoit déjà une chaîne JavaScript entière, et son analyse récursive nécessite une borne sur profondeur avant risque de pile ; l'essai démontre une interruption à la profondeur choisie, pas une borne de mémoire générale. Imposer d'abord une limite en octets avant décodage, puis contrôler le nombre de caractères, les champs et la profondeur au fil des événements ; mesurer les allocations sur les cibles et comparer, si nécessaire, un vrai parseur incrémental à allocation bornée. Ne pas interpréter l'essai comme une résistance générale aux dénis de service.

Le parseur accepte un substitut UTF-16 isolé issu d'un échappement JSON ; le contrôle Unicode est distinct. Le décodage UTF-8 fatal de Node rejette l'échantillon malformé. Avec `TextDecoder` Node, le BOM est retiré par défaut ; `ignoreBOM: true` le préserve afin de permettre son rejet. Ces résultats ne prouvent pas le comportement d'un décodeur Hermes. Le schéma V1, la longueur des chaînes, le Base64url, les propriétés inconnues, les doublons et la comparaison avec les octets canoniques doivent être imposés par une couche de validation dédiée, non par le seul parseur.

## Résultats JCS

Les deux candidats produisent les octets attendus de l'exemple [RFC 8785 §3.2.4](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2.4), l'ordre UTF-16 de l'exemple §3.2.3, des exemples numériques finis et l'enveloppe canonique du vecteur CRYPTO-008. Les essais comparent le résultat sérialisé ou les octets, sans réanalyser l'ordre des propriétés numériques JavaScript. Ils montrent aussi qu'un JSON syntaxiquement valide mais non canonique doit être comparé à sa représentation canonique.

Les deux rejettent les valeurs numériques non finies et `BigInt` dans les essais. `canonicalize` rejette un substitut isolé, alors que **`json-canonicalize` 3.0.1 le sérialise** ; ce dernier ne satisfait donc pas seul à l'exigence de refus Unicode JCS. Les deux omettent par défaut certaines propriétés `undefined` ; `json-canonicalize` peut produire du texte `undefined` pour une fonction dans l'objet testé. Son option `canonicalizeEx` avec `strictUndefined` rejette le cas `undefined` testé, mais pas le substitut isolé. Une validation stricte des valeurs d'entrée reste indispensable pour tous les candidats.

**Recommandation provisoire :** examiner `jsonc-parser` avec contrôles explicites et `canonicalize` pour la canonisation, plutôt que `json-canonicalize` seul. Aucun n'est encore approuvé : tests de corpus complet, fuzzing, allocation et profondeur, comportements de chaque option, versions et intégrité, interopérabilité indépendante et essais Hermes sont encore requis. Cette recommandation ne garantit ni conformité générale à RFC 8785 ni résistance à toutes les entrées hostiles.

## Stratégie d'aléa proposée

Un fournisseur d'octets cryptographiques explicite doit être choisi par plateforme et injecté par la composition applicative, avec un contrat d'échec en cas de source absente, d'erreur native ou de configuration non vérifiée. Aucun global ne doit être remplacé automatiquement ; interdire `Math.random`, même en développement. L'interface future doit exiger la longueur exacte, traiter les erreurs sans fuite et n'exposer aucune possibilité de sélectionner un générateur de test dans le parcours de production. Les tests de disponibilité ne prouvent ni la qualité de l'entropie ni le chemin natif effectivement utilisé.

- **Node :** `node:crypto.randomBytes` est le candidat natif documenté ; Noble utilise pour ses helpers l'API globale `crypto.getRandomValues`. Les tests CRYPTO-009 vérifient ses erreurs simulées ; ils ne valident pas un adaptateur de coffre.
- **Expo :** la [documentation SDK 55](https://docs.expo.dev/versions/v55.0.0/sdk/crypto/) décrit `getRandomValues` et `getRandomBytesAsync` comme sources natives, mais indique un repli `Math.random` possible pour `getRandomBytes` synchrone en développement. Exclure ce chemin. Les versions effectives, l'initialisation et tous les modes de débogage doivent être inspectés et testés sur les builds cibles avant approbation.
- **Polyfill React Native :** la [source de branche examinée](https://github.com/LinusU/react-native-get-random-values/blob/master/index.js) comporte un repli `Math.random` dans un mode de débogage Chrome. Elle ne justifie pas d'affirmer que toutes les versions ou tous les chemins le font ; refuser tout chemin non démontré sûr et ne pas l'installer automatiquement.

L'arborescence `apps/mobile` ne contient pas actuellement d'application réutilisable détectée par `rg --files apps` ; aucun prototype n'est créé. Les futurs essais doivent couvrir Expo Development Builds avec Hermes, iOS et Android, démarrage et absence du module natif, débogage local et distant, appels avant initialisation, erreurs natives, vérification des chemins et dépendances, versions épinglées, interopérabilité des vecteurs, mémoire et performance. Ces essais ne remplacent pas une revue de sécurité.

## Frontières et blocages

Le futur `@bunny-talks/crypto-backup` pourrait contenir le coffre générique et ses contrôles de format, avec fournisseurs explicites d'aléa et de cryptographie et sans dépendance OpenE2EE ; la composition de la charge d'identité reste distincte, et le stockage et l'orchestration sont séparés. `crypto-core` reste indépendant des frameworks et du SDK ; `crypto-engine` conserve son adaptation OpenE2EE. Les dépendances exactes, contrats et création du package attendent décision explicite.

Les tests de caractérisation ne sont pas un validateur V1, une API de coffre, un audit ni une preuve de compatibilité mobile. Restent ouverts : sélection et revue des composants, limites avant allocation, UTF-8 et JCS mobile, CSPRNG natif, format, stockage, concurrence et fraîcheur. **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants avant production.**
