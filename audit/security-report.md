# Security review — SealedBid AuctionHouse

| | |
| --- | --- |
| Reviewed commit | `679d1ff` (merge of PR #1; contract identical to `v0.1.0`) |
| Date | 25 November 2026 |
| Scope | `contracts/AuctionHouse.sol`, `contracts/mocks/MockNFT.sol`, `contracts/mocks/Attackers.sol` |
| Out of scope | `node_modules/@openzeppelin/contracts/**` (audited upstream, versions pinned), deployment keys, off-chain nonce handling |
| Tools | Slither 0.11.6 (102 detectors), solc 0.8.24, Hardhat 2.29.1, Hardhat test suite |
| Method | static analysis → manual checklist against the risk list in Guideline §3.7 → test evidence → triage |

Raw output: [`slither-raw.txt`](slither-raw.txt). Reproduce with:

```bash
npx hardhat compile
slither . --compile-force-framework hardhat --hardhat-ignore-compile
```

`--hardhat-ignore-compile` reuses the existing `artifacts/build-info`, so the analysis reads exactly
the bytecode that `npm test` and the deploy script use.

## 1. Result summary

Slither analysed 21 contracts and reported **29 results** across 9 detector categories.

| Where | Results | Assessment |
| --- | --- | --- |
| `AuctionHouse.sol` | 8 (6 timestamp uses, 1 local variable, 1 low-level call) | 0 high, 0 medium; 1 false positive; 7 informational or by design |
| `contracts/mocks/*` | 1 (benign reentrancy inside a test double) | test-only code |
| `node_modules/@openzeppelin` | 20 (assembly, `mulDiv` division, xor-as-exponent) | third-party, not reachable from `AuctionHouse` |

**No high or medium severity issue was found in project code, and no code change was required.**
What follows is the triage, item by item, so the "no change" conclusion can be checked rather
than trusted.

## 2. Triage

| ID | Detector | Location | Severity | Status | Reasoning |
| --- | --- | --- | --- | --- | --- |
| A-01 | `uninitialized-local` | `withdraw`, `uint256 owed` (L304) | Low | **False positive** | `owed` is assigned on every path that reaches the transfer: `Cancelled` (L306), `Settled` + seller (L309), `Settled` + revealed (L313); every other path `revert`s first. The three branches are all exercised, so the compiler-visible default value is never read. Left unchanged: initialising it would hide the reasoning rather than fix anything. |
| A-02 | `timestamp` | `commitBid` L189, `revealBid` L219, `settle` L254, `cancel` L284, `phaseOf` L366, `_sync` L387 | Low | **By design** | The auction is a time-boxed mechanism; deadlines are the product requirement, not an accident. No randomness, no payout ratio and no ordering decision depends on the exact second: a miner can shift the boundary by seconds, which at worst moves one bid between "just inside" and "just outside". Documented in README §13 and tested at the boundary (`accepts a commitment at exactly the deadline…`, `accepts a reveal at exactly the reveal deadline…`). |
| A-03 | `low-level-calls` | `withdraw`, `msg.sender.call{value: owed}` (L326) | Low | **Accepted** | The only ETH exit, deliberately a pull payment: balances are zeroed and `totalEscrowed` decremented before the call (L323–324), the function is `nonReentrant`, and a failing receiver reverts only its own withdrawal — proven by `survives a reentrant receiver` and `confines a rejecting receiver's failure to itself`. Replacing `.call` with `transfer` would reintroduce the 2300-gas failure mode. |
| A-04 | `reentrancy-benign` | `ReentrantBidder.receive` (`Attackers.sol` L32–41) | Info | **Test-only** | The double exists to re-enter `withdraw` on purpose; the test asserts the inner call reverts and the outer transfer still succeeds. Not deployed by `scripts/deploy.js`. |
| A-05 | `pragma` (2 versions) | OZ `^0.8.20` vs project `0.8.24` | Info | **Accepted** | Third-party ranges include the pinned compiler; the project's own files use an exact version so the deployed bytecode is reproducible. |
| A-06 | `solc-version` | same files | Info | **Accepted** | Same cause as A-05. `hardhat.config.js` pins 0.8.24; verification will use that exact version. |
| A-07 | `divide-before-multiply` | `Math.mulDiv`, `Math.invMod` (OZ) | Info | **Third-party** | Intentional fixed-point arithmetic in OpenZeppelin's maths library; `AuctionHouse` performs no division at all. |
| A-08 | `assembly` | `Math`, `Strings`, `SafeCast`, `Panic`, `ERC721Utils` (OZ) | Info | **Third-party** | Reviewed upstream; the project writes no assembly. |
| A-09 | `incorrect-exp` | `Math.mulDiv` (OZ) | Info | **Third-party** | `^` is bitwise xor used as an optimisation step in the Newton–Raphson inverse; not exponentiation by mistake. |

## 3. Manual checklist

Each row is a risk named in the guideline, with the control that applies and where the evidence
lives. This is the part static analysis does not cover.

| Risk | Control in this contract | Evidence |
| --- | --- | --- |
| Unauthorised access | no owner, no role registry; `msg.sender` compared to the seller or to the stored bidder; no `tx.origin` anywhere | `rejects a caller who does not own the token`, `rejects the seller as a bidder`, `refuses a delist by a stranger` |
| Reentrancy | single ETH exit, CEI + `nonReentrant`; `settle`/`cancel` write state before the NFT call; `createAuction` guarded because it calls a caller-supplied contract | `survives a reentrant receiver`, `cannot be executed twice` |
| Duplicate execution | state written before transfers; `settle` requires `Revealing`, `cancel` refuses `Settled`/`Cancelled`, `withdraw` zeroes before paying | `cannot be executed twice`, `blocks a double withdrawal`, `refuses to cancel a settled auction` |
| Denial of service | `settle` never iterates bidders; forfeits are per address and permissionless; winner cannot block settlement through a missing receiver hook (`transferFrom`, not `safeTransferFrom`) | `settles even when the winner is a contract without an ERC-721 receiver hook`, `refuses a withdrawal by a non-revealer; forfeit moves the deposit to the seller` |
| Front-running | commit-reveal; hash binds amount, nonce, `msg.sender`, `auctionId`, `address(this)`; one commitment per account | `rejects a commitment copied from another bidder`, `binds each commitment to the bidder and the auction` |
| Input validation | zero deposit, zero commitment, zero bid, bid above deposit, zero-length phase, unknown auction id, seller bidding — one custom error each | the negative cases in groups 1–5 of the test file |
| Integer safety | Solidity 0.8 checked arithmetic, no `unchecked`, no division, `uint64` deadlines with overflow-checked addition | compilation settings; no arithmetic other than `+=`/`-=` |
| Privacy | `BidCommitted` carries the bidder only; the amount appears in calldata only at reveal time | `leaks no plaintext bid amount during the commit phase` |
| Randomness | none used, deliberately — no weak on-chain entropy anywhere | review of the full contract surface |
| Oracle manipulation | no external price source; the only external calls are to the NFT contract the seller chose | — |

## 4. Residual risks (accepted, not fixed)

These are design trade-offs rather than defects. They are recorded here so the report does not
claim more than the code delivers.

1. **Deposit leaks an upper bound.** `msg.value` is public; an observer learns `bid <= deposit`.
   Mitigation is documented (randomise the surplus), the fixed-deposit variant is future work.
2. **A minimum-value commitment can delay a delisting.** One wei from any address blocks the
   seller's `cancel` until both windows expire; the griefer's capital is locked for the same
   period and is refunded in the `Cancelled` path, so the attack costs time, not money.
3. **Forced ETH breaks `balance == totalEscrowed`.** `selfdestruct` or a block reward can push the
   balance above the ledger. Solvency (`balance >= totalEscrowed`) is unaffected, and no path pays
   out more than was booked.
4. **No emergency stop.** Intentional: a pause switch would be a privileged key able to freeze
   other people's escrowed NFTs and bids. The trade-off is written down rather than hidden.

## 5. Retest log

| Step | Command | Result |
| --- | --- | --- |
| Compile, same settings as deployment | `npm run compile` | 18 files, evm target cancun |
| Unit suite after review | `npm test` | 38 passing |
| Coverage | `npm run coverage` | statements / lines / functions 100 %, branches 81.37 % |
| Static analysis | `slither . --compile-force-framework hardhat --hardhat-ignore-compile` | 29 results, triaged above |
| Bytecode unchanged by the review | `deployedBytecode` length | 6,570 bytes |

No source file changed during this review, so the deployed bytecode (once deployed) will match
commit `679d1ff` or a later commit that only touches documentation and scripts.

## 6. Conclusion

The contract's attack surface is small by construction: one contract, one privileged action
(seller delisting before the first commitment), one ETH exit, no upgradeability, no oracle, no
randomness. Static analysis produced nothing above informational severity in project code, and
the three items that do touch it are either by design (timestamps, pull payment) or a false
positive (uninitialised local). The remaining risk is concentrated in the deposit/privacy
trade-off and in the time-boxed griefing window, both of which are documented as limitations
rather than presented as solved.
