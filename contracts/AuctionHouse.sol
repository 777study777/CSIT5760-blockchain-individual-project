// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AuctionHouse
 * @notice A sealed-bid auction house for a single ERC-721 token per auction.
 *
 * Lifecycle
 *   Bidding   --commit hash + deposit-->  Revealing  --reveal amount-->  Settled
 *                                              \---- no valid bid ---->  Cancelled
 *
 * Design rules that the tests and the audit rely on:
 *   1. No owner, no pause, no upgrade path. Authorisation is limited to "the seller
 *      may delist before the first commitment"; every other transition is guarded by
 *      state and time only, so settlement cannot be blocked by a privileged key.
 *   2. Commitments bind msg.sender, the auction id and this contract address. A hash
 *      copied from another bidder is worthless.
 *   3. All ETH is accounted in `deposits` before any external call. The only outgoing
 *      ETH call is in `withdraw`, which zeroes the balance first (checks-effects-
 *      interactions) and is additionally guarded by `nonReentrant`.
 *   4. Tokens move with `transferFrom`, never `safeTransferFrom`: a winner that is a
 *      contract without `onERC721Received` must not be able to block settlement.
 */
contract AuctionHouse is ReentrancyGuard {
    /* ------------------------------------------------------------------ types */

    enum State {
        Bidding,
        Revealing,
        Settled,
        Cancelled
    }

    struct Auction {
        address seller;
        address nft;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint256 tokenId;
        uint256 reservePrice;
        address highestBidder;
        uint256 highestBid;
        uint32 commitCount;
        State state;
    }

    /* ---------------------------------------------------------------- storage */

    /// @notice Number of auctions created so far. Auction ids start at 1.
    uint256 public auctionCount;

    /// @notice ETH owed to bidders and sellers across all auctions.
    /// @dev Invariant checked in tests: address(this).balance == totalEscrowed.
    uint256 public totalEscrowed;

    mapping(uint256 => Auction) private _auctions;

    /// @notice Commitment hash per auction and bidder. Zero means "not committed".
    mapping(uint256 => mapping(address => bytes32)) public commitments;

    /// @notice ETH held per auction and account. Doubles as the payout ledger.
    mapping(uint256 => mapping(address => uint256)) public deposits;

    /// @notice Whether an account revealed its bid for an auction.
    mapping(uint256 => mapping(address => bool)) public revealed;

    /* ----------------------------------------------------------------- events */

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint256 reservePrice,
        uint64 commitDeadline,
        uint64 revealDeadline
    );
    event BidCommitted(uint256 indexed auctionId, address indexed bidder);
    event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 amount);
    event AuctionCancelled(uint256 indexed auctionId);
    event ForfeitClaimed(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event CreditWithdrawn(uint256 indexed auctionId, address indexed account, uint256 amount);

    /* ----------------------------------------------------------------- errors */

    error UnknownAuction();
    error NotTokenOwner();
    error InvalidDuration();
    error SellerCannotBid();
    error ZeroDeposit();
    error EmptyCommitment();
    error AlreadyCommitted();
    error CommitPhaseClosed();
    error RevealPhaseNotOpen();
    error RevealPhaseClosed();
    error NotCommitted();
    error AlreadyRevealed();
    error ZeroBid();
    error BidAboveDeposit();
    error BadCommitment();
    error SettlementTooEarly();
    error NoWinner();
    error CannotCancel();
    error InvalidState();
    error NothingToWithdraw();
    error EtherTransferFailed();

    /* -------------------------------------------------------------- modifiers */

    modifier existing(uint256 auctionId) {
        if (auctionId == 0 || auctionId > auctionCount) revert UnknownAuction();
        _;
    }

    /* ---------------------------------------------------------------- create */

    /**
     * @notice Escrow one ERC-721 and open a sealed-bid auction.
     * @param nft            ERC-721 contract; the caller must own `tokenId` and approve this contract.
     * @param tokenId        Token to sell.
     * @param reservePrice   Minimum acceptable bid. Bids below it may be revealed but never win.
     * @param commitDuration Seconds the commit phase stays open (must be > 0).
     * @param revealDuration Seconds the reveal phase stays open after the commit deadline (must be > 0).
     */
    function createAuction(
        address nft,
        uint256 tokenId,
        uint256 reservePrice,
        uint64 commitDuration,
        uint64 revealDuration
    ) external nonReentrant returns (uint256 auctionId) {
        if (commitDuration == 0 || revealDuration == 0) revert InvalidDuration();
        if (IERC721(nft).ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        auctionId = ++auctionCount;
        uint64 commitDeadline = uint64(block.timestamp) + commitDuration;
        uint64 revealDeadline = commitDeadline + revealDuration;

        _auctions[auctionId] = Auction({
            seller: msg.sender,
            nft: nft,
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            tokenId: tokenId,
            reservePrice: reservePrice,
            highestBidder: address(0),
            highestBid: 0,
            commitCount: 0,
            state: State.Bidding
        });

        // transferFrom, not safeTransferFrom: this contract does not implement the
        // receiver hook, so an unsolicited safeTransferFrom to it reverts and no NFT
        // can be stranded here without an auction record.
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);

        emit AuctionCreated(
            auctionId,
            msg.sender,
            nft,
            tokenId,
            reservePrice,
            commitDeadline,
            revealDeadline
        );
    }

    /* ---------------------------------------------------------------- bidding */

    /**
     * @notice Commit to a hidden bid. The deposit is public; the amount is not.
     * @param auctionId  Auction to bid on.
     * @param commitment keccak256(abi.encode(amount, nonce, msg.sender, auctionId, address(this))).
     * @dev The deposit must be at least the eventual bid; the surplus is refunded on withdraw.
     */
    function commitBid(uint256 auctionId, bytes32 commitment)
        external
        payable
        nonReentrant
        existing(auctionId)
    {
        Auction storage a = _auctions[auctionId];
        _sync(auctionId);

        if (a.state != State.Bidding || block.timestamp > a.commitDeadline) revert CommitPhaseClosed();
        if (msg.sender == a.seller) revert SellerCannotBid();
        if (msg.value == 0) revert ZeroDeposit();
        if (commitment == bytes32(0)) revert EmptyCommitment();
        if (commitments[auctionId][msg.sender] != bytes32(0)) revert AlreadyCommitted();

        commitments[auctionId][msg.sender] = commitment;
        deposits[auctionId][msg.sender] = msg.value;
        a.commitCount += 1;
        totalEscrowed += msg.value;

        // Deliberately no amount and no commitment in the event: the deposit is already
        // public in the transaction, and echoing the hash adds nothing but log noise.
        emit BidCommitted(auctionId, msg.sender);
    }

    /**
     * @notice Reveal a committed bid during the reveal phase.
     * @param amount Bid amount in wei; must not exceed the deposit.
     * @param nonce  32-byte secret chosen at commit time.
     */
    function revealBid(uint256 auctionId, uint256 amount, bytes32 nonce)
        external
        nonReentrant
        existing(auctionId)
    {
        Auction storage a = _auctions[auctionId];
        _sync(auctionId);

        if (a.state != State.Revealing) revert RevealPhaseNotOpen();
        if (block.timestamp > a.revealDeadline) revert RevealPhaseClosed();
        if (revealed[auctionId][msg.sender]) revert AlreadyRevealed();
        if (commitments[auctionId][msg.sender] == bytes32(0)) revert NotCommitted();
        if (amount == 0) revert ZeroBid();
        if (amount > deposits[auctionId][msg.sender]) revert BidAboveDeposit();

        bytes32 expected = keccak256(
            abi.encode(amount, nonce, msg.sender, auctionId, address(this))
        );
        if (expected != commitments[auctionId][msg.sender]) revert BadCommitment();

        revealed[auctionId][msg.sender] = true;

        // A bid below the reserve is a valid reveal but can never win, so the bidder
        // keeps the full deposit instead of losing it for an honest mistake.
        if (amount >= a.reservePrice && amount > a.highestBid) {
            a.highestBid = amount;
            a.highestBidder = msg.sender;
        }

        emit BidRevealed(auctionId, msg.sender, amount);
    }

    /* -------------------------------------------------------------- settling */

    /**
     * @notice Finalise an auction that has at least one valid bid. Callable by anyone.
     * @dev Books the winning amount to the seller and moves the token. The winner's
     *      surplus stays in `deposits` for a later withdraw.
     */
    function settle(uint256 auctionId) external nonReentrant existing(auctionId) {
        Auction storage a = _auctions[auctionId];
        _sync(auctionId);

        if (a.state != State.Revealing) revert InvalidState();
        if (block.timestamp <= a.revealDeadline) revert SettlementTooEarly();
        if (a.highestBidder == address(0)) revert NoWinner();

        address winner = a.highestBidder;
        uint256 amount = a.highestBid;

        // Effects first: the auction is closed and the money is booked before any
        // external call, so a reentrant settle finds state == Settled and reverts.
        a.state = State.Settled;
        deposits[auctionId][winner] -= amount;
        deposits[auctionId][a.seller] += amount;

        IERC721(a.nft).transferFrom(address(this), winner, a.tokenId);

        emit AuctionSettled(auctionId, winner, amount);
    }

    /**
     * @notice Cancel an auction and return the token to the seller.
     * @dev Two legal cases only: the seller delists before the first commitment, or the
     *      reveal phase ended with no valid bid.
     */
    function cancel(uint256 auctionId) external nonReentrant existing(auctionId) {
        Auction storage a = _auctions[auctionId];
        if (a.state == State.Settled || a.state == State.Cancelled) revert InvalidState();
        _sync(auctionId);

        bool sellerDelist = msg.sender == a.seller &&
            a.state == State.Bidding &&
            a.commitCount == 0;
        bool noValidBid = a.state == State.Revealing &&
            block.timestamp > a.revealDeadline &&
            a.highestBidder == address(0);

        if (!sellerDelist && !noValidBid) revert CannotCancel();

        a.state = State.Cancelled;
        IERC721(a.nft).transferFrom(address(this), a.seller, a.tokenId);

        emit AuctionCancelled(auctionId);
    }

    /**
     * @notice Claim the ETH owed to the caller for one auction.
     * @dev Legal after Settled (winner surplus, revealed losers, seller proceeds) and
     *      after Cancelled (every deposit). Unrevealed bidders must use `forfeit`.
     */
    function withdraw(uint256 auctionId) external nonReentrant existing(auctionId) {
        Auction storage a = _auctions[auctionId];

        uint256 owed;
        if (a.state == State.Cancelled) {
            owed = deposits[auctionId][msg.sender];
        } else if (a.state == State.Settled) {
            if (msg.sender == a.seller) {
                owed = deposits[auctionId][msg.sender];
            } else if (revealed[auctionId][msg.sender]) {
                // Winner: the winning amount already moved to the seller, so this is
                // the surplus. Revealed loser: the full deposit comes back.
                owed = deposits[auctionId][msg.sender];
            } else {
                revert NothingToWithdraw();
            }
        } else {
            revert InvalidState();
        }

        if (owed == 0) revert NothingToWithdraw();

        deposits[auctionId][msg.sender] = 0;
        totalEscrowed -= owed;

        (bool ok, ) = msg.sender.call{value: owed}("");
        if (!ok) revert EtherTransferFailed();

        emit CreditWithdrawn(auctionId, msg.sender, owed);
    }

    /**
     * @notice Move a non-revealer's forfeited deposit to the seller. Callable by anyone.
     * @dev Settlement never iterates bidders; forfeits are settled lazily, one address at
     *      a time. A ghost bidder cannot block this, and the seller does not have to act.
     */
    function forfeit(uint256 auctionId, address bidder) external nonReentrant existing(auctionId) {
        Auction storage a = _auctions[auctionId];
        if (a.state != State.Settled) revert InvalidState();
        if (revealed[auctionId][bidder]) revert NothingToWithdraw();

        uint256 amount = deposits[auctionId][bidder];
        if (amount == 0) revert NothingToWithdraw();

        deposits[auctionId][bidder] = 0;
        deposits[auctionId][a.seller] += amount;

        emit ForfeitClaimed(auctionId, bidder, amount);
    }

    /* ----------------------------------------------------------------- views */

    /// @notice Full auction record.
    function getAuction(uint256 auctionId)
        external
        view
        existing(auctionId)
        returns (Auction memory)
    {
        return _auctions[auctionId];
    }

    /// @notice Effective phase, including the time-derived Bidding -> Revealing step.
    function phaseOf(uint256 auctionId) public view existing(auctionId) returns (State) {
        Auction storage a = _auctions[auctionId];
        if (a.state == State.Bidding && block.timestamp > a.commitDeadline) {
            return State.Revealing;
        }
        return a.state;
    }

    /// @notice Helper so clients do not have to reimplement the hashing scheme.
    function hashCommitment(uint256 auctionId, address bidder, uint256 amount, bytes32 nonce)
        external
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(amount, nonce, bidder, auctionId, address(this)));
    }

    /* --------------------------------------------------------------- internal */

    /// @dev Moves Bidding to Revealing once the commit deadline has passed. No event:
    ///      the boundary is derived from block time, not from a privileged transaction.
    function _sync(uint256 auctionId) private {
        Auction storage a = _auctions[auctionId];
        if (a.state == State.Bidding && block.timestamp > a.commitDeadline) {
            a.state = State.Revealing;
        }
    }
}
