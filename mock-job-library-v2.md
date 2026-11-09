# Kitchen Quest – Mock Job Library & Points System (v2)
**EXAMPLE DATA ONLY. Not Ivan's real lists. Replace with real checklists and check against your food safety program before launch.**

## Ground rules
- Only managers create, edit or retire jobs and set point values. Staff cannot add or suggest jobs in the app.
- Food safety comes first. Compliance records are kept **separate from the game**: they are the kitchen's legal record and are stored and exported on their own, whatever happens with points.
- Food safety logs capture **actual readings**, not ticks. An out-of-range reading automatically creates a fix-it job and alerts the manager on shift.
- A missed log creates a fix-it job and a manager alert. It does **not** wipe anyone's points. Points are reversed only when a manager confirms a record was falsified.
- Points pay out only after verification (self-tick, photo or manager sign-off, depending on the job).
- Photos show the bench, equipment or product only, never people.

## Point scale
- 5 pts: quick, under 10 min
- 10 pts: standard, 10–30 min
- 20 pts: big, 30–60 min
- 30 pts: deep clean, 60+ min
- +50% "grim job" multiplier (drains, bins, behind equipment, grease trap area)
- Food safety logs: flat 3 pts each, fixed number per shift, can't be farmed

Verification key: T = self-tick, P = in-app photo (equipment/bench only), M = manager sign-off, R = reading recorded

## Food safety log fields (example ranges; confirm with your food safety program)
| Log | What's recorded | Example acceptable range | Out of range triggers |
|---|---|---|---|
| Cold storage temp | Unit name, air temp °C | 5°C or below (freezers -15°C or below) | Fix-it job: check unit, move stock, probe food |
| Food probe temp (cooling, hot holding, receiving) | Item, temp °C, time | Hot hold 60°C or above; cold 5°C or below; cooling per 2-hour/4-hour rule | Fix-it job: reheat, re-chill or discard, manager decides |
| Sanitiser check | Product, method (bucket/spray/dishwasher), concentration or test strip result | Per product label | Fix-it job: remake solution |
| Manual sanitising | Water temp °C, contact time | Per product label / food safety program | Fix-it job: redo |
| Dishwasher | Wash and rinse/sanitise temps °C or chemical setting | Per manufacturer | Fix-it job: stop use, manager alert |
| Delivery receiving | Supplier, product, temp °C, use-by, packaging OK | Chilled 5°C or below, frozen hard | Fix-it job: reject or quarantine, manager alert |

Fix-it jobs pay normal points (usually 5–10) to whoever resolves them, with manager sign-off. Nobody is penalised for reporting an out-of-range reading.

## Opening (all sections)
| Job | Section | Freq | Pts | Verify |
|---|---|---|---|---|
| Cold storage temps (each unit) | All | Daily | 3 | R + random M |
| Sanitiser made up and tested | All | Daily | 3 | R |
| Hand basins stocked (soap, towels) | All | Daily | 5 | T |
| Probe thermometers cleaned and checked (ice/boiling check) | Line | Daily | 3 | R |
| Equipment on and checked, faults reported | Line | Daily | 5 | T |
| Delivery receiving check | Prep | Per delivery | 5 | R + random M |
| Dishwasher filled, temps/chemicals checked | Dish | Daily | 5 | R |
| Read and confirm previous shift's handover | All (shift lead) | Per shift | 5 | T |

## Prep
| Job | Section | Freq | Pts | Verify |
|---|---|---|---|---|
| Complete prep list for a station | Prep/Line | Per shift | 10 | M spot check |
| Label and date all new containers | All | Per shift | 5 | random M |
| FIFO rotate cool room shelves | Prep | Daily | 10 | P |
| Batch sauces/stocks with cooling log | Prep | As needed | 10 + 3 log | R + M |
| Portion and vac-pack proteins | Prep | As needed | 10 | T |
| Pastry mise: doughs, creams, garnishes | Pastry | Daily | 10 | T |
| Bake-off and cooling log | Pastry | Daily | 10 + 3 log | R |

## Service
| Job | Section | Freq | Pts | Verify |
|---|---|---|---|---|
| Hot holding temps (every 2 hrs) | Line | Per service | 3 each | R |
| Restock station mid-service | Line | Per service | 5 (cap 3/shift) | T |
| Keep pass clean and wiped | Line | Per service | 5 | T |
| Dish pit cleared after the rush | Dish | Per service | 10 | M |
| Allergen check before service | Line | Per service | 5 | M |

## Closing
| Job | Section | Freq | Pts | Verify |
|---|---|---|---|---|
| Clean and sanitise all benches | All | Daily | 10 | P |
| Clean flat-top/grill | Line | Daily | 10 | P |
| Filter fryer oil | Line | Daily | 10 | T |
| Wrap, label, store all leftovers | All | Daily | 5 | random M |
| Sweep and mop section floor | All | Daily | 10 | P |
| Empty and clean bins | All | Daily | 15 (grim) | P |
| Dishwasher drained, filters cleaned | Dish | Daily | 10 | P |
| Pastry equipment cleaned | Pastry | Daily | 10 | P |
| Final cold storage temps and close-down check | All | Daily | 3 | R + M (required) |
| Write shift handover (see below) | All (shift lead) | Per shift | 10 | M confirms |

## Shift handover
Written by the closing or outgoing shift lead, confirmed by the incoming lead. 10 pts for writing it, 5 pts for reading and confirming it.
Covers:
- Prep done and outstanding, with dates on anything carried over
- Equipment faults and what's been reported
- Open customer issues (complaints, allergen follow-ups)
- Deliveries due or problems with today's deliveries
- Staffing gaps or changes for the next shift

## Deep cleaning (manager-assigned on a rotation)
| Job | Section | Freq | Pts | Verify |
|---|---|---|---|---|
| Degrease canopy filters | Line | Weekly | 20 | P + M |
| Boil out and deep clean fryers | Line | Weekly | 30 | P + M |
| Pull out and clean behind equipment | Line | Fortnightly | 45 (grim) | P + M |
| Scrub drains and floor grates | Dish | Weekly | 30 (grim) | P + M |
| Deep clean cool room | Prep | Weekly | 30 | P + M |
| Descale dishwasher | Dish | Weekly | 20 | P + M |
| Clean oven/combi interior | Line/Pastry | Weekly | 20 | P + M |
| Grease trap area check (contractor log sighted) | Dish | Monthly | 30 (grim) | M |

## Job rotation
- Managers assign high-point and grim jobs on a rotation across sections and people, so the same crew (often dish) aren't stuck with the low-value grind and the big jobs aren't always grabbed by the same few people.
- The app shows each person's mix of jobs over the last 4 weeks so managers can spot imbalance.
- Dish crew get first offer on rotated high-point jobs when their recent average is below the team's.

## Leaderboard fairness
- Main ranking is **points per shift worked**, not total points, so casuals and part-timers can compete.
- Section and team standings run alongside individual rankings.
- **Rookie tier**: staff in their first 6 weeks (example) have their own leaderboard and rewards.
- Most improved is tracked weekly and monthly.

## Streaks
- Counted on **rostered shifts only**. Days off, leave and sick days never break a streak.
- Clean Close streak (section): consecutive rostered shifts passing the manager's close-down check.
- Log Keeper streak (person): 7 rostered shifts with every log recorded on time.
- Handover Hero streak (shift lead): 10 handovers written and confirmed in a row.

## Badges (free)
- Temp Champ: 30 on-time readings
- Deep Diver: 5 verified deep cleans
- Fryer Whisperer: 10 fryer filters or boil-outs
- Rush Hero: on shift for 5 rush bonuses with close-down passed
- Spotter: reported 5 out-of-range readings or equipment faults that were confirmed
- Mentor: buddied a new starter through their first week (manager awarded)
- No Shortcuts: a month with no points reversed

## Team goals (weekly)
- 95% of checklists verified on time
- Every food safety log recorded, with every out-of-range reading closed off by a fix-it job
- Every rostered deep clean done
- Every handover written and confirmed
Unlock a shared reward; hitting 85% unlocks a smaller one.

## Rush bonus
Flat 10 pts each for the crew on a manager-flagged slammed service, paid only if close-down passes.

## Weekly rewards (tiered)
- **Tier 1** (everyone over an example 15 pts per shift worked): name on the board and a group chat shout-out
- **Tier 2** (over 25 pts per shift): pick of staff meal theme, or coffee shout
- **Top tier**: golden spatula trophy for the week, first pick of roster swap or preferred station
- **Rookie tier**: separate shout-out and small reward for the top new starter
- **Section win**: manager shouts coffees or a team snack
- **Monthly**: $20–30 voucher for the top scorer and the most improved

**Check before using:**
- *Early finish*: check against the relevant award and Fair Work rules (pay, rostered hours, breaks) before offering it. A safer swap is first pick of a preferred shift or station.
- *Knock-off drink*: check against responsible service of alcohol rules, your liquor licence and workplace policy. Suggested non-alcohol options: a specialty coffee, a smoothie or soft drink, a staff meal upgrade or a dessert from pastry.

## Safeguards against gaming
- P and M jobs stay pending until approved.
- Daily cap on repeatable quick jobs (e.g. restock max 3 per shift).
- Random manager spot checks on self-ticked jobs. A failed check reverses that job's points and puts it back on the list.
- Photos are taken in-app, timestamped and of equipment or benches only. No gallery uploads or reused photos.
- Jobs can only be claimed while rostered on and inside the job's time window.
- No one verifies their own job, and managers earn no points on jobs they sign off.
- Food safety readings are flat points and a fixed number per shift, so they can't be farmed. Reporting an out-of-range reading is never penalised.
- Proven falsification of a record reverses points and goes to the manager; it's handled as a performance issue, not just a game penalty.
- Ranking on points per shift and rotating big jobs stops a few people owning the leaderboard.
- Team goals weigh as much as individual points to keep it cooperative.
- Monthly manager review of point values to rebalance jobs that are always grabbed or always avoided.
