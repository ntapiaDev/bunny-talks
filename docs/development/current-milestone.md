# Jalon CRYPTO-002 — Import contrôlé d'identité

**Statut :** démonstration technique CRYPTO-002 réalisée pour revue ; non validée pour la production. SEC-CRYPTO-002 reste ouvert et bloque toute association ou récupération en production.

## Objectif et comportement

L'import est réservé à l'initialisation d'un appareil vierge ou à une récupération explicite ; la connexion classique ne doit pas l'appeler. `importIdentity` valide une copie de l'identité, refuse un store ACI déjà initialisé, écrit via le store SQLite public du SDK puis relit et vérifie les deux paires et l'identifiant local. Tout import répété est refusé, même pour la même identité. Il ne génère pas d'identité et ne modifie pas les sessions ni les préclés.

Le type d'entrée limite l'opération aux stores SQLite Node, Expo et React Native du SDK. Les stores mémoire et clé-valeur examinés ne mettent pas nécessairement à jour l'identifiant local lors de `storeIdentityKey` ; ils ne sont pas pris en charge par cette opération.

## Garanties testées

Sur deux bases SQLCipher Node indépendantes : import vierge, rejet d'une identité invalide, refus des réimports et d'une identité différente, sérialisation de deux appels concurrents sur la même instance, conservation d'une préclé, réouverture et vérification des deux paires et de l'identifiant. Les clés des bases sont distinctes dans un même coffre de test ; une mauvaise clé ne rouvre pas la base. Le coffre de test est en mémoire et ne démontre pas la persistance d'un coffre natif.

## Limites de sécurité

- Le contrôle d'absence et l'écriture ne forment pas une transaction atomique. La sérialisation locale ne coordonne que les appels `importIdentity` partageant la même instance de store dans le même contexte JavaScript ; elle ne protège pas des autres processus, instances ou écritures SDK directes. L'appelant doit exclure tous les autres écrivains pendant l'import.
- Les contrôles publics d'existence ne garantissent pas la détection de tous les états de base partiellement corrompus. Une base corrompue ou au statut incertain ne doit pas être traitée comme vierge.
- En cas d'échec de l'écriture ou de la relecture, l'état doit être considéré comme incertain : aucun rollback de l'opération complète n'est garanti. Il ne faut pas relancer automatiquement l'import ni activer l'appareil sans diagnostic et reprise sûrs.
- Un store sans identité peut contenir des préclés, sessions ou autres données cryptographiques. L'opération actuelle ne vérifie pas l'absence de ces données : le test de conservation d'une préclé ne valide pas son utilisation avec l'identité importée. L'initialisation n'est acceptable que dans un espace dont l'état vierge ou la cohérence avec l'identité à installer a été établi par une procédure autorisée et testée. Un état inconnu ou partiel doit rester isolé, sans suppression ni réinitialisation automatique.
- Le store SQLite du SDK écrit identité et registration ID dans une transaction interne ; cela ne rend pas atomique le contrôle d'absence préalable. Les tests n'injectent pas de panne pendant cette transaction.
- La cohérence des clés n'authentifie pas leur provenance. Avant association multi-appareils en production, il faut authentifier le transfert, autoriser l'appareil, coordonner durablement tous les écrivains et tester récupération, panne et révocation.
- La compatibilité Expo, le coffre natif et les stores SQLCipher mobiles restent à tester sur appareils. La plage d'identifiants 1–16380 demeure conservatrice en raison de la divergence du SDK.

## Reprise attendue après une écriture incertaine

Mettre l'appareil et son store en attente, empêcher leur activation et toute écriture concurrente, conserver les données et le coffre pour diagnostic, puis appliquer une procédure de reprise authentifiée et testée. Cette procédure doit déterminer l'état durable et sa cohérence avant toute décision d'activation ou nouvelle tentative. Aucun effacement, remplacement ou nouvel import automatique n'est autorisé. Cette procédure n'est pas encore implémentée ni validée.

## SEC-CRYPTO-002 — Ouvert

Avant toute association ou récupération d'appareil en production, démontrer la création conditionnelle atomique de l'identité et de son identifiant local ou une garantie équivalente, la protection de tous les chemins d'écriture contre les remplacements silencieux, une reprise sûre après panne, des tests de concurrence et d'intégration sur les backends réellement utilisés et une gestion cohérente des états partiels. Les détails et options figurent dans ADR-003.

## Suite

Étudier d'abord une primitive publique OpenE2EE adaptée. À défaut, évaluer un adaptateur transactionnel conforme aux interfaces publiques après décision architecturale supplémentaire. Aucun jalon ultérieur n'est engagé.
