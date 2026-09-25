import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorCoreStaking } from "../target/types/anchor_core_staking";
import { SystemProgram } from "@solana/web3.js";
import { MPL_CORE_PROGRAM_ID } from "@metaplex-foundation/mpl-core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

const MILLISECONDS_PER_DAY = 86400000;
const REWARDS_BPS = 10000;
const FREEZE_PERIOD_IN_DAYS = 7;
const TIME_TRAVEL_IN_DAYS = 8;

describe("anchor-core-staking", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .anchorCoreStaking as Program<AnchorCoreStaking>;

  // Generate a keypair for the collection
  const collectionKeypair = anchor.web3.Keypair.generate();

  // Find the update authority for the collection (PDA)
  const updateAuthority = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("update_authority"), collectionKeypair.publicKey.toBuffer()],
    program.programId,
  )[0];

  // Generate a keypair for the nft asset
  const nftKeypair = anchor.web3.Keypair.generate();

  // Find the config account (PDA)
  const config = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config"), collectionKeypair.publicKey.toBuffer()],
    program.programId,
  )[0];

  // Find the rewards mint account (PDA)
  const rewardsMint = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("rewards_mint"), config.toBuffer()],
    program.programId,
  )[0];

  // Surfpool chain time persists across test runs and getBlockTime can trail
  // the execution Clock, so wall-clock / block-time seeding drifts.
  // Instead: read the Clock sysvar (same clock the program uses) right after
  // stake, and set absolute travel targets relative to it.
  const CLOCK_SYSVAR = new anchor.web3.PublicKey(
    "SysvarC1ock11111111111111111111111111111111",
  );
  let timeBaseMs: number | null = null;
  let traveledDays = 0;
  let travelCount = 0;

  async function readClockMs(): Promise<number> {
    const acc = await provider.connection.getAccountInfo(
      CLOCK_SYSVAR,
      "confirmed",
    );
    if (!acc) throw new Error("Clock sysvar not found");
    // Clock layout: slot u64, epoch_start_timestamp i64, epoch u64,
    // leader_schedule_epoch u64, unix_timestamp i64 @ offset 32
    const ts = Number(acc.data.readBigInt64LE(32));
    return ts * 1000;
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function refreshBlockhash(tries = 3): Promise<void> {
    for (let i = 0; i < tries; i++) {
      try {
        await provider.connection.getLatestBlockhash("confirmed");
        return;
      } catch {
        await sleep(1000);
      }
    }
  }

  // Retry wrapper: timeTravel invalidates the blockhash queue, so the next
  // tx often fails with "Blockhash not found". Retry with a fresh blockhash.
  // Program errors (AnchorError) are rethrown immediately, not retried.
  async function sendWithRetry(
    fn: () => Promise<string>,
    label: string,
    maxTries = 5,
  ): Promise<string> {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof anchor.AnchorError) throw err;
        const msg = String((err as any)?.message ?? err);
        const retryable =
          msg.includes("Blockhash not found") ||
          msg.includes("blockhash") ||
          msg.includes("simulation failed") ||
          msg.includes("was not confirmed") ||
          msg.includes("Transaction retry");
        if (!retryable || attempt === maxTries) throw err;
        console.log(
          `\n[${label}] retryable RPC error (attempt ${attempt}/${maxTries}): ${msg.slice(
            0,
            200,
          )}`,
        );
        await refreshBlockhash();
        await sleep(1500);
      }
    }
    throw new Error(`[${label}] exhausted retries`);
  }

  // Helper function to advance time with Surfpool
  // NOTE: +120s buffer per jump. Chain Clock keeps ticking in real seconds
  // between our travel and the claim tx, so an exact N*86400ms jump lands a
  // few seconds short and integer division floors to N-1 days.
  async function advanceTimeByDays(days: number): Promise<void> {
    if (timeBaseMs === null) timeBaseMs = await readClockMs();
    traveledDays += days;
    travelCount += 1;
    // Per-jump +120s buffer: consecutive targets would otherwise differ by
    // exactly N*86400ms, and seconds of tx-timing jitter floor the payout
    // to N-1 days. Each jump carries its own buffer so every leg has slack.
    const target =
      timeBaseMs + traveledDays * MILLISECONDS_PER_DAY + travelCount * 120000;
    const rpcResponse = await fetch(provider.connection.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_timeTravel",
        params: [{ absoluteTimestamp: target }],
      }),
    });

    const result = (await rpcResponse.json()) as { error?: any; result?: any };
    if (result.error) {
      throw new Error(`Time travel failed: ${JSON.stringify(result.error)}`);
    }

    // Give surfnet time to cut new blocks, then warm a fresh blockhash
    await sleep(3000);
    await refreshBlockhash(5);
    await sleep(1000);
  }

  async function getRewardsBalance(): Promise<number> {
    const userRewardsAta = getAssociatedTokenAddressSync(
      rewardsMint,
      provider.wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    try {
      const bal = await provider.connection.getTokenAccountBalance(
        userRewardsAta,
      );
      return bal.value.uiAmount ?? 0;
    } catch {
      return 0;
    }
  }

  function claimAccounts() {
    const userRewardsAta = getAssociatedTokenAddressSync(
      rewardsMint,
      provider.wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    return {
      owner: provider.wallet.publicKey,
      updateAuthority,
      config,
      rewardsMint,
      userRewardsAta,
      asset: nftKeypair.publicKey,
      collection: collectionKeypair.publicKey,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    };
  }

  it("Create a collection", async () => {
    const collectionName = "Test Collection";
    const collectionUri = "https://example.com/collection";
    const tx = await sendWithRetry(
      () =>
        program.methods
          .createCollection(collectionName, collectionUri)
          .accountsPartial({
            payer: provider.wallet.publicKey,
            collection: collectionKeypair.publicKey,
            updateAuthority,
            systemProgram: SystemProgram.programId,
            mplCoreProgram: MPL_CORE_PROGRAM_ID,
          })
          .signers([collectionKeypair])
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "create-collection",
    );
    console.log("\nYour transaction signature", tx);
    console.log("Collection address", collectionKeypair.publicKey.toBase58());
  });

  it("Mint an NFT", async () => {
    const nftName = "Test NFT";
    const nftUri = "https://example.com/nft";
    const tx = await sendWithRetry(
      () =>
        program.methods
          .mintAsset(nftName, nftUri)
          .accountsPartial({
            user: provider.wallet.publicKey,
            asset: nftKeypair.publicKey,
            collection: collectionKeypair.publicKey,
            updateAuthority,
            systemProgram: SystemProgram.programId,
            mplCoreProgram: MPL_CORE_PROGRAM_ID,
          })
          .signers([nftKeypair])
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "mint-asset",
    );
    console.log("\nYour transaction signature", tx);
    console.log("NFT address", nftKeypair.publicKey.toBase58());
  });

  it("Initialize Config", async () => {
    const tx = await sendWithRetry(
      () =>
        program.methods
          .initialize(REWARDS_BPS, FREEZE_PERIOD_IN_DAYS)
          .accountsPartial({
            admin: provider.wallet.publicKey,
            collection: collectionKeypair.publicKey,
            updateAuthority,
            config,
            rewardsMint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "initialize",
    );
    console.log("\nYour transaction signature", tx);
    console.log("Config address", config.toBase58());
    console.log("Rewards BPS", REWARDS_BPS);
    console.log("Freeze period in days", FREEZE_PERIOD_IN_DAYS);
    console.log("Rewards mint address", rewardsMint.toBase58());
  });

  it("Stake an NFT", async () => {
    const tx = await sendWithRetry(
      () =>
        program.methods
          .stake()
          .accountsPartial({
            owner: provider.wallet.publicKey,
            updateAuthority,
            config,
            asset: nftKeypair.publicKey,
            collection: collectionKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            mplCoreProgram: MPL_CORE_PROGRAM_ID,
          })
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "stake",
    );
    console.log("\nYour transaction signature", tx);
    // Seed travel targets from on-chain Clock right after stake
    timeBaseMs = await readClockMs();
    traveledDays = 0;
    travelCount = 0;
  });

  it("Try to claim immediately after stake (no rewards yet)", async () => {
    try {
      const tx = await sendWithRetry(
        () =>
          program.methods
            .claimRewards()
            .accountsPartial(claimAccounts())
            .rpc({ commitment: "confirmed", skipPreflight: false }),
        "claim-immediate",
      );
      throw new Error(
        `Claim should have failed with no elapsed days, but succeeded with tx: ${tx}`,
      );
    } catch (err) {
      if (
        err instanceof anchor.AnchorError &&
        err.error.errorCode.code === "InvalidTimestamp"
      ) {
        console.log("\nClaim failed as expected:", err.error.errorMessage);
      } else {
        throw err;
      }
    }
    expect(await getRewardsBalance()).to.equal(0);
  });

  it("Try to unstake an NFT before the freeze period ends", async () => {
    // Get the user rewards ATA account
    const userRewardsAta = getAssociatedTokenAddressSync(
      rewardsMint,
      provider.wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    try {
      const tx = await sendWithRetry(
        () =>
          program.methods
            .unstake()
            .accountsPartial({
              owner: provider.wallet.publicKey,
              updateAuthority,
              config,
              rewardsMint,
              userRewardsAta,
              asset: nftKeypair.publicKey,
              collection: collectionKeypair.publicKey,
              mplCoreProgram: MPL_CORE_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .rpc({ commitment: "confirmed", skipPreflight: false }),
        "unstake-early",
      );
      throw new Error(
        `Unstake should have failed before freeze period elapsed, but succeeded with tx: ${tx}`,
      );
    } catch (err) {
      if (
        err instanceof anchor.AnchorError &&
        err.error.errorCode.code === "FreezePeriodNotElapsed"
      ) {
        console.log("\nUnstake failed as expected:", err.error.errorMessage);
      } else {
        throw err;
      }
    }
  });

  it("Try to burn an NFT before the freeze period ends", async () => {
    // Get the user rewards ATA account
    const userRewardsAta = getAssociatedTokenAddressSync(
      rewardsMint,
      provider.wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    try {
      const tx = await sendWithRetry(
        () =>
          program.methods
            .burnStakedNft()
            .accountsPartial({
              owner: provider.wallet.publicKey,
              updateAuthority,
              config,
              rewardsMint,
              userRewardsAta,
              asset: nftKeypair.publicKey,
              collection: collectionKeypair.publicKey,
              mplCoreProgram: MPL_CORE_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .rpc({ commitment: "confirmed", skipPreflight: false }),
        "burn-early",
      );
      throw new Error(
        `Burn should have failed before freeze period elapsed, but succeeded with tx: ${tx}`,
      );
    } catch (err) {
      if (
        err instanceof anchor.AnchorError &&
        err.error.errorCode.code === "FreezePeriodNotElapsed"
      ) {
        console.log("Burn failed as expected:", err.error.errorMessage);
      } else {
        throw err;
      }
    }
  });

  it("Time travel to the future", async () => {
    await advanceTimeByDays(TIME_TRAVEL_IN_DAYS);
    console.log("\nTime traveled in days", TIME_TRAVEL_IN_DAYS);
  });

  it("Claim rewards while still staked", async () => {
    const tx = await sendWithRetry(
      () =>
        program.methods
          .claimRewards()
          .accountsPartial(claimAccounts())
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "claim-1",
    );
    console.log("\nYour transaction signature", tx);
    const balance = await getRewardsBalance();
    console.log("User rewards balance after 1st claim", balance);
    // 8 days * 10000 bps (100%) = 8 tokens
    expect(balance).to.equal(TIME_TRAVEL_IN_DAYS);
  });

  it("Try to claim twice in the same period (no double rewards)", async () => {
    try {
      const tx = await sendWithRetry(
        () =>
          program.methods
            .claimRewards()
            .accountsPartial(claimAccounts())
            .rpc({ commitment: "confirmed", skipPreflight: false }),
        "claim-double",
      );
      throw new Error(
        `Second claim should have failed with no elapsed days, but succeeded with tx: ${tx}`,
      );
    } catch (err) {
      if (
        err instanceof anchor.AnchorError &&
        err.error.errorCode.code === "InvalidTimestamp"
      ) {
        console.log(
          "\nSecond claim failed as expected:",
          err.error.errorMessage,
        );
      } else {
        throw err;
      }
    }
    expect(await getRewardsBalance()).to.equal(TIME_TRAVEL_IN_DAYS);
  });

  it("Time travel 2 more days and claim again (only new days paid)", async () => {
    await advanceTimeByDays(2);
    const tx = await sendWithRetry(
      () =>
        program.methods
          .claimRewards()
          .accountsPartial(claimAccounts())
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "claim-2",
    );
    console.log("\nYour transaction signature", tx);
    const balance = await getRewardsBalance();
    console.log("User rewards balance after 2nd claim", balance);
    // 8 + 2 = 10, proves cursor advanced and no double-count
    expect(balance).to.equal(TIME_TRAVEL_IN_DAYS + 2);
  });

  it("Time travel 2 more days and unstake (only remainder paid)", async () => {
    await advanceTimeByDays(2);
    const userRewardsAta = getAssociatedTokenAddressSync(
      rewardsMint,
      provider.wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const tx = await sendWithRetry(
      () =>
        program.methods
          .unstake()
          .accountsPartial({
            owner: provider.wallet.publicKey,
            updateAuthority,
            config,
            rewardsMint,
            userRewardsAta,
            asset: nftKeypair.publicKey,
            collection: collectionKeypair.publicKey,
            mplCoreProgram: MPL_CORE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "unstake-final",
    );
    console.log("\nYour transaction signature", tx);
    const balance = await getRewardsBalance();
    console.log("User rewards balance after unstake", balance);
    // 8 + 2 + 2 = 12 total days staked, no double rewards
    expect(balance).to.equal(TIME_TRAVEL_IN_DAYS + 4);
  });

  it("Restake after unstake works (freeze plugin update path)", async () => {
    const tx = await sendWithRetry(
      () =>
        program.methods
          .stake()
          .accountsPartial({
            owner: provider.wallet.publicKey,
            updateAuthority,
            config,
            asset: nftKeypair.publicKey,
            collection: collectionKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            mplCoreProgram: MPL_CORE_PROGRAM_ID,
          })
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "restake",
    );
    console.log("\nRestake transaction signature", tx);
  });

  it("Burn staked NFT for 3x bonus after freeze", async () => {
    // Restake reset staked_at, so travel 8 more days past the new freeze start
    await advanceTimeByDays(8);
    const before = await getRewardsBalance();
    const userRewardsAta = getAssociatedTokenAddressSync(
      rewardsMint,
      provider.wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const tx = await sendWithRetry(
      () =>
        program.methods
          .burnStakedNft()
          .accountsPartial({
            owner: provider.wallet.publicKey,
            updateAuthority,
            config,
            rewardsMint,
            userRewardsAta,
            asset: nftKeypair.publicKey,
            collection: collectionKeypair.publicKey,
            mplCoreProgram: MPL_CORE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .rpc({ commitment: "confirmed", skipPreflight: false }),
      "burn-final",
    );
    console.log("\nBurn transaction signature", tx);
    const balance = await getRewardsBalance();
    console.log("User rewards balance after burn", balance);
    // 8 days since restake * 3x bonus = +24
    expect(balance).to.equal(before + 24);
    // Burn truncates the asset to a 1-byte Uninitialized tombstone (rent stays locked)
    const burned = await provider.connection.getAccountInfo(
      nftKeypair.publicKey,
      "confirmed",
    );
    expect(burned, "burned asset account should still exist").to.not.be.null;
    expect(burned!.data.length).to.equal(1);
    expect(burned!.data[0]).to.equal(0);
  });
});
