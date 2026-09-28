No blocker found in static inspection of the three files.

I traced the four focus areas against reachable action sequences. The model and its restore validator agree on every path I could construct.

**Per-period accounting**

- Periods are anchored at activation and never reset on amendment. Each period earns the greater of minimum and share, with grace arrivals landing in their own arrival period at zero minimum.
- Payments allocate oldest-first against each period's unpaid amount, computed at the payment instant. A payment cannot exceed what is owed at that moment, so paying an unacknowledged day-one share cannot prepay later minima.
- Deposit draws allocate only against the elapsed minimum or the acknowledged share per period. Unacknowledged shares never enter the drawable figure.
- The worked example checks out. Pair, advance 12h, record a 100 arrival at 70/30, advance 12h, then advance 24h fourteen times gives 30 for period one and 2 for each of the next fourteen, totalling 58.

**Owner-only acknowledgment**

- The attest transition rejects any role other than owner, requires the exact arrival key, blocks duplicates, and blocks at or after exit plus 72h using strict less-than on the acknowledgment timestamp.
- The UI disables the button under the same condition. Restore re-validates every acknowledgment against the same deadline.

**Refunds after the cutoff**

- Sequence: accept, deposit, pair, arrive, advance 24h, end as either party, advance 24h three times. The clock lands exactly on the deadline. Acknowledgment is now rejected, refund is allowed, and the refundable amount is reserve minus authorized-only debt. Unacknowledged share does not freeze the refund.
- Voluntary payment after refund still works because the pay path allocates against owed, not collectible. The restore check that provider funding never exceeds entitlement holds because entitlement is monotonic per period.

**Restore consistency**

Each ledger row is recomputed against the state as of its own timestamp. I checked that the transition-time inputs match the restore-time inputs in every case:

- Period minima are capped by end and unpair times that are always later than the payment being checked, so recomputation matches.
- Arrival coverage recomputed with final version bounds matches the original because version end times are set only at later events.
- Clock invariants hold because every transition and agreement creation ends with an event, and host creation touches neither the clock nor the sequence.
- Transfer flow: transfer sets the request time one tick after the end event, the 30-minute advance lands exactly on the delay, and disconnect stamps one tick later, satisfying the strict greater-than restore check.

**Non-blocking observations**

- The "prorated hosting minimum" card uses one floored total, while the billing table floors per period. They can disagree by a minor unit or two. Display only.
- The refund transition evaluates collectible at the pre-event tick while its ledger row is stamped one tick later. No behavioral difference today, but it is the one place the "compute at now plus one" convention is broken.
- The host listing form accepts inputs the model rejects, such as nine skills or a one-character skill. The error surfaces in the form, so it is a usability nit.
- The static server assumes index.html references app.js and styles.css by those exact paths. Those files were not in scope, so I could not confirm.

**Production prerequisites, not prototype bugs**

- Role switching is unauthenticated by design. Every authority check keys off a client-chosen role.
- Draw authority rests on an owner acknowledgment that is a checkbox, not a signature. A real contract needs an owner-signed settlement or a narrower payment route, as the separate draft spec reportedly covers.
- Arrival observation, transfer detection, and disconnect confirmation are simulation controls. The restore validator explicitly does not defend against a user editing their own ledger.
- The transfer-pending timer asserts nothing about a real disconnection. The demo correctly requires a separate confirmation, but that confirmation is still a button.