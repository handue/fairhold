# PayPal sandbox lifecycle

Written by `npm run paypal:lifecycle` (scripts/paypal-lifecycle.ts) from the answers of the PayPal
sandbox, called through @paypal/paypal-server-sdk 2.5.0 with a PayPal-Request-Id on every POST.
Each section names where it ran; rerunning a scenario replaces only its own section.

**29 of 29 checks passed.**

## Preflight · Credentials, order creation and error mapping, without approvals

Run 20261107T193041 on the PayPal sandbox, finished 2026-11-07T19:30:43.273Z.

| Check | Result | PayPal answered | debug_id |
| --- | --- | --- | --- |
| Create an AUTHORIZE order | pass | 5F1328763L505212J PAYER_ACTION_REQUIRED, payer-action www.sandbox.paypal.com | ca56ec103a8a6 |
| Replay with the same PayPal-Request-Id | pass | 5F1328763L505212J | ca56ec1071de2 |
| Authorize before approval is refused | pass | ORDER_NOT_APPROVED (HTTP 422) | ca56ec10998ed |
| Unknown authorization is refused | pass | INVALID_RESOURCE_ID (HTTP 404) | ca56ec10b5b2e |

order: `5F1328763L505212J`

## A · Capture $320 of a $500 hold, with a declined attempt and a replay

Run 20261109T051010 on the PayPal sandbox, finished 2026-11-09T05:10:42.547Z.

| Check | Result | PayPal answered | debug_id |
| --- | --- | --- | --- |
| A return token is the order id | pass | 6DS87329JT649891U |  |
| A authorize $500 | pass | 3U222770MA387621Y CREATED $500, expires 2026-12-08T05:10:38.000Z | f6851913ea66d |
| Mocked decline is refused | pass | TRANSACTION_REFUSED (HTTP 422) | 70c28ae654da |
| Hold untouched after the decline | pass | CREATED | f289795f9b07f |
| Capture $320 with final_capture | pass | 6HF23193AH088391B COMPLETED $320, final_capture true | f28979587f9fd |
| Replay with the same PayPal-Request-Id | pass | returned 6HF23193AH088391B COMPLETED | f8155856fd0c5 |
| Authorization after the capture | pass | CAPTURED; the other $180 should be released | f81558562c095 |

A order: `6DS87329JT649891U` · A authorization: `3U222770MA387621Y` · capture: `6HF23193AH088391B`

## B · Void a $250 hold

Run 20261109T040438 on the PayPal sandbox, finished 2026-11-09T04:08:47.514Z.

| Check | Result | PayPal answered | debug_id |
| --- | --- | --- | --- |
| B return token is the order id | pass | 82Y39163MJ1077913 |  |
| B authorize $250 | pass | 10G36722CN287812U CREATED $250, expires 2026-12-08T04:08:45.000Z | f4186622760ab |
| Void | pass | VOIDED | f262616b3df8e |
| Read back | pass | VOIDED | f28181622abd6 |

B order: `82Y39163MJ1077913` · B authorization: `10G36722CN287812U`

## C · Raise $500 to $700: a new authorization, then void the old one

Run 20261109T040438 on the PayPal sandbox, finished 2026-11-09T04:09:36.990Z.

| Check | Result | PayPal answered | debug_id |
| --- | --- | --- | --- |
| C1 return token is the order id | pass | 47698687CV3109312 |  |
| C1 authorize $500 | pass | 3YD19456UX512984J CREATED $500, expires 2026-12-08T04:09:07.000Z | f623868de6f1f |
| C2 return token is the order id | pass | 6XU59803NH376450T |  |
| C2 authorize $700 | pass | 68360298VV636894K CREATED $700, expires 2026-12-08T04:09:35.000Z | f2394313c726f |
| Void the $500 authorization | pass | VOIDED | f160588c02840 |
| Old authorization read back | pass | VOIDED | f8665653a1151 |
| New authorization read back | pass | CREATED | f86656593047f |
| Exactly one live authorization | pass | 1 live |  |

C1 order: `47698687CV3109312` · C1 authorization: `3YD19456UX512984J` · C2 order: `6XU59803NH376450T` · C2 authorization: `68360298VV636894K`

## D · Authorize $300 and leave it open for the reauthorize test

Run 20261109T040438 on the PayPal sandbox, finished 2026-11-09T05:09:05.364Z.

| Check | Result | PayPal answered | debug_id |
| --- | --- | --- | --- |
| D return token is the order id | pass | 0LP32668FL094305A |  |
| D authorize $300 | pass | 9SA0512390099544K CREATED $300, expires 2026-12-08T05:09:03.000Z | f671186b6f2e6 |
| Read back | pass | CREATED | f50743061f855 |

D order: `0LP32668FL094305A` · D authorization: `9SA0512390099544K`

## E · Authorize $300 and leave it open for the reauthorize test

Run 20261109T040438 on the PayPal sandbox, finished 2026-11-09T05:09:55.502Z.

| Check | Result | PayPal answered | debug_id |
| --- | --- | --- | --- |
| E return token is the order id | pass | 4FX05524JV6453712 |  |
| E authorize $300 | pass | 4C7569604Y849600H CREATED $300, expires 2026-12-08T05:09:54.000Z | f8183756e1b50 |
| Read back | pass | CREATED | f1107087652c4 |

E order: `4FX05524JV6453712` · E authorization: `4C7569604Y849600H`

## Open for the reauthorize test

| Hold | Authorization | Amount | Authorized | Honor period ends | Expires |
| --- | --- | --- | --- | --- | --- |
| lifecycle-20261109T040438-D | `9SA0512390099544K` | $300 | 2026-11-09T05:09:03.000Z | 2026-11-12T05:09:03.000Z | 2026-12-08T05:09:03.000Z |
| lifecycle-20261109T040438-E | `4C7569604Y849600H` | $300 | 2026-11-09T05:09:54.000Z | 2026-11-12T05:09:54.000Z | 2026-12-08T05:09:54.000Z |

Once the honor period ends: reauthorize D on its original id, then capture the new id; reauthorize E, then void
E's original id; then try to reauthorize a new id to record REAUTHORIZATION_NOT_SUPPORTED.
A REAUTHORIZATION_TOO_SOON answer means the honor period has not ended yet.

<!-- paypal-lifecycle-data
{
  "Preflight": {
    "scenario": "Preflight",
    "title": "Credentials, order creation and error mapping, without approvals",
    "runId": "20261107T193041",
    "mode": "sandbox",
    "finishedAt": "2026-11-07T19:30:43.273Z",
    "checks": [
      {
        "label": "Create an AUTHORIZE order",
        "passed": true,
        "detail": "5F1328763L505212J PAYER_ACTION_REQUIRED, payer-action www.sandbox.paypal.com",
        "debugId": "ca56ec103a8a6"
      },
      {
        "label": "Replay with the same PayPal-Request-Id",
        "passed": true,
        "detail": "5F1328763L505212J",
        "debugId": "ca56ec1071de2"
      },
      {
        "label": "Authorize before approval is refused",
        "passed": true,
        "detail": "ORDER_NOT_APPROVED (HTTP 422)",
        "debugId": "ca56ec10998ed"
      },
      {
        "label": "Unknown authorization is refused",
        "passed": true,
        "detail": "INVALID_RESOURCE_ID (HTTP 404)",
        "debugId": "ca56ec10b5b2e"
      }
    ],
    "ids": {
      "order": "5F1328763L505212J"
    },
    "open": []
  },
  "A": {
    "scenario": "A",
    "title": "Capture $320 of a $500 hold, with a declined attempt and a replay",
    "runId": "20261109T051010",
    "mode": "sandbox",
    "finishedAt": "2026-11-09T05:10:42.547Z",
    "checks": [
      {
        "label": "A return token is the order id",
        "passed": true,
        "detail": "6DS87329JT649891U",
        "debugId": null
      },
      {
        "label": "A authorize $500",
        "passed": true,
        "detail": "3U222770MA387621Y CREATED $500, expires 2026-12-08T05:10:38.000Z",
        "debugId": "f6851913ea66d"
      },
      {
        "label": "Mocked decline is refused",
        "passed": true,
        "detail": "TRANSACTION_REFUSED (HTTP 422)",
        "debugId": "70c28ae654da"
      },
      {
        "label": "Hold untouched after the decline",
        "passed": true,
        "detail": "CREATED",
        "debugId": "f289795f9b07f"
      },
      {
        "label": "Capture $320 with final_capture",
        "passed": true,
        "detail": "6HF23193AH088391B COMPLETED $320, final_capture true",
        "debugId": "f28979587f9fd"
      },
      {
        "label": "Replay with the same PayPal-Request-Id",
        "passed": true,
        "detail": "returned 6HF23193AH088391B COMPLETED",
        "debugId": "f8155856fd0c5"
      },
      {
        "label": "Authorization after the capture",
        "passed": true,
        "detail": "CAPTURED; the other $180 should be released",
        "debugId": "f81558562c095"
      }
    ],
    "ids": {
      "A order": "6DS87329JT649891U",
      "A authorization": "3U222770MA387621Y",
      "capture": "6HF23193AH088391B"
    },
    "open": []
  },
  "B": {
    "scenario": "B",
    "title": "Void a $250 hold",
    "runId": "20261109T040438",
    "mode": "sandbox",
    "finishedAt": "2026-11-09T04:08:47.514Z",
    "checks": [
      {
        "label": "B return token is the order id",
        "passed": true,
        "detail": "82Y39163MJ1077913",
        "debugId": null
      },
      {
        "label": "B authorize $250",
        "passed": true,
        "detail": "10G36722CN287812U CREATED $250, expires 2026-12-08T04:08:45.000Z",
        "debugId": "f4186622760ab"
      },
      {
        "label": "Void",
        "passed": true,
        "detail": "VOIDED",
        "debugId": "f262616b3df8e"
      },
      {
        "label": "Read back",
        "passed": true,
        "detail": "VOIDED",
        "debugId": "f28181622abd6"
      }
    ],
    "ids": {
      "B order": "82Y39163MJ1077913",
      "B authorization": "10G36722CN287812U"
    },
    "open": []
  },
  "C": {
    "scenario": "C",
    "title": "Raise $500 to $700: a new authorization, then void the old one",
    "runId": "20261109T040438",
    "mode": "sandbox",
    "finishedAt": "2026-11-09T04:09:36.990Z",
    "checks": [
      {
        "label": "C1 return token is the order id",
        "passed": true,
        "detail": "47698687CV3109312",
        "debugId": null
      },
      {
        "label": "C1 authorize $500",
        "passed": true,
        "detail": "3YD19456UX512984J CREATED $500, expires 2026-12-08T04:09:07.000Z",
        "debugId": "f623868de6f1f"
      },
      {
        "label": "C2 return token is the order id",
        "passed": true,
        "detail": "6XU59803NH376450T",
        "debugId": null
      },
      {
        "label": "C2 authorize $700",
        "passed": true,
        "detail": "68360298VV636894K CREATED $700, expires 2026-12-08T04:09:35.000Z",
        "debugId": "f2394313c726f"
      },
      {
        "label": "Void the $500 authorization",
        "passed": true,
        "detail": "VOIDED",
        "debugId": "f160588c02840"
      },
      {
        "label": "Old authorization read back",
        "passed": true,
        "detail": "VOIDED",
        "debugId": "f8665653a1151"
      },
      {
        "label": "New authorization read back",
        "passed": true,
        "detail": "CREATED",
        "debugId": "f86656593047f"
      },
      {
        "label": "Exactly one live authorization",
        "passed": true,
        "detail": "1 live",
        "debugId": null
      }
    ],
    "ids": {
      "C1 order": "47698687CV3109312",
      "C1 authorization": "3YD19456UX512984J",
      "C2 order": "6XU59803NH376450T",
      "C2 authorization": "68360298VV636894K"
    },
    "open": []
  },
  "D": {
    "scenario": "D",
    "title": "Authorize $300 and leave it open for the reauthorize test",
    "runId": "20261109T040438",
    "mode": "sandbox",
    "finishedAt": "2026-11-09T05:09:05.364Z",
    "checks": [
      {
        "label": "D return token is the order id",
        "passed": true,
        "detail": "0LP32668FL094305A",
        "debugId": null
      },
      {
        "label": "D authorize $300",
        "passed": true,
        "detail": "9SA0512390099544K CREATED $300, expires 2026-12-08T05:09:03.000Z",
        "debugId": "f671186b6f2e6"
      },
      {
        "label": "Read back",
        "passed": true,
        "detail": "CREATED",
        "debugId": "f50743061f855"
      }
    ],
    "ids": {
      "D order": "0LP32668FL094305A",
      "D authorization": "9SA0512390099544K"
    },
    "open": [
      {
        "hold": "lifecycle-20261109T040438-D",
        "authorizationId": "9SA0512390099544K",
        "amountCents": 30000,
        "authorizedAt": "2026-11-09T05:09:03.000Z",
        "honorUntil": "2026-11-12T05:09:03.000Z",
        "expiresAt": "2026-12-08T05:09:03.000Z"
      }
    ]
  },
  "E": {
    "scenario": "E",
    "title": "Authorize $300 and leave it open for the reauthorize test",
    "runId": "20261109T040438",
    "mode": "sandbox",
    "finishedAt": "2026-11-09T05:09:55.502Z",
    "checks": [
      {
        "label": "E return token is the order id",
        "passed": true,
        "detail": "4FX05524JV6453712",
        "debugId": null
      },
      {
        "label": "E authorize $300",
        "passed": true,
        "detail": "4C7569604Y849600H CREATED $300, expires 2026-12-08T05:09:54.000Z",
        "debugId": "f8183756e1b50"
      },
      {
        "label": "Read back",
        "passed": true,
        "detail": "CREATED",
        "debugId": "f1107087652c4"
      }
    ],
    "ids": {
      "E order": "4FX05524JV6453712",
      "E authorization": "4C7569604Y849600H"
    },
    "open": [
      {
        "hold": "lifecycle-20261109T040438-E",
        "authorizationId": "4C7569604Y849600H",
        "amountCents": 30000,
        "authorizedAt": "2026-11-09T05:09:54.000Z",
        "honorUntil": "2026-11-12T05:09:54.000Z",
        "expiresAt": "2026-12-08T05:09:54.000Z"
      }
    ]
  }
}
-->
