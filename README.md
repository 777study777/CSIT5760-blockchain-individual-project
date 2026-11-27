# SealedBid — Commit-Reveal Auction House for ERC-721

![ci](https://github.com/777study777/CSIT5760-blockchain-individual-project/actions/workflows/ci.yml/badge.svg)

- **Student:** Zhang Huanrong
- **Student ID:** 21346263
- **Course:** CSIT5760 Blockchain and Smart Contracts (2026–27), individual project
- **Target network:** Sepolia, chain ID 11155111
- **Main contract:** [`contracts/AuctionHouse.sol`](contracts/AuctionHouse.sol)
- **Proposal:** [`docs/proposal.pdf`](docs/proposal.pdf) (submitted 8 November 2026)
- **Final report:** [`docs/report.pdf`](docs/report.pdf) (31 pages, seven chapters, appendices A–F)

## Abstract

Every pending transaction is public before it is mined, so in an open NFT auction a bot can  
watch the mempool and outbid the current leader in the next block. A centralised auction  
platform can hide bids, but only by asking bidders to trust the operator — and a database  
cannot prove it did not look.

`AuctionHouse` removes that trust. A seller escrows one ERC-721 and opens two windows. During  
the commit window bidders publish only `keccak256(amount, nonce, bidder, auctionId, contract)`  
plus a deposit. During the reveal window they publish the plaintext; the contract recomputes  
the hash and rejects anything that does not match, which proves the amount was fixed before  
bidding closed. Settlement then swaps token and payment in a single transaction. There is no  
owner, no pause switch and no upgrade path: every transition is guarded by state and block  
time alone.

## Implementation status

| Area                                                 | State                                                                         | Where to look                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| Contract implementation (`AuctionHouse`, `MockNFT`)  | done                                                                          | `contracts/`                                           |
| Test suite (positive, negative, boundary, duplicate) | done — 38 passing, 100 % line coverage                                        | §6, `test/`                                            |
| Local end-to-end demo script                         | done — `npm run demo` closes at 0.0 ETH                                       | `scripts/demo.js`                                      |
| Slither analysis, manual review, retest log          | done — 29 results, none above informational in project code                   | [`audit/security-report.md`](audit/security-report.md) |
| Sepolia deployment + Etherscan verification          | done — both contracts verified, runtime bytecode identical to the local build | §8, [`deployments/`](deployments/)                     |
| Final report                                         | done — 31 pages, seven chapters, appendices A–F                               | [`docs/report.pdf`](docs/report.pdf)                   |
| Screenshots of deployment, verification and test run | done                                                                          | `screenshots/`                                         |

Every number above is reproducible from the commands in §5–§7. The deployment table in §8 is  
filled from the JSON record the deploy script writes, not by hand.

## 1. Lifecycle

```
              commitBid                 revealBid                  settle
Created ──────────────────> Bidding ────────────────> Revealing ────────────────> Settled
                               │                         │
                               │ seller delists          │ reveal window ends with
                               │ before any commit       │ no valid bid
                               ▼                         ▼
                           Cancelled                 Cancelled
```

`Bidding → Revealing` is derived from `block.timestamp > commitDeadline`; no transaction is  
needed to advance the phase, so the boundary cannot be censored or fail.

| State           | Meaning                | Allowed calls                                                  |
| --------------- | ---------------------- | -------------------------------------------------------------- |
| `Bidding` (0)   | Commit window open     | `commitBid`, `cancel` (seller, only before the first commit)   |
| `Revealing` (1) | Reveal window open     | `revealBid`, `settle` after the deadline if a valid bid exists |
| `Settled` (2)   | Sold                   | `withdraw`, `forfeit`                                          |
| `Cancelled` (3) | Unsold, token returned | `withdraw`                                                     |

## 2. Repository layout

```
contracts/
  AuctionHouse.sol        the auction house; the only contract that holds value
  mocks/MockNFT.sol       minimal ERC-721 used by tests and the demo (not part of the product)
  mocks/Attackers.sol     two test doubles: a re-entrant receiver and an ETH-rejecting receiver
test/
  AuctionHouse.test.js    38 Hardhat/Chai cases over seven groups
scripts/
  deploy.js               deploys both contracts and writes deployments/deployment-<network>.json
  demo.js                 one full auction on the local chain, printed step by step
docs/
  design.md               design notes: state machine, accounting, alternatives considered
  proposal.pdf            the proposal the implementation is built against
  report.pdf              the final report, seven chapters and appendices A–F
deployments/
  deployment-sepolia.json the deployment record the §8 table is filled from
audit/
  security-report.md      Slither triage, manual checklist, residual risks, retest log
  slither-raw.txt         raw analyser output, reproducible
screenshots/
  deployment.png  verification.png  tx.png  testing.png  demo.png
.github/workflows/ci.yml  compile and run the suite on every push
```

In the submission package the guideline's folder names are used instead: `tests/` and  
`deployment/`, the record is named `deployment-record.json`, and the report sits at the root as  
`report.pdf`. The packaged `hardhat.config.js` points `paths.tests` at `./tests` so the suite runs  
there without renaming files; the contents of every file are identical to this repository.

## 3. Requirements

- Node.js 18 or newer (developed on Node 22)
- npm 9 or newer
- No global Hardhat and no global Solidity compiler: both are project dependencies
- For Sepolia only: an RPC endpoint and a throw-away funded testnet account

## 4. Install

```bash
git clone https://github.com/777study777/CSIT5760-blockchain-individual-project.git
cd CSIT5760-blockchain-individual-project
npm ci          # exact versions from package-lock.json
```

`npm ci` needs the lockfile in this repository; `npm install` also works but may resolve  
different transitive versions.

## 5. Compile

```bash
npm run compile
# or: npx hardhat compile
```

Pinned toolchain: Solidity **0.8.24**, optimizer **enabled, 200 runs**, EVM target **cancun**,  
Hardhat **2.29.1**. Deployment bytecode is 6,570 bytes (limit 24,576).

## 6. Test

```bash
npm test               # 38 passing
npm run coverage       # solidity-coverage report
npm run gas            # same tests with hardhat-gas-reporter
```

Current result: **38 passing (≈0.5 s)**, statement / line / function coverage **100 %**,  
branch coverage **81.4 %** (`AuctionHouse.sol`).

| Group                    | Cases | What it pins down                                                                                                                                                                                                                                |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Creating an auction      | 4     | NFT escrowed, both deadlines emitted, non-holder and zero-duration rejected, unapproved transfer reverts                                                                                                                                         |
| Commit phase             | 7     | hash + deposit stored, `BidCommitted` carries no amount, seller excluded, one commit per account, exact deadline accepted and deadline + 1 s rejected, phase moves by timestamp alone                                                            |
| Reveal phase             | 7     | reveal only after the commit deadline, wrong amount/nonce and a copied hash revert with `BadCommitment`, bid above deposit rejected, zero bid and second reveal rejected, reveal-deadline boundary, below-reserve reveal recorded but cannot win |
| Settling                 | 6     | early settle, settle with no winner, token and price moved atomically, permissionless settle, double settle, winner without `onERC721Received` cannot block settlement                                                                           |
| Withdrawals and forfeits | 7     | seller proceeds, winner surplus, loser refund, double withdrawal, non-revealer blocked then forfeited to the seller, withdrawal attempts before finality, re-entrant and ETH-rejecting receivers confined                                        |
| Cancellation             | 4     | seller delist before first commit, stranger delist rejected, empty auction returns token and refunds, settled auction cannot be cancelled                                                                                                        |
| Invariants and privacy   | 3     | `balance == totalEscrowed` through every phase, no plaintext amount in commit-phase logs, commitments bound to bidder and auction                                                                                                                |

Every negative case asserts a specific custom error, not just "it reverts".

## 7. Deploy

```bash
cp .env.example .env      # then fill SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY
npm run deploy:sepolia
```

The script deploys `MockNFT` and `AuctionHouse`, prints both addresses, and writes  
`deployments/deployment-sepolia.json` with the full deployment record: network, chain ID,  
deployer, timestamp, the git commit the build came from, compiler and optimizer settings, and  
for each contract its address, transaction hash and block number. Local runs write a separate  
file that is git-ignored.

Verification must reuse the same compiler and optimizer settings, which is why they are pinned  
in `hardhat.config.js` rather than passed on the command line:

```bash
npx hardhat verify --network sepolia <AuctionHouse address>
npx hardhat verify --network sepolia <MockNFT address>
```

## 8. Deployment record

| Item                           | Value                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Network / chain ID             | Sepolia / 11155111                                                                                                              |
| AuctionHouse address           | [`0xE798321320bf13801C1F4301b3F2CDD81F531b43`](https://sepolia.etherscan.io/address/0xE798321320bf13801C1F4301b3F2CDD81F531b43) |
| MockNFT address                | [`0xfb40fF5c177C7d6eD4Ee823e0C1dF92e171cE007`](https://sepolia.etherscan.io/address/0xfb40fF5c177C7d6eD4Ee823e0C1dF92e171cE007) |
| Deployer                       | [`0xEcC27F84CDeD713e8eebe9320Fe8aDeFB2dCa5bE`](https://sepolia.etherscan.io/address/0xEcC27F84CDeD713e8eebe9320Fe8aDeFB2dCa5bE) |
| Tx hash + block (AuctionHouse) | `0xb80b57725b67963bd3c51e3b31615106324c79c0408a4f571a10dd8cdb0b115b` / 12209032                                                 |
| Tx hash + block (MockNFT)      | `0xcbf1695bb6141ea6601daa9dc6842a2af1246608dc3fbbf95d598384862d13e8` / 12209031                                                 |
| Deployed at                    | 2026-11-25 18:42 HKT, source commit `2b5a12c`                                                                                   |
| Compiler / optimizer / EVM     | 0.8.24 / enabled, 200 runs / cancun                                                                                             |
| Deploy tool                    | Hardhat 2.29.1                                                                                                                  |
| Etherscan (AuctionHouse)       | [verified](https://sepolia.etherscan.io/address/0xE798321320bf13801C1F4301b3F2CDD81F531b43#code)                                |
| Etherscan (MockNFT)            | [verified](https://sepolia.etherscan.io/address/0xfb40fF5c177C7d6eD4Ee823e0C1dF92e171cE007#code)                                |

Machine-readable copy: [`deployments/deployment-sepolia.json`](deployments/deployment-sepolia.json).

## 9. External code and exact versions

| Dependency                         | Version              | Used for                                                                 | Reused or written here |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------ | ---------------------- |
| `@openzeppelin/contracts`          | 5.1.0                | `IERC721`, `ReentrancyGuard`, `ERC721` (in the test NFT only)            | imported, not modified |
| `hardhat`                          | 2.29.1               | compile, local chain, scripts                                            | tooling                |
| `@nomicfoundation/hardhat-toolbox` | 5.0.0                | Chai matchers, network helpers, coverage, gas reporter, Etherscan plugin | tooling                |
| `ethers`                           | 6.17.0 (via toolbox) | scripts and tests                                                        | tooling                |
| `dotenv`                           | 16.4.5               | reading `.env` in `hardhat.config.js`                                    | tooling                |


All auction logic — commitments, deposits, phase transitions, accounting, forfeits — is written  
for this project. `ReentrancyGuard` is the only inherited contract in `AuctionHouse`; the  
`nonReentrant` modifier is the second line of defence, not the first (see §12).

## 10. Roles and account assumptions

- **Seller** — must own the token ids it lists and approve the contract first. May not bid on  
  its own auction. May delist only while no commitment exists.
- **Bidder** — any account except the seller. One commitment per auction per address; the  
  nonce is generated off-chain and never stored on-chain.
- **Settler** — anyone. Both `settle` and `forfeit` are permissionless so a disappeared seller  
  or bidder cannot strand funds.
- **No administrator.** There is no owner, no fee recipient, no pause and no proxy. The only  
  privileged action in the system is the seller's pre-commit delist.
- Assumed: block timestamps increase monotonically; nonces are 32 bytes of entropy; bidders  
  keep their nonce (losing it means losing the deposit to the seller).

## 11. Interacting with the contract

Fastest path, no wallet needed — runs a whole auction on the in-process chain:

```bash
npm run demo
```

Step by step with a wallet (Remix or `hardhat console`):

1. Mint or own an ERC-721, then `approve(<AuctionHouse>, tokenId)`.
2. `createAuction(nft, tokenId, reservePrice, commitDuration, revealDuration)` — the token moves  
   into the contract and the auction id is `auctionCount()`.
3. Build the commitment **off-chain** and keep `nonce` and `amount` secret:
   ```js
   const commitment = ethers.keccak256(
     ethers.AbiCoder.defaultAbiCoder().encode(
       ["uint256", "bytes32", "address", "uint256", "address"],
       [amount, nonce, bidder, auctionId, auctionAddress]
     )
   );
   ```
   `hashCommitment(auctionId, bidder, amount, nonce)` returns the same value if you prefer to  
   ask the contract. Then `commitBid(auctionId, commitment)` with `msg.value >= amount`.
4. After the commit deadline: `revealBid(auctionId, amount, nonce)`.
5. After the reveal deadline: `settle(auctionId)` (anyone). With no valid bid, `cancel`.
6. `withdraw(auctionId)` for the seller, the winner's surplus and every revealed loser.  
   A bidder that never revealed is paid nothing; anyone can call `forfeit(auctionId, bidder)`  
   to move that deposit to the seller.

## 12. Design decisions worth defending

1. **`transferFrom`, not `safeTransferFrom`, when paying out the token.** `safeTransferFrom`  
   calls `onERC721Received` on the winner; a winner contract without that hook could revert  
   forever and block settlement. Using `transferFrom` makes a hostile winner unable to DoS the  
   auction, at the cost of not checking that the receiver can handle NFTs. Settlement is  
   unconditional, which is the property that matters here.
2. **Lazy forfeits instead of a loop over bidders.** `settle` never iterates: any number of  
   ghost bidders cannot make settlement run out of gas. `forfeit(auctionId, bidder)` moves one  
   forfeited deposit at a time and can be called by anyone.
3. **One accounting ledger (`deposits`) plus a single ETH exit (`withdraw`).** No ETH leaves  
   during `settle`, `cancel` or `forfeit`, so the reentrancy surface is one function; `withdraw`  
   zeroes the balance before the call and is also `nonReentrant`.
4. **Deposit ≥ bid, surplus refunded.** A deposit equal to the bid would publish the bid and  
   make the hash pointless; a fixed deposit would let a winner promise more than it escrowed.  
   The chosen compromise leaks only an upper bound — a residual leak that is documented rather  
   than hidden (see §13).

## 13. Security considerations and known limitations

| Risk                        | Control                                                                                         | Evidence                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Reentrancy on payout        | credit zeroed before the external call (CEI) + `nonReentrant`; no ETH leaves elsewhere          | `survives a reentrant receiver`, `confines a rejecting receiver's failure to itself`                     |
| Front-running / bid sniping | commit-reveal; the hash binds amount, nonce, `msg.sender`, `auctionId` and the contract address | `rejects a commitment copied from another bidder`, `binds each commitment to the bidder and the auction` |
| Duplicate execution         | state written before transfers; one-shot transitions                                            | `cannot be executed twice`, `blocks a double withdrawal`, `refuses to cancel a settled auction`          |
| DoS by ghost bids           | settlement never iterates; forfeits are per address and permissionless                          | `refuses a withdrawal by a non-revealer; forfeit moves the deposit to the seller`                        |
| Timestamp boundaries        | one comparison style (`block.timestamp > deadline`) everywhere                                  | `accepts a commitment at exactly the deadline…`, reveal-deadline case                                    |
| Unauthorised access         | `msg.sender` checks only, no `tx.origin`, no roles                                              | `rejects a caller who does not own the token`, `rejects the seller as a bidder`                          |
| Integer overflow            | Solidity 0.8 checked arithmetic; no `unchecked` block                                           | —                                                                                                        |
| Bid privacy                 | `BidCommitted` carries the bidder only; the amount lives in calldata of `revealBid`             | `leaks no plaintext bid amount during the commit phase`                                                  |

Known limitations, stated rather than papered over:

1. **The deposit leaks an upper bound.** `msg.value` is public, so an observer learns  
   `bid <= deposit`. Randomising the surplus reduces the signal; a fixed-deposit variant is  
   future work.
2. **A 1-wei commitment can delay a delisting.** Once any commitment exists the seller cannot  
   cancel, so a griefer can hold the token for `commitDuration + revealDuration`. The deposit is  
   refunded in the `Cancelled` path, so the attack costs the seller time, not money. Time-boxing  
   the windows is the mitigation.
3. **Forced ETH breaks the strict equality** `balance == totalEscrowed` (self-destruct or  
   block-reward transfers). Solvency — `balance >= totalEscrowed` — still holds, and the  
   contract never pays out more than it booked.
4. **A reveal is not confidential forever.** Everything revealed is public and permanent; the  
   scheme hides bids until the reveal window, not afterwards.
5. **Out of scope:** proxies/upgrades, ERC-20 payment, allow-lists or KYC, other auction  
   formats, on-chain randomness, a web front-end, cross-chain settlement.

## 14. Delivered evidence

| Step            | Artefact                                                                            | Where                                                                            |
| --------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Static analysis | Slither 0.11.6, 102 detectors, 21 contracts, 29 results                             | [`audit/slither-raw.txt`](audit/slither-raw.txt)                                 |
| Interpretation  | severity, affected code, control and retest id for every result                     | [`audit/security-report.md`](audit/security-report.md), §13                      |
| Deployment      | Sepolia addresses, tx hashes, block numbers, git commit                             | §8, [`deployments/deployment-sepolia.json`](deployments/deployment-sepolia.json) |
| Verification    | both contracts published on Etherscan; runtime bytecode compared to the local build | §8, [`screenshots/verification.png`](screenshots/verification.png)               |
| Documentation   | report, screenshots, submission package                                             | [`docs/report.pdf`](docs/report.pdf), `screenshots/`                             |

No remediation patch was required. No result in project code is a defect: the uninitialised local  
is a false positive, the timestamp comparisons are the product requirement, the single low-level  
call is a guarded pull payment, and the remaining twenty results sit inside OpenZeppelin.  
"Remediation" therefore takes the form of a regression test that pins each claim, recorded in the  
retest log rather than a code change.

## 15. AI-assisted work

An AI assistant was used to discuss design trade-offs, to review drafts of the proposal and  
this README, and to draft the contract, the test suite, the deployment scripts and the  
documentation from the author's specification, which the author then reviewed and corrected. All  
contract logic, tests and design decisions were reviewed and are understood by the author; the course policy on AI assistance applies.

## License

MIT — see [`LICENSE`](LICENSE).
