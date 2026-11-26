# Contrat HTTP applicatif mobile

## Opérations serveur

| Besoin                   | Routes actuelles                                       |
| ------------------------ | ------------------------------------------------------ |
| Inscription              | `POST /v1/auth/registration/request`, puis `/complete` |
| Connexion                | `POST /v1/auth/login`                                  |
| Session                  | `GET /v1/session`, `DELETE /v1/session`                |
| Initialisation du coffre | `POST /v1/vault/bootstrap`, puis `/receipt`            |

Les limites serveur des requêtes JSON sont de 8 Kio en général et de 192 Kio pour les deux routes de coffre initial. Les opérations métier traitent explicitement les issues inconnues et les reprises après perte de réponse; le transport ne décide pas de ces reprises.

Contrats serveur de référence : [inscription et vérification e-mail](http-email-registration.md), [connexion](http-login.md), [sessions](http-sessions.md), [réauthentification](reauthentication-grants.md) et [amorçage initial/récupération de reçu](http-initial-device-bootstrap.md).

## Client et réponse

Le client accepte GET, POST et DELETE sur les chemins `/v1/` définis, utilise uniquement HTTPS et un Bearer fourni explicitement. POST est la seule méthode avec corps JSON. Les redirections sont refusées et le client applicatif commun ne relance pas les requêtes. Le profil natif accepte au maximum deux opérations simultanément actives. Un GET explicitement autorisé peut bénéficier de reprises transparentes après une perte réseau ou une erreur de cadrage admissible, dans la même opération, avec les mêmes paramètres, la même échéance et le même signal d’annulation. Les campagnes historiques ont notamment observé trois réceptions pour un GET. Aucun plafond universel de deux émissions réseau n’est démontré. POST et DELETE sont protégés contre les réémissions après réception possible.

Le délai est configurable de 1 à 120 000 ms et la taille de 1 à 1 048 576 octets décodés. Le délai total couvre l’attente, les opérations natives éventuelles et la livraison du corps. Le profil natif commun demande `Accept-Encoding: identity`; toute réponse avec corps a un `Content-Length` exact et n’expose ni `Content-Encoding` ni `Transfer-Encoding`. Un 204 doit être vide. Le client vérifie le statut attendu, le type JSON, l’UTF-8 strict et le JSON avant de retourner une valeur `unknown`. Tout consommateur doit encore valider cette valeur selon son schéma métier avant usage. Les erreurs publiques ne propagent ni URL, ni corps, ni en-tête, ni détail natif.

Le délai couvre la préparation, le transport et la validation. L’adaptateur ignore toute livraison tardive après expiration ou annulation. Le transport natif doit arrêter effectivement la tâche et libérer son état. Le contrat et ses motifs sont fixés par l’[ADR-004](../architecture/decisions/004-bounded-mobile-api-responses.md).

## Reprise métier après résultat incertain

Une issue `OUTCOME_UNKNOWN`, un timeout ou une perte de réponse ne prouve pas qu’une écriture a échoué ou a été annulée. Les règles de reprise sont propres à chaque route :

- **Demande d’inscription :** le serveur conserve l’acceptation générique et n’assure pas de renvoi SMTP automatique après panne. Une nouvelle demande est soumise aux fenêtres et quotas de la référence inscription.
- **Finalisation d’inscription :** rejouer exactement l’adresse et la preuve permet de retrouver un reçu durable de finalisation ; ne pas supposer qu’un `503` signifie l’absence de compte.
- **Connexion :** une réponse perdue ne permet pas de récupérer le token initial, qui n’est conservé que sous forme de hash. Une nouvelle tentative vérifie à nouveau le mot de passe et peut créer une nouvelle session et un nouvel appareil ; elle ne restaure pas la session précédente.
- **Lecture/révocation de session :** GET est idempotent côté application et peut bénéficier de la reprise GET native bornée. Après une réponse perdue de DELETE, l’état peut déjà être révoqué ; une nouvelle lecture ou tentative peut donc répondre `401`. Aucune session n’est recréée automatiquement.
- **Réauthentification et écritures sensibles :** suivre le contrat métier de grant ou d’opération ; ne jamais rejouer une mutation aveuglément à la couche HTTP.
- **Amorçage du coffre :** conserver l’identifiant d’opération, l’enveloppe exacte, ses octets et son digest. Relire `POST /v1/vault/bootstrap/receipt` avec une session valide du même appareil. Le résultat `unknown` ne prouve pas le rollback et ne justifie pas de jeter l’opération. Le rejeu d’activation exige les mêmes données et le contrôle courant du mot de passe.

## État d’intégration

URLSession est retenu sur iOS et OkHttp sur Android. La qualification standard ne déverrouille pas l’usage métier iOS : aucun secret réel ne doit être envoyé avant revue et qualification spécifiques. Les rapports acceptés et les limites restent dans la [référence HTTPS](native-https-foundation.md) et le [modèle de menaces](../security/threat-model.md#transport-https-mobile).
