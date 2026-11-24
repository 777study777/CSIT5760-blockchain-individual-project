# Design notes

Working notes for the report. They record *why* the contract looks the way it does, including
the options that were rejected.

## 1. State and time

```solidity
enum State { Bidding, Revealing, Settled, Cancelled }
```

Four states, two deadlines (`commitDeadline`, `revealDeadline`). Only three transitions exist,
and none of them is triggered by a privileged caller:

| From → To | Trigger | Guard |
| --- | --- | --- |
| Bidding → Revealing | any call that first runs `_sync` (or `phaseOf`) | `block.timestamp > commitDeadline` |
| Revealing → Settled | `settle` | deadline passed **and** `highestBidder != 0` |
| Bidding → Cancelled | `cancel` | caller is the seller **and** `commitCount == 0` |
| Revealing → Cancelled | `cancel` | deadline passed **and** `highestBidder == 0` |

Rejected alternative: an explicit `startReveal()` function. It adds a transaction that can be
front-run or simply never sent, which would leave the contract stuck in `Bidding` while the
deadline has passed. Deriving the phase from block time removes that failure mode; `_sync` only
persists what the clock already decided.

`Bidding → Cancelled` and `Revealing → Cancelled` are deliberately separate branches: the
seller may delist while nobody has committed, but once a commitment exists the seller must wait
out both windows. That protects bidders from a seller who lists, collects commitments, then
pulls the token.

## 2. Accounting

One mapping holds every claim on ETH:

```solidity
mapping(uint256 => mapping(address => uint256)) public deposits;
```

`deposits[auctionId][account]` is the only source of truth for what an account is owed, and
`totalEscrowed` is the sum of all of them. Every balance-changing path is a pair of writes:

| Operation | Effect on `deposits` |
| --- | --- |
| `commitBid` | `+= msg.value` (mirrored by `totalEscrowed += msg.value`) |
| `settle` | winner `-= highestBid`, seller `+= highestBid` |
| `forfeit` | non-revealer `-= deposit`, seller `+= deposit` |
| `withdraw` | caller `= 0`, ETH sent, `totalEscrowed -= amount` |

Because settlement only moves numbers inside the ledger and `withdraw` is the single exit, the
contract's ETH balance never has to be reasoned about per auction: `address(this).balance`
equals `totalEscrowed` (strictly, without forced transfers) at every point between transactions.
The test `keeps balance equal to totalEscrowed through every phase` asserts exactly that.

Rejected alternative: one global `credit[address]` mapping. It is simpler to withdraw, but it
loses the per-auction attribution that `forfeit(auctionId, bidder)` needs and makes the ledger
impossible to audit per sale.

## 3. Commitment scheme

```
commitment = keccak256(abi.encode(amount, nonce, msg.sender, auctionId, address(this)))
```

Five fields, each closing a specific attack:

| Field | Attack it blocks |
| --- | --- |
| `amount` | changing the price after seeing rivals |
| `nonce` | brute-forcing a small amount space from the hash |
| `msg.sender` | copying someone else's commitment and revealing it oneself |
| `auctionId` | replaying a commitment from another auction |
| `address(this)` | replaying a commitment against a second deployment of the same code |

`hashCommitment(...)` exposes the same computation as a `view` so a client cannot get the
encoding wrong; the tests use it for that reason.

Rejected alternative: `keccak256(abi.encodePacked(...))`. `encodePacked` makes two different
`(uint256, bytes32)` pairs collide in the packed byte string when the dynamic types line up;
`abi.encode` removes the ambiguity at the cost of a few hundred gas.

## 4. Deposit policy

| Option | Effect on privacy |
| --- | --- |
| deposit = bid | exact price public before the reveal; hash is decorative |
| fixed deposit | price hidden, but a winner can promise more than it escrowed |
| **deposit ≥ bid, surplus refunded** (chosen) | only `bid <= deposit` leaks |

The residual leak is real and is accepted: `msg.value` is part of the transaction. The README
documents it, the report will quantify it, and the fixed-deposit variant is listed as future
work rather than pretended away.

## 5. Token custody

`createAuction` pulls the token with `transferFrom`; payouts push it with `transferFrom` as
well. Consequences:

- The contract does not implement `onERC721Received`, so an unsolicited `safeTransferFrom` to
  it reverts — no token can be stranded without an auction record.
- A winner that is a contract without the receiver hook still receives the token, so settlement
  cannot be blocked. The trade-off is that such a winner may be unable to move the token; that
  is the winner's problem, not a protocol failure.

## 6. Reentrancy posture

Only `withdraw` makes an external call with value. It follows checks-effects-interactions
(balance zeroed, `totalEscrowed` decremented) *and* is `nonReentrant`. `settle` and `cancel`
make an external call to the NFT, which could in principle re-enter; both write the new state
before the transfer, and both are `nonReentrant`, so a re-entrant call sees `Settled` /
`Cancelled` and reverts on the state guard.

`createAuction` is `nonReentrant` as well, because it calls `ownerOf` and `transferFrom` on a
caller-supplied contract.

## 7. Gas and size (measured locally, optimizer 200)

| Item | Value |
| --- | --- |
| `AuctionHouse` deployment | 1,496,018 gas |
| `MockNFT` deployment | 957,185 gas |
| `AuctionHouse` runtime bytecode | 6,570 bytes |

No assembly, no bit-packing beyond `uint64` deadlines and a `uint32` commit counter. Packing the
`Auction` struct further was rejected: the struct is read whole in `settle`, so the saving would
be one storage slot at the cost of unreadable code.

## 8. Open questions for the report

- Quantify the deposit-leak signal on synthetic data (how much the bound narrows as rounds go on).
- Compare commit-reveal against a fixed-deposit scheme on griefing cost.
- Record what Slither reports and either fix it or justify it.
