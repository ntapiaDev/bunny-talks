# Jalon CRYPTO-003 — Évaluation du transfert d'identité

**Statut :** caractérisation expérimentale en revue ; association sécurisée non validée.

## Objectif

Évaluer les API publiques de transfert d'OpenE2EE 14.4.0 sans construire de protocole d'association ni d'interface mobile. L'identité durable est partagée entre appareils autorisés ; les sessions, préclés et identifiants d'enregistrement restent propres à chaque appareil.

## Résultats observés

Le test de caractérisation utilise deux stores SQLCipher Node et des clés générées à l'exécution. Il vérifie le transfert chiffré des deux paires d'identité, leur import expérimental avec un nouvel identifiant, l'absence de copie des préclés et sessions, et le rejet d'une altération du ciphertext ou d'une mauvaise clé. Ce test ne démontre ni un échange authentifié ni la sûreté du protocole complet.

Le même QR est accepté plusieurs fois dans sa fenêtre et un même paquet peut être déchiffré plusieurs fois. Un tiers connaissant le QR public peut générer sa propre paire éphémère et construire un bundle que le destinataire peut déchiffrer avec la clé publique de ce tiers : les primitives testées n'authentifient pas l'ancien appareil. Les métadonnées extérieures du bundle chiffré ne sont pas vérifiées par `decryptBackup`. Ces tests caractérisent les primitives ; ils ne prouvent pas que toutes les intégrations possibles sont vulnérables.

Le déchiffrement répété démontre uniquement que `decryptBackup` ne maintient pas d'état anti-rejeu ; il ne démontre pas l'acceptation répétée d'une autorisation ou l'enregistrement d'un appareil, qui ne sont pas testés. Le SDK dérive avec HKDF une `authenticationKey` distincte de l'`encryptionKey` et la retourne à l'appelant. Aucun usage de cette clé dans une opération publique de transfert, ni protocole de messages de contrôle associé, n'a été trouvé dans la version distribuée. Sa dérivation seule n'authentifie pas les appareils ni les messages ; AES-GCM assure l'intégrité de la charge chiffrée via l'`encryptionKey`, tandis que l'application reste responsable de l'authentification, des autorisations, du contexte et de l'anti-rejeu.

`createDeviceBackup` recopie l'objet renvoyé par l'adaptateur. Si celui-ci retourne l'identité SDK complète, le registration ID source est également exporté et `validateBackup` l'accepte dans l'objet d'identité. L'adaptateur de test sélectionne explicitement les deux paires ; un futur export devra faire de même et vérifier les champs transmis.

## Exigences ouvertes avant production

- **SEC-CRYPTO-002 reste ouvert et bloquant** : création conditionnelle ou équivalent, protection de tous les chemins d'écriture, reprise après panne, états partiels et tests sur les backends réels.
- **SEC-CRYPTO-003 — transfert et autorisation : ouvert et bloquant.** Définir et valider un parcours qui authentifie et lie les deux appareils et leur compte à la même tentative, protège l'intégrité du contexte, vérifie l'autorisation explicite et la limite d'appareils, empêche les substitutions et rejeux, impose une expiration et assure l'annulation et la reprise sûres. Tester également le relais hostile, les interruptions, les erreurs d'horloge et la révocation. Aucun mécanisme propre n'est retenu à ce stade.
- L'identité cohérente ne prouve ni son origine ni l'autorisation de l'appareil. Un coffre de récupération indépendant et l'archive chiffrée restent distincts du transfert entre appareils.
- Le nettoyage des secrets en mémoire JavaScript est limité ; les chaînes et copies ne peuvent pas être effacées de façon garantie. Les intégrations Expo, SQLCipher et coffre natif restent à tester sur appareils.

## Suite recommandée

Examiner d'abord les garanties publiques d'une solution d'association authentifiée et soumettre sa conception et son modèle de menace à revue avant toute intégration. Ne pas utiliser directement les primitives caractérisées comme parcours de production.
